/**
 * ============================================================================
 * Gider İşleyici — Telegram Gönderim + Komut Katmanı
 * ============================================================================
 * Telegram Bot API'ye mesaj gönderimi, `/` ile başlayan komutların Gemini'ye
 * hiç gitmeden deterministik işlenmesi, ve Gemini'den dönen parts dizisinin
 * tek bir Telegram cevap metnine birleştirilmesi burada tutulur.
 *
 * İlgili diğer dosyalar:
 *   - Config.js: CONFIG (telegramToken)
 *   - Logging.js: log_ / logHata_
 *   - Gemini.js: calistirFonksiyon_ (islemSonuclariniBirlestir_ tarafından çağrılır)
 *   - Expenses.js: sonHarcamalariGetir / sonHarcamalariTopla / normalizeAdet_ (islemKomut_ tarafından çağrılır)
 *   - retry/RetryCommands.js: pesEdilenleriListele_ / pesEdilenleriTekrarDene_ / sonMesajiSil_ (islemKomut_ tarafından çağrılır)
 *   - Main.js: doPost (bu dosyadaki sendTelegramMessage_/islemKomut_/islemSonuclariniBirlestir_'i kullanır)
 */

/**
 * Telegram Bot API sendMessage çağrısı.
 * @param {number|string} chatId
 * @param {string} text
 * @param {string} [parseMode] Verilirse (örn. "Markdown") Telegram'a
 *   `parse_mode` olarak iletilir. Gönderim BAŞARISIZ olursa (dengesiz
 *   `*`/`_`/backtick içeren bir metin "can't parse entities" ile 400
 *   döndürebilir) aynı metin parseMode OLMADAN bir kez daha denenir —
 *   biçimlendirme asla mesajın kullanıcıya hiç ulaşmamasına yol açmamalı.
 */
function sendTelegramMessage_(chatId, text, parseMode) {
  // NOT: `url` bot token içeriyor — asla loglanmaz.
  var url =
    "https://api.telegram.org/bot" + CONFIG.telegramToken + "/sendMessage";
  var payload = { chat_id: chatId, text: text };
  if (parseMode) {
    payload.parse_mode = parseMode;
  }
  log_("telegram.gonder", {
    chatId: chatId,
    uzunluk: (text || "").length,
    parseMode: parseMode || null,
  });

  var response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  var statusCode = response.getResponseCode();
  var govde = response.getContentText();
  log_("telegram.yanit", { http: statusCode, govde: govde });

  if (statusCode !== 200) {
    console.error(
      "[telegram.HATA] sendMessage başarısız (HTTP " +
        statusCode +
        "): " +
        govde,
    );
    if (parseMode) {
      log_("telegram.parse-modu-basarisiz-duz-metinle-tekrar", {
        chatId: chatId,
      });
      sendTelegramMessage_(chatId, text, undefined);
    }
  }
}

/**
 * Bir metni Telegram "code span" (backtick) biçiminde alıntılar — kullanıcının
 * kendi orijinal mesajını botun ürettiği metinden görsel olarak ayırmak için
 * (kullanıcı isteği, 2026-09-29). İçindeki literal backtick karakterleri
 * code-span'ı erken kapatmasın diye tek tırnakla değiştirilir. `parseMode:
 * "Markdown"` ile gönderilen mesajlarda kullanılmalı.
 * @param {string} metin
 * @return {string}
 */
