/**
 * ============================================================================
 * Gider İşleyici — Gemini Geçici/Kalıcı Hatalarında Katman 2: Mesaj Bazlı
 * Tekrar Deneme (Trigger Zinciri)
 * ============================================================================
 * Main.js > callGeminiIleTekrarDeneme_ (Katman 1) bir mesaj için art arda
 * GEMINI_MAX_DENEME kez denendiği halde GEÇİCİ bir hatayla (503, ağ hatası,
 * boş yanıt vb.) başarısız kalırsa, bu dosya o mesaja özel, TEK SEFERLİK bir
 * Apps Script trigger kurar (ilk kez 1 saat sonrasına). Trigger ateşlendiğinde
 * yine Katman 1 (3 hızlı deneme) çalışır; yine geçici bir hatayla başarısız
 * olursa BİR SONRAKİ AŞAMA için yeni bir tek seferlik trigger kurulur. Aşama
 * gecikmeleri RETRY_BACKOFF_SAAT: 1-1-2-2-4 saat (toplam ~10 saat, 5 aşama).
 * Son (5.) aşama da başarısız olursa sistem PES EDER — 6. bir trigger
 * KURULMAZ, satır `PES_EDILDI` durumuna işaretlenir (ASLA silinmez) ve
 * kullanıcıya hem bu mesaj için hem de kuyrukta biriken diğer pes-edilmiş
 * mesajlar için toplu bir bildirim gönderilir. Kalıcı bir HTTP hatası
 * (400/401/403/404 — Main.js > GEMINI_KALICI_HTTP_KODLARI) alınırsa hiç retry
 * denenmeden aynı PES_EDILDI yoluna girilir (bkz. pesEdildiKuyruguEkleVeBildir_).
 * Gemini'nin "model şu an yüksek talepte" (`error.status: "UNAVAILABLE"`)
 * yanıtı özel olarak tanınır (Main.js > hataYuksekTalepMi_): sebep zaten
 * bilindiği için Katman 1'in hızlı denemeleri boşuna harcanmaz, doğrudan
 * Katman 2'ye (bu dosya) geçilir.
 *
 * KASITLI OLARAK sürekli/periyodik bir trigger YOK — her trigger, bir mesajın
 * gerçekten başarısız kalmasının doğal bir sonucu olarak kurulur (kullanıcı
 * kararı).
 *
 * ============================================================================
 * ÖNEMLİ (2026-09-26) — AYRI BİR SEKME YOK, `telegram_queue` YENİDEN KULLANILIYOR
 * ============================================================================
 * Bu modül KENDİ sekmesini TUTMAZ. Retry bookkeeping'i (durum, deneme_asamasi,
 * sonraki_deneme_zamani, ilk_hata_zamani, son_deneme_zamani, son_hata_mesaji,
 * trigger_id) Queue.js'in zaten yönettiği, Fitness projesiyle PAYLAŞILAN
 * `telegram_queue` sekmesine E:K kolonları olarak eklendi (bkz. Queue.js >
 * QUEUE_HEADERS). Neden: kullanıcı kararı — "yeniden deneme için yeni sayfa
 * açma, mevcut kolon yapısının üzerine devam et."
 *
 * Bu, doPost'un HER metin mesajı için zaten çağırdığı `kuyrugaEkle_`'nin
 * (Queue.js) A:D'yi (update_id/chat_id/text/date) doldurduğu satırın AYNISINI
 * kullanır — Gemini başarısız olduğunda `kuyrukSatiriniUpdateIdIleBul_` o
 * satırı update_id ile bulup E:K'yı doldurur (YENİ bir satır EKLEMEZ). Yani bu
 * sekmedeki satırların TÜMÜ retry-takip kaydı DEĞİLDİR: `durum` (E) boşsa o
 * mesaj normal işlendi ya da hiç Gemini'ye gitmedi (komut vb.); `durum`
 * BEKLIYOR/ISLENIYOR/PES_EDILDI/TAMAMLANDI'dan biriyse retry sistemine
 * girmiştir.
 *
 * **Silme kuralı (kullanıcı onayı, 2026-09-26):** Fitness günde 3 kez çalışıp
 * SADECE aynı günün mesajlarıyla ilgilendiği için 5 günden eski satırların
 * silinmesi Fitness için sorun DEĞİL — bu yüzden `eskiKayitlariTemizle_`
 * `durum` boş (retry'a hiç girmemiş, ilk denemede başarılı olmuş sıradan
 * mesajlar) ya da `TAMAMLANDI` olan ve 5 günden eski satırları TAMAMEN SİLER
 * (`sheet.deleteRow`). Tek istisna, HİÇBİR ZAMAN silinmeyen iki durum:
 * `BEKLIYOR`/`ISLENIYOR` (hâlâ aktif iş) ve `PES_EDILDI` (kullanıcının haberdar
 * olması gereken, hiçbir yere kaydedilmemiş bir harcama) — bunlar yaşı ne
 * olursa olsun dokunulmaz, çünkü bir harcamayı sessizce unutmak/kaybetmek
 * kabul edilemez (kullanıcı kararı, Fitness'ten bağımsız).
 *
 * İlgili diğer dosyalar:
 *   - Queue.js: QUEUE_HEADERS/getOrCreateQueueSheet_/kuyrugaEkle_ (paylaşılan
 *     sekme ve A:D kontratı burada yönetilir)
 *   - Main.js: callGeminiIleTekrarDeneme_ / hataGeciciMi_ / mesajiIsleVeYanitla_ /
 *     doPost (geçici hatada yenidenDenemeKuyruguEkle_'yi, kalıcı hatada
 *     pesEdildiKuyruguEkleVeBildir_'i çağırır)
 *   - Expenses.js: getTargetSpreadsheet_ (Queue.js üzerinden dolaylı kullanılır)
 */

