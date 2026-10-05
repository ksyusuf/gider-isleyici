/**
 * ============================================================================
 * Gider İşleyici — Webhook Giriş Noktası + Dedup + Deploy Yardımcıları
 * ============================================================================
 * Telegram webhook'unun bağlandığı `doPost` giriş noktası, `update_id` bazlı
 * tekrar-teslim koruması (isYeniUpdate_) ve deploy sonrası elle çalıştırılan
 * webhook kurulum/durum/kaldırma yardımcıları burada tutulur. LLM API
 * çağrısı + Katman 1 tekrar deneme `LLM.js`'te, Telegram gönderim + komut
 * işleme `Telegram.js`'te, Katman 2 (saatlik tekrar deneme) `retry/`
 * dizininde yaşar — bu dosya sadece bunları orkestre eden webhook girişidir.
 *
 * İlgili diğer dosyalar:
 *   - Config.js: CONFIG, SHEET_LAYOUT, TOOLS (LLM function declarations)
 *   - Logging.js: log_ / logHata_
 *   - LLM.js: mesajiIsleVeYanitla_ / hataGeciciMi_ / LLM_YOGUN_KULLANICI_MESAJI
 *   - Telegram.js: sendTelegramMessage_ / islemKomut_
 *   - Expenses.js: Sheets erişim yardımcıları + harcamaEkle / sonHarcamalariGetir / sonHarcamalariTopla
 *   - Queue.js: Fitness projesiyle paylaşılan Telegram mesaj kuyruğu (kuyrugaEkle_)
 *   - retry/RetryCore.js: LLM geçici/kalıcı hatalarında Katman 2 — mesaj bazlı, tek
 *     seferlik trigger'larla saatlik tekrar deneme (1-1-2-2-4 saat), pes
 *     etme + toplu bildirim, FIFO temizlik
 *   - retry/RetryCommands.js: `/pesedilenler` ve `/pesdene` komutlarının backend'i
 */

/** İşlenmiş en yüksek update_id'nin saklandığı Script Property anahtarı. */
const SON_UPDATE_ID_KEY = "SON_UPDATE_ID";

/** Oku/karşılaştır/yaz kritik bölümü için kilit bekleme süresi (ms). */
const UPDATE_LOCK_TIMEOUT_MS = 10000;

/**
 * Bu update daha önce işlendi mi? `respondOk_()` düzeltmesinden sonra Telegram
 * teslimatı başarılı saydığı için normal şartlarda hiç tekrar gelmemeli; bu
 * fonksiyon bir SAVUNMA KATMANI olarak duruyor (ağ kesintisi, gerçek timeout,
 * elle yeniden gönderim). Korunmazsa her tekrarda LLM yeniden çağrılır, aynı
 * harcama tabloya birden fazla kez yazılır ve aynı cevap defalarca gider.
 *
 * Anahtar, update'in içeriği değil Telegram'ın her update'e verdiği artan ve
 * benzersiz `update_id`'sidir. Mesaj metnini saklamak yanlış olurdu: kullanıcı
 * aynı metni bilerek iki kez yazarsa ikincisi yutulurdu.
 *
 * `update_id` KESİN OLARAK ARTAN olduğu için her update'e ayrı bir anahtar
 * tutmak gereksiz: işlenmiş en yüksek id'yi saklayıp gelen id'yi onunla
 * karşılaştırmak yeterli. Tek property, O(1), büyümez, temizlik istemez.
 *
 * ⚠️ Neden `CacheService` DEĞİL: önceki sürüm işareti cache'te 600 sn tutuyordu.
 * Telegram başarısız saydığı teslimatı SAATLERCE yeniden dener; işaretin süresi
 * her dolduğunda bir retry içeri sızıp aynı harcamayı tekrar kaydediyordu
 * (~11 dakikada bir). Ayrıca CacheService bir cache'tir — süresi dolmadan da
 * tahliye edilebilir. PropertiesService kalıcıdır, bu deliği tamamen kapatır.
 *
 * ⚠️ Bot token'ı değişirse `update_id` sayacı sıfırlanır; bu durumda Script
 * Properties'ten `SON_UPDATE_ID` ELLE SİLİNMELİ, aksi halde yeni botun tüm
 * mesajları "eski" sayılıp atlanır.
 *
 * İki tasarım kararı kritik:
 *   - İşaret işin BAŞINDA atılır, sonunda değil. Tekrar teslim, ilk execution hâlâ
 *     çalışırken gelebiliyor; sonda işaretlense ikisi de işi yapardı.
 *   - Kilit yalnızca "oku + karşılaştır + yaz" kritik bölümünü sarar
 *     (milisaniyeler), LLM çağrısını DEĞİL — aksi halde tüm istekler seri
 *     hale gelirdi.
 *
 * @param {number|undefined} updateId Telegram update.update_id
 * @return {boolean} true ise bu update ilk kez görülüyor ve işlenmeli.
 */