function telegramAlinti_(metin) {
  var guvenli = String(metin === undefined || metin === null ? "" : metin).replace(
    /`/g,
    "'",
  );
  return "`" + guvenli + "`";
}

/**
 * Telegram `deleteMessage` çağrısı — `/sonmesajisil` komutu tarafından
 * kullanılır (bkz. retry/RetryCommands.js > sonMesajiSil_). Telegram özel
 * sohbette botun KENDİSİNE gelen (incoming) mesajları silmesine izin verir,
 * ama SADECE gönderildikten sonraki 48 saat içinde — bu pencere dışında
 * (ya da mesaj zaten silinmişse) Telegram hata döner, bu fonksiyon exception
 * FIRLATMAZ, sadece loglayıp `false` döner.
 * @param {number|string} chatId
 * @param {number} messageId
 * @return {boolean} Silme başarılıysa true.
 */
function telegramMesajiSil_(chatId, messageId) {
  var url =
    "https://api.telegram.org/bot" + CONFIG.telegramToken + "/deleteMessage";
  var response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    muteHttpExceptions: true,
  });
  var basarili = response.getResponseCode() === 200;
  if (!basarili) {
    log_("telegram.mesaj-silinemedi", {
      chatId: chatId,
      messageId: messageId,
      govde: response.getContentText(),
    });
  }
  return basarili;
}

/** `/komutlar` çıktısı ve tanınmayan komutlarda gösterilecek ortak liste. */
const KOMUT_LISTESI_METNI = [
  "Kullanılabilir komutlar:",
  "/son [N] — son N harcamayı listeler (belirtilmezse 5).",
  "/toplam [N] — son N harcamanın toplamını hesaplar (belirtilmezse 5).",
  "/pesedilenler — otomatik tekrar denemesi tükenmiş (pes edilmiş) mesajları listeler.",
  "/pesdene — pes edilmiş TÜM mesajları şimdi topluca tekrar dener.",
  "/sonmesajisil — bir önceki mesajınızı Telegram'dan silmeyi dener ve varsa otomatik tekrar deneme kaydını iptal eder.",
  "/komutlar — bu listeyi gösterir.",
].join("\n");

/**
 * `/` ile başlayan komutları Gemini'ye HİÇ göndermeden doğrudan işler —
 * sıfır Gemini API maliyeti/gecikmesi, tamamen deterministik (bkz.
 * apps-script/CLAUDE.md madde 2). Tanınmayan komutlar bir hata mesajı +
 * komut listesiyle karşılanır.
 *
 * İSTİSNA: `/pesdene` (retry/RetryCommands.js) bu "Gemini'ye hiç gitmez"
 * prensibinin dışındadır — pes edilmiş mesajları topluca yeniden Gemini'ye
 * göndererek tekrar dener (kullanıcının açık isteğiyle, manuel bir işlemdir).
 * @param {string} text Kullanıcının `/` ile başlayan tam mesajı.
 * @param {number|string} chatId `/sonmesajisil` için gerekli.
 * @param {number} updateId Bu komut mesajının kendi update_id'si —
 *   `/sonmesajisil`'in "son mesaj" aramasında komutun KENDİ satırını hariç
 *   tutması için gerekli (bkz. sonMesajiSil_).
 * @return {string} Telegram'a gönderilecek yanıt.
 */
function islemKomut_(text, chatId, updateId) {
  var parcalar = text.trim().split(/\s+/);
  var komut = parcalar[0].toLowerCase();
  var argument = parcalar[1];

  log_("komut.cagri", { komut: komut, argument: argument });

  if (komut === "/son") {
    return sonHarcamalariGetir({ adet: normalizeAdet_(argument) });
  }
  if (komut === "/toplam") {
    return sonHarcamalariTopla({ adet: normalizeAdet_(argument) });
  }
  if (komut === "/pesedilenler") {
    return pesEdilenleriListele_();
  }
  if (komut === "/pesdene") {
    return pesEdilenleriTekrarDene_();
  }
  if (komut === "/sonmesajisil") {
    return sonMesajiSil_(chatId, updateId);
  }
  if (komut === "/komutlar") {
    return KOMUT_LISTESI_METNI;
  }

  log_("komut.bilinmeyen", komut);
  return "Komut bulunamadı: " + komut + "\n\n" + KOMUT_LISTESI_METNI;
}

/**
 * Gemini'den dönen parts dizisini (birden fazla functionCall + opsiyonel bir
 * text part aynı anda bulunabilir) tek bir Telegram mesajına birleştirir.
 * @param {Array<Object>} parts
 * @return {string}
 */
function islemSonuclariniBirlestir_(parts) {
  var fonksiyonSonuclari = [];
  var metinParcalari = [];

  parts.forEach(function (part) {
    if (part.functionCall) {
      fonksiyonSonuclari.push(calistirFonksiyon_(part.functionCall));
    } else if (part.text && part.text.trim()) {
      metinParcalari.push(part.text.trim());
    }
  });

  log_("birlestir.ozet", {
    fonksiyonSonucu: fonksiyonSonuclari.length,
    metinParcasi: metinParcalari.length,
  });

  if (fonksiyonSonuclari.length === 0) {
    // Hiç fonksiyon çağrısı yok: Gemini'nin metni bir selamlaşma, genel bir
    // soru ya da netleştirme talebi olabilir — hepsi geçerli düz cevaplardır,
    // "❓ Netleştirilmesi gerekenler" gibi harcamaya özgü bir etiketle
    // sarmalamadan olduğu gibi iletilir.
    return metinParcalari.length > 0
      ? metinParcalari.join("\n\n")
      : "Anlayamadım, tekrar dener misin?";
  }

  var bloklar = [fonksiyonSonuclari.join("\n\n")];
  if (metinParcalari.length > 0) {
    // Burada en az bir harcama başarıyla eklendi; kalan metin parçaları
    // gerçekten "bu kalem için netleştirme gerekiyor" anlamına gelir (bkz.
    // Gemini.js > SYSTEM_INSTRUCTION_TEMPLATE > ZORUNLU NETLİK KURALI, kısmi
    // ekleme senaryosu).
    bloklar.push(
      "❓ Netleştirilmesi gerekenler:\n" + metinParcalari.join("\n"),
    );
  }

  return bloklar.join("\n\n");
}