// ============================================================================
// Sabitler
// ============================================================================

const RETRY_DURUM = {
  BEKLIYOR: "BEKLIYOR", // bir trigger'ı var, vakti geldiğinde işlenecek
  ISLENIYOR: "ISLENIYOR", // şu an bir trigger tarafından işleniyor (çok kısa ömürlü ara durum)
  PES_EDILDI: "PES_EDILDI", // tüm aşamalar (ya da kalıcı hata) tükendi, retry durduruldu — ASLA SİLİNMEZ/TEMİZLENMEZ
  TAMAMLANDI: "TAMAMLANDI", // gecikmeli de olsa başarıyla işlendi — SADECE bu durumun E:K kolonları FIFO ile temizlenebilir
};

/**
 * Aşama gecikmeleri (saat). Aşama 1 → 1sa, 2 → 1sa, 3 → 2sa, 4 → 2sa, 5 → 4sa.
 * 5. aşamanın (4 saatlik beklemenin) sonundaki deneme de başarısız olursa
 * PES EDİLİR — 6. bir eleman/aşama YOK (bkz. sonAsamaMi_).
 */
const RETRY_BACKOFF_SAAT = [1, 1, 2, 2, 4];

/** Trigger'ların çağıracağı, Apps Script'e kayıtlı giriş noktası fonksiyon adı. */
const RETRY_HANDLER_FN_ADI = "zamanlanmisTekrarDenemeyiIsle";

/** Oku/claim-et ve satır güncelleme kritik bölümleri için kilit bekleme süresi (ms). */
const RETRY_LOCK_TIMEOUT_MS = 10000;

/** Aynı anda birden fazla mesajın vadesi gelirse tek bir trigger ateşlenişinde işlenecek üst sınır. */
const RETRY_MAX_SATIR_PER_TETIKLEME = 5;

/** FIFO temizlik eşiği: ilk_hata_zamani'ndan itibaren bu süreyi aşan TAMAMLANDI satırların E:K'sı boşaltılır. */
const RETRY_TEMIZLIK_ESIK_MS = 5 * 24 * 60 * 60 * 1000; // 5 gün

// ============================================================================
// Kuyruk (telegram_queue, Queue.js) satır okuma/yazma yardımcıları
// ============================================================================

/**
 * Ham bir sheet satırını (QUEUE_HEADERS sırasıyla) okunabilir bir nesneye
 * çevirir. `satirNo` 1-indeksli gerçek sheet satır numarasıdır.
 * @param {number} satirNo
 * @param {Array<*>} row
 * @return {Object}
 */
function kuyrukSatirNesnesiOlustur_(satirNo, row) {
  return {
    satirNo: satirNo,
    updateId: row[0],
    chatId: row[1],
    text: row[2],
    mesajTarihi: row[3],
    durum: row[4],
    denemeAsamasi: row[5],
    sonrakiDenemeZamani: row[6],
    ilkHataZamani: row[7],
    sonDenemeZamani: row[8],
    sonHataMesaji: row[9],
    triggerId: row[10],
  };
}

/**
 * 2. satırdan itibaren tüm veri satırlarını okur. DİKKAT: bu, `telegram_queue`
 * PAYLAŞILAN sekmesindeki TÜM mesajları döndürür (retry-takipli olsun ya da
 * olmasın) — çağıranlar `durum` alanına göre filtrelemelidir.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {Array<Object>}
 */
function kuyrukTumSatirlariOku_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }
  var degerler = sheet.getRange(2, 1, lastRow - 1, QUEUE_HEADERS.length).getValues();
  return degerler.map(function (row, i) {
    return kuyrukSatirNesnesiOlustur_(i + 2, row);
  });
}

/**
 * `update_id`'ye sahip satırı bulur (en son eklenenden geriye doğru arar —
 * pratikte aranan satır genelde kuyrugaEkle_'nin AZ ÖNCE eklediği en son
 * satırdır). Bulunamazsa null döner (savunma amaçlı — normalde HER metin
 * mesajı için doPost bu satırı Gemini'den ÖNCE zaten ekler).
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} updateId
 * @return {Object|null}
 */