function isYeniUpdate_(updateId) {
  if (updateId === undefined || updateId === null) {
    // Beklenmedik payload: dedup asla meşru bir mesajı düşürmemeli.
    log_("dedup.id-yok", "update_id gelmedi, update yine de işlenecek.");
    return true;
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(UPDATE_LOCK_TIMEOUT_MS);
  } catch (err) {
    // Kilit alınamadı: başka bir execution aynı anda bu update'i işliyor olabilir.
    // Tekrar üretmektense atlamak doğru.
    logHata_("dedup.kilit-alinamadi:" + updateId, err);
    return false;
  }

  try {
    var props = PropertiesService.getScriptProperties();
    var sonIsaret = Number(props.getProperty(SON_UPDATE_ID_KEY));

    if (isFinite(sonIsaret) && sonIsaret > 0 && updateId <= sonIsaret) {
      log_(
        "dedup.tekrar",
        "Bu update zaten işlenmiş: " + updateId + " <= " + sonIsaret,
      );
      return false;
    }

    props.setProperty(SON_UPDATE_ID_KEY, String(updateId));
    log_("dedup.yeni", "İlk kez görülüyor, işaretlendi: " + updateId);
    return true;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Apps Script Web App POST giriş noktası — Telegram webhook'u buraya bağlanır.
 * @param {GoogleAppsScript.Events.DoPost} e
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function doPost(e) {
  var baslangic = Date.now();
  var chatId = null;
  try {
    if (!e || !e.postData || !e.postData.contents) {
      // Web App URL'i herkese açık (ANYONE_ANONYMOUS). Telegram dışından gelen
      // tarama/probe istekleri JSON.parse hatasına düşüp catch bloğu üzerinden
      // kullanıcıya gereksiz hata mesajı göndermesin diye sessizce yok sayılır.
      log_(
        "doPost.gecersiz-istek",
        "postData yok — Telegram dışı istek, yok sayıldı.",
      );
      return respondOk_();
    }

    log_("doPost.ham-payload", e.postData.contents);
    var update = JSON.parse(e.postData.contents);

    // Tekrar teslim edilen update'ler burada, hiçbir iş yapılmadan elenir.
    if (!isYeniUpdate_(update.update_id)) {
      log_("doPost.cikis", "tekrar-atlandi, update_id=" + update.update_id);
      return respondOk_();
    }

    var message = update.message;

    if (!message) {
      // edited_message, channel_post vb. desteklenmeyen güncelleme tipleri sessizce yok sayılır.
      log_("doPost.cikis", {
        sebep: "message-yok",
        updateAnahtarlari: Object.keys(update),
      });
      return respondOk_();
    }

    chatId = message.chat && message.chat.id;
    var text = message.text;
    log_("doPost.mesaj", {
      updateId: update.update_id,
      chatId: chatId,
      date: message.date,
      text: text,
    });

    // Güvenlik: CONFIG.chatId tanımlıysa sadece o sohbetten gelen mesajlar işlenir.
    // Web App URL'i herkese açık olduğu için bu, tek kullanıcılık bot için asgari korumadır.
    if (CONFIG.chatId && String(chatId) !== String(CONFIG.chatId)) {
      log_("doPost.cikis", {
        sebep: "yetkisiz-chat",
        gelen: String(chatId),
        beklenen: String(CONFIG.chatId),
      });
      return respondOk_();
    }

    if (!text) {
      log_("doPost.cikis", "metin-yok (foto/ses/sticker olabilir)");
      sendTelegramMessage_(
        chatId,
        "Şu an sadece yazılı mesajları anlayabiliyorum. 🙂",
      );
      return respondOk_();
    }

    // Bu chat'ten gelen HER metin mesajı (komutlar dahil) Fitness projesiyle
    // paylaşılan kuyruğa da yazılır — bkz. Queue.js. Hangi mesajın Fitness'e
    // ait olduğuna Fitness kendisi karar verir: yalnızca `/spor ...` ile
    // başlayanları işler (Fitness/durumYonetimi.js > yeniTelegramMesajlariniGetir_).
    kuyrugaEkle_(update.update_id, chatId, text, message.date, message.message_id);

    // `/spor ...` Fitness'e aittir: LLM yok, cevap yok, tamamen sessiz.
    // İSTİSNA: argümansız `/spor` → kullanım açıklaması gönderilir (Fitness
    // zaten boş içerikli satırı atlıyor).
    if (sporMesajiMi_(text)) {
      log_("doPost.cikis", { sebep: "spor-fitness-icin", bos: sporMesajiBosMu_(text) });
      if (sporMesajiBosMu_(text)) {
        sendTelegramMessage_(chatId, SPOR_KULLANIM_METNI, "Markdown");
      }
      return respondOk_();
    }

    // `/` ile başlayan komutlar LLM'e hiç gitmeden burada, deterministik
    // olarak işlenir (bkz. Telegram.js > islemKomut_ ve apps-script/CLAUDE.md madde 2).
    if (text.trim().charAt(0) === "/") {
      var komutCevabi = islemKomut_(text, chatId, update.update_id);
      log_("doPost.komut-cevap", komutCevabi);
      // "Markdown" ile gönderilir: komut çıktıları tamamen bizim
      // şablonlarımız + telegramAlinti_ ile backtick'lenmiş kullanıcı
      // metinlerinden oluşur (LLM'in serbest metnini İÇERMEZ), bu
      // yüzden dengesiz özel karakter riski düşük (bkz. sendTelegramMessage_
      // fallback'i, yine de bir güvenlik ağı sağlıyor).
      sendTelegramMessage_(chatId, komutCevabi, "Markdown");
      log_("doPost.tamamlandi", { toplamSureMs: Date.now() - baslangic });
      return respondOk_();
    }

    var cevapMetni;
    try {
      cevapMetni = mesajiIsleVeYanitla_(text, message.date);
    } catch (mesajHatasi) {
      if (mesajHatasi.gecici) {
        // Katman 1'in LLM_MAX_DENEME denemesi de geçici bir hatayla
        // tükendi — mesaj Katman 2'ye (retry/RetryCore.js, saatlik tekrar
        // deneme) devredilir; kullanıcıya generic hata YERİNE dostça bir
        // bilgi gider.
        try {
          yenidenDenemeKuyruguEkle_(
            update.update_id,
            chatId,
            text,
            message.date,
            kullaniciyaGosterilecekHataMetni_(mesajHatasi),
            message.message_id,
          );
          sendTelegramMessage_(chatId, LLM_YOGUN_KULLANICI_MESAJI);
          log_("doPost.tamamlandi", {
            toplamSureMs: Date.now() - baslangic,
            sonuc: "kuyruklandi",
          });
          return respondOk_();
        } catch (kuyrukHatasi) {
          // Trigger kurulamaması artık yenidenDenemeKuyruguEkle_ içinde
          // kendi başına PES_EDILDI'ye düşüyor (bkz. retry/RetryCore.js) —
          // buraya SADECE beklenmeyen başka bir hata (örn. kilit zaman
          // aşımı, Sheets erişim hatası) düşerse gelinir. Kullanıcıya
          // ORİJİNAL LLM hatası YERİNE gerçek sebep gösterilir — aksi
          // halde asıl arıza (kuyruklama hatası) Stackdriver'a gömülüp
          // görünmez kalırdı (bkz. CLAUDE.md "Logları göremiyorum" notu).
          logHata_("doPost.kuyruklama-basarisiz-KRITIK", kuyrukHatasi);
          throw new Error(
            "Otomatik tekrar deneme kuyruğa eklenemedi: " +
              kuyrukHatasi.message +
              " (orijinal hata: " +
              kullaniciyaGosterilecekHataMetni_(mesajHatasi) +
              ")",
          );
        }
      }
      if (!hataGeciciMi_(mesajHatasi)) {
        // Kalıcı hata (400/401/403/404) — retry hiç denenmeden PES_EDILDI
        // olarak kuyruğa yazılır; kullanıcıya hem bu mesaj için hem de
        // kuyrukta biriken diğer pes-edilmiş mesajlar için toplu bildirim
        // gönderilir (bkz. retry/RetryCore.js > pesEdildiBildirimGonder_).
        try {
          pesEdildiKuyruguEkleVeBildir_(
            update.update_id,
            chatId,
            text,
            message.date,
            kullaniciyaGosterilecekHataMetni_(mesajHatasi),
            message.message_id,
          );
          log_("doPost.tamamlandi", {
            toplamSureMs: Date.now() - baslangic,
            sonuc: "kalici-hata-bildirildi",
          });
          return respondOk_();
        } catch (kuyrukHatasi) {
          logHata_("doPost.kalici-hata-kuyruklama-basarisiz", kuyrukHatasi);
          throw new Error(
            "Kalıcı hata kuyruğa yazılamadı: " +
              kuyrukHatasi.message +
              " (orijinal hata: " +
              kullaniciyaGosterilecekHataMetni_(mesajHatasi) +
              ")",
          );
        }
      }
      throw mesajHatasi; // sınıflandırılmamış/beklenmeyen hata → mevcut generic akış
    }
    log_("doPost.cevap", cevapMetni);
    sendTelegramMessage_(chatId, cevapMetni);
    log_("doPost.tamamlandi", { toplamSureMs: Date.now() - baslangic });
  } catch (err) {
    logHata_("doPost.HATA", err);
    var hedefChatId = chatId || CONFIG.chatId;
    if (!hedefChatId) {
      // Kullanıcıya hiçbir şey gidemez — sessiz kalmanın tek meşru sebebi budur.
      console.error(
        "[doPost.HATA] Hedef chat id yok (ne mesajdan ne CONFIG.chatId'den); " +
          "kullanıcıya hata mesajı gönderilemiyor.",
      );
    } else {
      try {
        sendTelegramMessage_(
          hedefChatId,
          "⚠️ Bir hata oluştu, işlem tamamlanamadı: " +
            kullaniciyaGosterilecekHataMetni_(err),
        );
      } catch (gonderimHatasi) {
        logHata_("doPost.hata-mesaji-gonderilemedi", gonderimHatasi);
      }
    }
    log_("doPost.hatayla-bitti", { toplamSureMs: Date.now() - baslangic });
  }
  return respondOk_();
}

/**
 * Telegram'ın retry/backoff mekanizmasına girmemesi için doPost her koşulda
 * 2XX döner.
 *
 * ⚠️ BURADA `ContentService` KULLANILMAZ — "daha doğru" görünse bile geri
 * değiştirmeyin. Apps Script Web App'e gelen POST önce bir Google front-end
 * sunucusuna düşer; `ContentService` çıktısında bu sunucu `302 Found` +
 * `Location` başlığıyla asıl çalışma adresine (script.googleusercontent.com)
 * yönlendirir. Telegram doğrudan 2XX bekler ve redirect'i TAKİP ETMEZ; 302'yi
 * başarısız teslimat sayıp aynı update'i saatlerce yeniden gönderir.
 *
 * Bu, gerçek bir vakada tek bir harcamanın ~11 dakikada bir tekrar tekrar
 * kaydedilmesine yol açtı (bkz. apps-script/CLAUDE.md > "Telegram'ın tekrar
 * denemesi"). `HtmlService` bu yönlendirmeyi üretmez ve doğrudan 2XX döner.
 *
 * Doğrulama: `webhookDurumu()` çıktısında `last_error_message` OLMAMALI ve
 * `pending_update_count` 0 olmalı.
 * @return {GoogleAppsScript.HTML.HtmlOutput}
 */
function respondOk_() {
  return HtmlService.createHtmlOutput("OK");
}

// ============================================================================
// Geliştirici yardımcı fonksiyonları (doPost'a bağlı değil, editörden elle çalıştırılır)
// ============================================================================

/**
 * Bu Web App deployment'ının URL'ini Telegram'a webhook olarak kaydeder.
 * Deploy ettikten sonra Apps Script editöründen bir kez elle çalıştırın.
 *
 * URL, Script Properties'teki WEBAPP_URL'den (CONFIG.webAppUrl) okunur.
 * Kasıtlı olarak ScriptApp.getService().getUrl()'e otomatik düşülmüyor:
 * o fonksiyon editörden elle ("Run" ile) çalıştırıldığında -yani gerçek bir
 * web isteği bağlamı olmadan- güvenilir biçimde /exec değil /dev (test
 * deployment) URL'ini döndürebiliyor, ve /dev URL'i anonim çağrılarda
 * (Telegram dahil) 401 Unauthorized verir. Bu sessiz/yanlış URL riskini
 * tamamen ortadan kaldırmak için WEBAPP_URL girilmemişse fonksiyon hata
 * fırlatır.
 *
 * drop_pending_updates: true gönderiyoruz — webhook yanlış URL'e işaret
 * ederken ya da kapalıyken biriken/bekleyen eski Telegram update'leri (örn.
 * test amaçlı atılmış mesajlar) bu kayıt anında sessizce atılır. Aksi halde
 * webhook doğru URL'e bağlanır bağlanmaz Telegram bu eski mesajları da
 * sırayla teslim etmeye çalışabilir.
 *
 * allowed_updates: ["message"] gönderiyoruz — doPost zaten `message` dışındaki
 * her update tipini yok saydığı için Telegram'ın onları hiç göndermemesi
 * gereksiz execution'ı ve Apps Script kotasını azaltır.
 * @return {string} Telegram API yanıtı.
 */
function kurulumWebhook() {
  var url = CONFIG.webAppUrl;
  if (!url) {
    throw new Error(
      "WEBAPP_URL Script Properties'te tanımlı değil. Önce projeyi Deploy > New " +
        "deployment > Web app ile deploy edin, ardından Manage deployments " +
        "ekranından kopyaladığınız /exec URL'ini Script Properties'e WEBAPP_URL " +
        "olarak ekleyin.",
    );
  }
  var telegramUrl =
    "https://api.telegram.org/bot" + CONFIG.telegramToken + "/setWebhook";
  var response = UrlFetchApp.fetch(telegramUrl, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      url: url,
      drop_pending_updates: true,
      allowed_updates: ["message"],
    }),
    muteHttpExceptions: true,
  });
  Logger.log(response.getContentText());
  return response.getContentText();
}