function kuyrukSatiriniUpdateIdIleBul_(sheet, updateId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return null;
  }
  var idKolonu = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = idKolonu.length - 1; i >= 0; i--) {
    if (Number(idKolonu[i][0]) === Number(updateId)) {
      var satirNo = i + 2;
      var row = sheet.getRange(satirNo, 1, 1, QUEUE_HEADERS.length).getValues()[0];
      return kuyrukSatirNesnesiOlustur_(satirNo, row);
    }
  }
  return null;
}

/**
 * `row` nesnesini (kuyrukTumSatirlariOku_/kuyrukSatiriniUpdateIdIleBul_'dan)
 * `alanlar` ile birleştirip TEK bir setValues çağrısıyla ilgili satırı
 * günceller — sadece değişen alanları belirtmek yeterli, diğerleri `row`'daki
 * mevcut değerleriyle korunur (A:D dahil, yani Fitness'in verisi asla
 * bozulmaz çünkü zaten hep `row`'dan aynen geri yazılır).
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Object} row
 * @param {Object} alanlar Güncellenecek alanlar (kısmi, sadece E:K'dan olmalı).
 */
function satiriGuncelle_(sheet, row, alanlar) {
  var guncel = Object.assign({}, row, alanlar);
  sheet
    .getRange(row.satirNo, 1, 1, QUEUE_HEADERS.length)
    .setValues([
      [
        guncel.updateId,
        guncel.chatId,
        guncel.text,
        guncel.mesajTarihi,
        guncel.durum,
        guncel.denemeAsamasi,
        guncel.sonrakiDenemeZamani,
        guncel.ilkHataZamani,
        guncel.sonDenemeZamani,
        guncel.sonHataMesaji,
        guncel.triggerId,
      ],
    ]);
}

/**
 * Bir satırı PES_EDILDI durumuna işaretler (E:K'daki durum/hata alanları
 * güncellenir, trigger_id temizlenir — artık kurulu bir trigger'ı yok). Satır
 * ASLA silinmez/A:D'ye dokunulmaz.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Object} row
 * @param {string} hataMesaji
 * @param {Date} simdi
 */
function satiriPesEdildiOlarakIsaretle_(sheet, row, hataMesaji, simdi) {
  satiriGuncelle_(sheet, row, {
    durum: RETRY_DURUM.PES_EDILDI,
    sonHataMesaji: hataMesaji,
    sonDenemeZamani: simdi,
    triggerId: "",
  });
}

/**
 * `date` (mesajTarihi) sütunundan itibaren RETRY_TEMIZLIK_ESIK_MS'i (5 gün)
 * aşan satırları SİLER — hem `durum` boş (retry'a hiç girmemiş, ilk denemede
 * başarılı olmuş sıradan mesajlar) hem `TAMAMLANDI` (gecikmeli de olsa
 * başarıyla işlenmiş) satırlar bu kapsamdadır. Fitness günde 3 kez çalışıp
 * sadece aynı günün mesajlarıyla ilgilendiği için 5 günlük geçmişi hiç
 * kullanmıyor — bu yüzden gerçek satır silme Fitness için güvenli (kullanıcı
 * onayı, 2026-09-26).
 *
 * `BEKLIYOR`/`ISLENIYOR` (hâlâ aktif iş) ve `PES_EDILDI` (kullanıcının
 * haberdar olması gereken, hiçbir yere kaydedilmemiş bir harcama) yaşı ne
 * olursa olsun ASLA silinmez — bir harcamayı sessizce unutmak/kaybetmek kabul
 * edilemez (kullanıcı kararı, bu iki durum için Fitness'ten bağımsız).
 *
 * Ayrı bir periyodik trigger YOK (kullanıcı kararı); bu yüzden bu fonksiyon
 * zaten var olan giriş noktalarının (yenidenDenemeKuyruguEkle_,
 * pesEdildiKuyruguEkleVeBildir_, zamanlanmisTekrarDenemeyiIsle) başında ucuz
 * bir ilk-adım olarak çağrılır.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Date} simdi
 */
function eskiKayitlariTemizle_(sheet, simdi) {
  var satirlar = kuyrukTumSatirlariOku_(sheet);
  var silinecekler = satirlar
    .filter(function (row) {
      if (
        row.durum === RETRY_DURUM.BEKLIYOR ||
        row.durum === RETRY_DURUM.ISLENIYOR ||
        row.durum === RETRY_DURUM.PES_EDILDI
      ) {
        return false;
      }
      var mesajMs =
        row.mesajTarihi instanceof Date
          ? row.mesajTarihi.getTime()
          : new Date(row.mesajTarihi).getTime();
      return simdi.getTime() - mesajMs > RETRY_TEMIZLIK_ESIK_MS;
    })
    .sort(function (a, b) {
      return b.satirNo - a.satirNo; // azalan sırayla sil, index kaymasını önler
    });

  silinecekler.forEach(function (row) {
    log_("yenidenDeneme.fifo-temizlik", { updateId: row.updateId, satirNo: row.satirNo });
    sheet.deleteRow(row.satirNo);
  });
}

// ============================================================================
// Aşama/backoff hesaplama (saf fonksiyonlar)
// ============================================================================

/**
 * `asamaNo`ya (1-indeksli) karşılık gelen bekleme süresini (saat) döndürür.
 * @param {number} asamaNo
 * @return {number}
 */
function sonrakiGecikmeSaat_(asamaNo) {
  var index = Math.min(asamaNo, RETRY_BACKOFF_SAAT.length) - 1;
  return RETRY_BACKOFF_SAAT[index];
}

/**
 * `asamaNo` son aşama (RETRY_BACKOFF_SAAT'in son elemanı, 4 saat) mı? True ise
 * bu aşamanın başarısızlığı bir sonraki trigger'ı DEĞİL, PES ETMEyi tetikler.
 * @param {number} asamaNo
 * @return {boolean}
 */
function sonAsamaMi_(asamaNo) {
  return asamaNo >= RETRY_BACKOFF_SAAT.length;
}

// ============================================================================
// Trigger yönetimi
// ============================================================================

/**
 * `gecikmeSaat` saat sonrasına tek seferlik bir Apps Script trigger kurar.
 * ⚠️ Tek seferlik (`after`) trigger'lar ateşlendikten sonra KENDİLİĞİNDEN
 * SİLİNMEZ — kurulumdan sonraki her aşama geçişinde eskisi mutlaka
 * zamanliTetikleyiciSil_ ile temizlenmeli, aksi halde proje trigger kotası
 * (~20) sessizce tükenir.
 * @param {number} gecikmeSaat
 * @return {string} Yeni trigger'ın uniqueId'si.
 */
function zamanliTetikleyiciKur_(gecikmeSaat) {
  var trigger = ScriptApp.newTrigger(RETRY_HANDLER_FN_ADI)
    .timeBased()
    .after(gecikmeSaat * 60 * 60 * 1000)
    .create();
  return trigger.getUniqueId();
}

/**
 * `triggerId`ye sahip trigger'ı bulup siler. Bulunamazsa (zaten silinmiş/hiç
 * kurulmamış) sessizce no-op.
 * @param {string} triggerId
 */
function zamanliTetikleyiciSil_(triggerId) {
  if (!triggerId) {
    return;
  }
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getUniqueId() === triggerId) {
      ScriptApp.deleteTrigger(triggers[i]);
      return;
    }
  }
  log_("yenidenDeneme.trigger-bulunamadi", triggerId);
}

// ============================================================================
// Giriş noktaları (Main.js > doPost tarafından çağrılır)
// ============================================================================

/**
 * Katman 1 (callGeminiIleTekrarDeneme_) GEÇİCİ bir hatayla tükendiğinde
 * `doPost` tarafından çağrılır. `kuyrugaEkle_`'nin (Queue.js) bu `update_id`
 * için AZ ÖNCE (aynı doPost execution'ında, Gemini çağrısından ÖNCE) eklediği
 * satırı bulup E:K kolonlarını doldurur — YENİ bir satır EKLEMEZ. O satır
 * (savunma amaçlı, normalde olmaması gereken bir durumda) bulunamazsa mesajı
 * kaybetmemek için tam bir satır olarak eklenir. 1 saat sonrasına ilk
 * trigger'ı kurar.
 * @param {number} updateId
 * @param {number|string} chatId
 * @param {string} text
 * @param {number} mesajTarihiSaniye Telegram update.message.date (Unix saniye).
 * @param {string} hataMesaji
 */