/**
 * Telegram'ın webhook hakkında ne düşündüğünü döker (getWebhookInfo): kayıtlı
 * URL, bekleyen update sayısı (`pending_update_count`), son hata tarihi ve son
 * hata mesajı (`last_error_message`).
 *
 * Bot tekrar eden ya da hiç gelmeyen mesajlarla ilgili bir sorun gösterdiğinde
 * İLK bakılacak yer burasıdır: `last_error_message`, Telegram'ın teslimatı neden
 * başarısız saydığını (yanıt zaman aşımı mı, 2XX olmayan bir yanıt mı) doğrudan
 * söyler. Apps Script'in Executions listesi tek başına bunu ayırt edemez.
 * @return {string} Telegram API yanıtı.
 */
function webhookDurumu() {
  var telegramUrl =
    "https://api.telegram.org/bot" + CONFIG.telegramToken + "/getWebhookInfo";
  var response = UrlFetchApp.fetch(telegramUrl, {
    method: "get",
    muteHttpExceptions: true,
  });
  Logger.log(response.getContentText());
  return response.getContentText();
}

/**
 * Telegram webhook kaydını kaldırır (test/temizlik amaçlı). Bekleyen
 * güncellemeleri de birlikte atar (drop_pending_updates: true).
 * @return {string} Telegram API yanıtı.
 */
function webhookSil() {
  var telegramUrl =
    "https://api.telegram.org/bot" + CONFIG.telegramToken + "/deleteWebhook";
  var response = UrlFetchApp.fetch(telegramUrl, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ drop_pending_updates: true }),
    muteHttpExceptions: true,
  });
  Logger.log(response.getContentText());
  return response.getContentText();
}