function yenidenDenemeKuyruguEkle_(
  updateId,
  chatId,
  text,
  mesajTarihiSaniye,
  hataMesaji,
) {
  var lock = LockService.getScriptLock();
  lock.waitLock(RETRY_LOCK_TIMEOUT_MS);
  try {
    var sheet = getOrCreateQueueSheet_();
    var simdi = new Date();
    eskiKayitlariTemizle_(sheet, simdi);

    var ilkAsama = 1;
    var gecikmeSaat = sonrakiGecikmeSaat_(ilkAsama);
    var triggerId = zamanliTetikleyiciKur_(gecikmeSaat);
    var sonrakiDenemeZamani = new Date(simdi.getTime() + gecikmeSaat * 60 * 60 * 1000);

    var alanlar = {
      durum: RETRY_DURUM.BEKLIYOR,
      denemeAsamasi: ilkAsama,
      sonrakiDenemeZamani: sonrakiDenemeZamani,
      ilkHataZamani: simdi,
      sonDenemeZamani: simdi,
      sonHataMesaji: hataMesaji,
      triggerId: triggerId,
    };

    var mevcutSatir = kuyrukSatiriniUpdateIdIleBul_(sheet, updateId);
    if (mevcutSatir) {
      satiriGuncelle_(sheet, mevcutSatir, alanlar);
    } else {
      logHata_(
        "yenidenDeneme.kuyruk-satiri-bulunamadi",
        "update_id=" + updateId + " için kuyrugaEkle_ satırı yok, yeni satır ekleniyor.",
      );
      sheet.appendRow([
        updateId,
        chatId,
        text,
        new Date(mesajTarihiSaniye * 1000),
        alanlar.durum,
        alanlar.denemeAsamasi,
        alanlar.sonrakiDenemeZamani,
        alanlar.ilkHataZamani,
        alanlar.sonDenemeZamani,
        alanlar.sonHataMesaji,
        alanlar.triggerId,
      ]);
    }
    log_("yenidenDeneme.kuyruklandi", {
      updateId: updateId,
      triggerId: triggerId,
      sonrakiDenemeZamani: sonrakiDenemeZamani,
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Katman 1 KALICI bir hatayla (400/401/403/404) başarısız olduğunda `doPost`
 * tarafından çağrılır: hiç retry denenmeden, `kuyrugaEkle_`'nin az önce
 * eklediği AYNI satır doğrudan PES_EDILDI olarak işaretlenir (bulunamazsa
 * savunma amaçlı yeni satır eklenir) ve kullanıcıya bildirim gönderilir.
 * @param {number} updateId
 * @param {number|string} chatId
 * @param {string} text
 * @param {number} mesajTarihiSaniye
 * @param {string} hataMesaji
 */
function pesEdildiKuyruguEkleVeBildir_(
  updateId,
  chatId,
  text,
  mesajTarihiSaniye,
  hataMesaji,
) {
  var lock = LockService.getScriptLock();
  lock.waitLock(RETRY_LOCK_TIMEOUT_MS);
  var sheet, satirNo;
  try {
    sheet = getOrCreateQueueSheet_();
    var simdi = new Date();
    eskiKayitlariTemizle_(sheet, simdi);

    var alanlar = {
      durum: RETRY_DURUM.PES_EDILDI,
      denemeAsamasi: 0,
      sonrakiDenemeZamani: "",
      ilkHataZamani: simdi,
      sonDenemeZamani: simdi,
      sonHataMesaji: hataMesaji,
      triggerId: "",
    };

    var mevcutSatir = kuyrukSatiriniUpdateIdIleBul_(sheet, updateId);
    if (mevcutSatir) {
      satiriGuncelle_(sheet, mevcutSatir, alanlar);
      satirNo = mevcutSatir.satirNo;
    } else {
      logHata_(
        "yenidenDeneme.kuyruk-satiri-bulunamadi",
        "update_id=" + updateId + " için kuyrugaEkle_ satırı yok, yeni satır ekleniyor.",
      );
      sheet.appendRow([
        updateId,
        chatId,
        text,
        new Date(mesajTarihiSaniye * 1000),
        alanlar.durum,
        alanlar.denemeAsamasi,
        alanlar.sonrakiDenemeZamani,
        alanlar.ilkHataZamani,
        alanlar.sonDenemeZamani,
        alanlar.sonHataMesaji,
        alanlar.triggerId,
      ]);
      satirNo = sheet.getLastRow();
    }
    log_("yenidenDeneme.kalici-hata-kuyruklandi", { updateId: updateId, satirNo: satirNo });
  } finally {
    lock.releaseLock();
  }

  // Telegram gönderimi kilit DIŞINDA yapılır (ağ çağrısı kilit altında tutulmaz).
  pesEdildiBildirimGonder_(sheet, chatId, text, hataMesaji, satirNo);
}

/**
 * Bir mesaj PES_EDILDI olduğunda kullanıcıya (a) o mesaja özel bir bildirim,
 * (b) kuyrukta biriken DİĞER PES_EDILDI satırlarının toplu bir özetini
 * (varsa) gönderir. `buSatirNo`, "diğer" filtresinde bu satırı dışlamak için
 * kullanılır (metin eşleşmesi yerine satır numarası — daha güvenilir).
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number|string} chatId
 * @param {string} text
 * @param {string} hataMesaji
 * @param {number} buSatirNo
 */
function pesEdildiBildirimGonder_(sheet, chatId, text, hataMesaji, buSatirNo) {
  sendTelegramMessage_(
    chatId,
    "❌ Bu mesaj işlenemedi, otomatik tekrar deneme durduruldu: " +
      hataMesaji +
      "\n\nOrijinal mesajınız: " +
      text,
  );

  var digerPesEdilenler = kuyrukTumSatirlariOku_(sheet).filter(function (row) {
    return row.durum === RETRY_DURUM.PES_EDILDI && row.satirNo !== buSatirNo;
  });

  if (digerPesEdilenler.length > 0) {
    var liste = digerPesEdilenler
      .map(function (row, i) {
        return i + 1 + ". " + row.text;
      })
      .join("\n");
    sendTelegramMessage_(
      chatId,
      "📋 Ayrıca hâlâ işlenmemiş " +
        digerPesEdilenler.length +
        " eski mesaj var:\n" +
        liste,
    );
  }
}

// ============================================================================
// Trigger giriş noktası (Apps Script tarafından çağrılır — doPost gibi, isimde alt çizgi yok)
// ============================================================================

/**
 * Bir mesajın kendi aşamasına özel tek seferlik trigger'ı ateşlendiğinde Apps
 * Script tarafından çağrılır. Vadesi gelmiş (durum=BEKLIYOR ve
 * sonraki_deneme_zamani geçmiş) satırları bulup işler:
 *   - Başarılı → "gecikmeli işlendi" notuyla Telegram'a gönderilir, satır
 *     SİLİNMEZ, durum=TAMAMLANDI'ya geçer.
 *   - Geçici hata + son aşama DEĞİLSE → bir sonraki aşama için yeni trigger kurulur.
 *   - Geçici hata + SON aşama (4sa) ise → PES EDİLİR, 6. trigger KURULMAZ.
 *   - Kalıcı hata (nadiren, savunma amaçlı) → doğrudan PES EDİLİR.
 *   - Yeni trigger kurulamazsa (örn. kota doldu) → sessizce kaybetmek yerine PES EDİLİR.
 */
function zamanlanmisTekrarDenemeyiIsle() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(RETRY_LOCK_TIMEOUT_MS);
  } catch (err) {
    logHata_("yenidenDeneme.kilit-alinamadi", err);
    return;
  }

  var sheet, vadesiGelenler;
  try {
    sheet = getOrCreateQueueSheet_();
    var simdiClaim = new Date();
    eskiKayitlariTemizle_(sheet, simdiClaim);

    var tumSatirlar = kuyrukTumSatirlariOku_(sheet);
    vadesiGelenler = tumSatirlar
      .filter(function (row) {
        if (row.durum !== RETRY_DURUM.BEKLIYOR) {
          return false;
        }
        var sonrakiMs =
          row.sonrakiDenemeZamani instanceof Date
            ? row.sonrakiDenemeZamani.getTime()
            : new Date(row.sonrakiDenemeZamani).getTime();
        return sonrakiMs <= simdiClaim.getTime();
      })
      .slice(0, RETRY_MAX_SATIR_PER_TETIKLEME)
      .sort(function (a, b) {
        return b.satirNo - a.satirNo; // azalan sırayla işle: sonradan silme index kaydırmaz
      });

    // Claim: bu satırları tetikleyen (artık ateşlenmiş) trigger'ları temizle,
    // durumu ISLENIYOR yap — Gemini çağrısı kilit DIŞINDA yapılacak.
    vadesiGelenler.forEach(function (row) {
      zamanliTetikleyiciSil_(row.triggerId);
      satiriGuncelle_(sheet, row, {
        durum: RETRY_DURUM.ISLENIYOR,
        sonDenemeZamani: simdiClaim,
      });
      row.durum = RETRY_DURUM.ISLENIYOR;
    });

    log_("yenidenDeneme.tarama", { vadesiGelen: vadesiGelenler.length });
  } finally {
    lock.releaseLock();
  }

  vadesiGelenler.forEach(function (row) {
    var simdi = new Date();
    try {
      var mesajZamaniSaniye = Math.floor(row.mesajTarihi.getTime() / 1000);
      var cevapMetni = mesajiIsleVeYanitla_(row.text, mesajZamaniSaniye);
      var saatOnce = Math.max(
        1,
        Math.round((simdi.getTime() - row.mesajTarihi.getTime()) / 3600000),
      );
      sendTelegramMessage_(
        row.chatId,
        "⏳ Gecikmeli işlendi (" +
          saatOnce +
          " saat önce gönderilmişti):\n\n" +
          cevapMetni,
      );
      // Satır SİLİNMEZ — TAMAMLANDI olarak işaretlenir, yalnızca 5 günlük FIFO
      // temizliği (eskiKayitlariTemizle_) bu durumdaki satırların E:K'sını
      // (A:D DEĞİL) boşaltır.
      satiriGuncelle_(sheet, row, {
        durum: RETRY_DURUM.TAMAMLANDI,
        sonHataMesaji: "",
        sonDenemeZamani: simdi,
        triggerId: "",
      });
      log_("yenidenDeneme.basarili", {
        updateId: row.updateId,
        asama: row.denemeAsamasi,
      });
      return;
    } catch (err) {
      // Sınıflandırılmamış/beklenmeyen bir hata da (hataGeciciMi_ default: geçici)
      // "reschedule ya da açıkça pes et" yoluna düşer — asla sessizce silinmez.
      if (!hataGeciciMi_(err)) {
        satiriPesEdildiOlarakIsaretle_(sheet, row, err.message, simdi);
        pesEdildiBildirimGonder_(
          sheet,
          row.chatId,
          row.text,
          err.message,
          row.satirNo,
        );
        return;
      }

      if (sonAsamaMi_(row.denemeAsamasi)) {
        satiriPesEdildiOlarakIsaretle_(sheet, row, err.message, simdi);
        pesEdildiBildirimGonder_(
          sheet,
          row.chatId,
          row.text,
          err.message,
          row.satirNo,
        );
        return;
      }

      var yeniAsama = row.denemeAsamasi + 1;
      try {
        var gecikmeSaat = sonrakiGecikmeSaat_(yeniAsama);
        var yeniTriggerId = zamanliTetikleyiciKur_(gecikmeSaat);
        var yeniSonrakiZaman = new Date(
          simdi.getTime() + gecikmeSaat * 60 * 60 * 1000,
        );
        satiriGuncelle_(sheet, row, {
          durum: RETRY_DURUM.BEKLIYOR,
          denemeAsamasi: yeniAsama,
          sonrakiDenemeZamani: yeniSonrakiZaman,
          sonHataMesaji: err.message,
          sonDenemeZamani: simdi,
          triggerId: yeniTriggerId,
        });
        log_("yenidenDeneme.sonraki-asama", {
          updateId: row.updateId,
          asama: yeniAsama,
          gecikmeSaat: gecikmeSaat,
        });
      } catch (triggerErr) {
        logHata_("yenidenDeneme.trigger-kurulamadi-KRITIK", triggerErr);
        var triggerHataMesaji = "Trigger kurulamadı: " + triggerErr.message;
        satiriPesEdildiOlarakIsaretle_(sheet, row, triggerHataMesaji, simdi);
        pesEdildiBildirimGonder_(
          sheet,
          row.chatId,
          row.text,
          triggerHataMesaji,
          row.satirNo,
        );
      }
    }
  });
}

// ============================================================================
// Komutlar (Main.js > islemKomut_ tarafından çağrılır, Telegram `/pesedilenler`
// ve `/pesdene` komutlarının karşılığı)
// ============================================================================

/**
 * `/pesedilenler` komutunun çıktısı: kuyruktaki TÜM `PES_EDILDI` satırlarını
 * (otomatik tekrar denemesi tükenmiş/kalıcı hatayla başarısız kalmış mesajlar)
 * okunabilir bir listeye çevirir. Gemini'ye hiç gitmez, tamamen deterministik.
 * @return {string}
 */
function pesEdilenleriListele_() {
  var sheet = getOrCreateQueueSheet_();
  var simdi = new Date();
  var pesEdilenler = kuyrukTumSatirlariOku_(sheet).filter(function (row) {
    return row.durum === RETRY_DURUM.PES_EDILDI;
  });

  if (pesEdilenler.length === 0) {
    return "Pes edilmiş mesaj yok. 🎉";
  }

  var satirlar = pesEdilenler.map(function (row, i) {
    var ilkHataMs =
      row.ilkHataZamani instanceof Date
        ? row.ilkHataZamani.getTime()
        : new Date(row.ilkHataZamani).getTime();
    var saatOnce = Math.max(
      1,
      Math.round((simdi.getTime() - ilkHataMs) / 3600000),
    );
    return (
      i +
      1 +
      ". (" +
      saatOnce +
      " saat önce) " +
      row.text +
      "\n   Hata: " +
      row.sonHataMesaji
    );
  });

  return (
    "❌ " +
    pesEdilenler.length +
    " pes edilmiş mesaj var — /pesdene ile topluca tekrar deneyebilirsin:\n\n" +
    satirlar.join("\n\n")
  );
}

/**
 * `/pesdene` komutunun çıktısı: kuyruktaki TÜM `PES_EDILDI` satırlarını, her
 * biri için Katman 1'i (callGeminiIleTekrarDeneme_, en fazla GEMINI_MAX_DENEME
 * hızlı deneme) kullanarak ŞİMDİ topluca tekrar dener. Katman 2'ye (yeni
 * trigger kurma) HİÇ girmez — bu SADECE anlık, manuel bir deneme; hâlâ
 * başarısız kalanlar PES_EDILDI'de kalır (silinmez), sadece
 * `son_hata_mesaji`/`son_deneme_zamani` güncellenir. Başarılı olanlar
 * otomatik akışla simetrik şekilde TAMAMLANDI'ya geçer (silinmez, 5 günlük
 * FIFO'ya bırakılır) — bkz. eskiKayitlariTemizle_.
 * @return {string} Kullanıcıya gösterilecek özet.
 */
function pesEdilenleriTekrarDene_() {
  var sheet = getOrCreateQueueSheet_();
  var pesEdilenler = kuyrukTumSatirlariOku_(sheet)
    .filter(function (row) {
      return row.durum === RETRY_DURUM.PES_EDILDI;
    })
    .sort(function (a, b) {
      return b.satirNo - a.satirNo; // azalan sırayla işle, index kaymasına karşı savunma
    });

  if (pesEdilenler.length === 0) {
    return "Pes edilmiş mesaj yok, tekrar denenecek bir şey bulunamadı.";
  }

  var basarili = [];
  var basarisiz = [];

  pesEdilenler.forEach(function (row) {
    var simdi = new Date();
    try {
      var mesajZamaniSaniye = Math.floor(row.mesajTarihi.getTime() / 1000);
      var cevapMetni = mesajiIsleVeYanitla_(row.text, mesajZamaniSaniye);
      satiriGuncelle_(sheet, row, {
        durum: RETRY_DURUM.TAMAMLANDI,
        sonHataMesaji: "",
        sonDenemeZamani: simdi,
      });
      basarili.push({ text: row.text, cevap: cevapMetni });
    } catch (err) {
      satiriGuncelle_(sheet, row, {
        sonHataMesaji: err.message,
        sonDenemeZamani: simdi,
      });
      basarisiz.push({ text: row.text, hata: err.message });
    }
  });

  var bloklar = [];
  if (basarili.length > 0) {
    bloklar.push(
      "✅ " +
        basarili.length +
        " mesaj başarıyla işlendi:\n" +
        basarili
          .map(function (b, i) {
            return i + 1 + ". " + b.text + "\n   " + b.cevap;
          })
          .join("\n\n"),
    );
  }
  if (basarisiz.length > 0) {
    bloklar.push(
      "❌ " +
        basarisiz.length +
        " mesaj hâlâ başarısız, PES_EDILDI'de kaldı:\n" +
        basarisiz
          .map(function (b, i) {
            return i + 1 + ". " + b.text + "\n   Hata: " + b.hata;
          })
          .join("\n\n"),
    );
  }
  return bloklar.join("\n\n");
}

// ============================================================================
// Geliştirici yardımcı fonksiyonu (webhookDurumu() deseniyle tutarlı, elle çalıştırılır)
// ============================================================================

/**
 * Kuyruğun anlık retry durumunu özetler: kaç satır BEKLIYOR/ISLENIYOR/
 * PES_EDILDI/TAMAMLANDI (toplam mesaj sayısı DEĞİL, sadece durum dolu olan
 * retry-takipli satırlar), en eski `ilk_hata_zamani` kaç saat önce, kaç
 * trigger kayıtlı. `pesEdilen` satırlar ASLA otomatik temizlenmez (bkz.
 * eskiKayitlariTemizle_) — bu sayı > 0 ise kullanıcının Sheets'te elle
 * kaydetmesi gereken, sistemin işleyemediği harcama(lar) olduğu anlamına
 * gelir. `isleniyor` sayısının bir tarama sürmüyorken > 0 görünmesi, önceki
 * bir execution'ın ortasında kesintiye uğrayıp satırın ISLENIYOR'da takılı
 * kaldığına işaret edebilir (periyodik bir self-heal YOK, bkz. dosya başı
 * yorum) — bu durumda satır elle BEKLIYOR'a çekilip trigger yeniden
 * kurulmalıdır (silinmemeli).
 * @return {Object}
 */
function yenidenDenemeKuyruguDurumu() {
  var sheet = getOrCreateQueueSheet_();
  var simdi = new Date();
  var satirlar = kuyrukTumSatirlariOku_(sheet).filter(function (r) {
    return r.durum; // sadece retry-takipli (durum dolu) satırlar
  });

  var bekleyen = satirlar.filter(function (r) {
    return r.durum === RETRY_DURUM.BEKLIYOR;
  });
  var isleniyor = satirlar.filter(function (r) {
    return r.durum === RETRY_DURUM.ISLENIYOR;
  });
  var pesEdilen = satirlar.filter(function (r) {
    return r.durum === RETRY_DURUM.PES_EDILDI;
  });
  var tamamlanan = satirlar.filter(function (r) {
    return r.durum === RETRY_DURUM.TAMAMLANDI;
  });

  var enEskiMs = satirlar.reduce(function (acc, r) {
    var t =
      r.ilkHataZamani instanceof Date
        ? r.ilkHataZamani.getTime()
        : new Date(r.ilkHataZamani).getTime();
    return acc === null || t < acc ? t : acc;
  }, null);

  var kayitliTriggerSayisi = ScriptApp.getProjectTriggers().filter(
    function (t) {
      return t.getHandlerFunction() === RETRY_HANDLER_FN_ADI;
    },
  ).length;

  var ozet = {
    retryTakipliSatir: satirlar.length,
    bekleyen: bekleyen.length,
    isleniyor: isleniyor.length,
    pesEdilen: pesEdilen.length,
    tamamlanan: tamamlanan.length,
    enEskiIlkHataSaatOnce:
      enEskiMs === null
        ? null
        : Math.round((simdi.getTime() - enEskiMs) / 3600000),
    kayitliTriggerSayisi: kayitliTriggerSayisi,
  };
  Logger.log(JSON.stringify(ozet));
  return ozet;
}
