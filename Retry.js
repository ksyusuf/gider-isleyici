/**
 * ============================================================================
 * Gider İşleyici — Gemini Geçici/Kalıcı Hatalarında Katman 2: Mesaj Bazlı
 * Tekrar Deneme (Trigger Zinciri)
 * ============================================================================
 * Main.js > callGeminiIleTekrarDeneme_ (Katman 1) bir mesaj için art arda
 * GEMINI_MAX_DENEME kez denendiği halde GEÇİCİ bir hatayla (503, ağ hatası,
 * boş yanıt vb.) başarısız kalırsa, mesaj burada tanımlı `yeniden_deneme_kuyrugu`
 * sekmesine yazılır ve o mesaja özel, TEK SEFERLİK bir Apps Script trigger
 * kurulur (ilk kez 1 saat sonrasına). Trigger ateşlendiğinde yine Katman 1
 * (3 hızlı deneme) çalışır; yine geçici bir hatayla başarısız olursa BİR
 * SONRAKİ AŞAMA için yeni bir tek seferlik trigger kurulur. Aşama gecikmeleri
 * RETRY_BACKOFF_SAAT: 1-1-2-2-4 saat (toplam ~10 saat, 5 aşama). Son (5.)
 * aşama da başarısız olursa sistem PES EDER — 6. bir trigger KURULMAZ, satır
 * `PES_EDILDI` durumuna işaretlenir (ASLA silinmez) ve kullanıcıya hem bu
 * mesaj için hem de kuyrukta biriken diğer pes-edilmiş mesajlar için toplu
 * bir bildirim gönderilir. Kalıcı bir HTTP hatası (400/401/403/404 — Main.js
 * > GEMINI_KALICI_HTTP_KODLARI) alınırsa hiç retry denenmeden aynı PES_EDILDI
 * yoluna girilir (bkz. pesEdildiKuyruguEkleVeBildir_). Gemini'nin "model şu an
 * yüksek talepte" (`error.status: "UNAVAILABLE"`) yanıtı özel olarak
 * tanınır (Main.js > hataYuksekTalepMi_): sebep zaten bilindiği için Katman
 * 1'in hızlı denemeleri boşuna harcanmaz, doğrudan Katman 2'ye (bu dosya)
 * geçilir.
 *
 * KASITLI OLARAK sürekli/periyodik bir trigger YOK — her trigger, bir mesajın
 * gerçekten başarısız kalmasının doğal bir sonucu olarak kurulur (kullanıcı
 * kararı). Bunun bedeli: `yeniden_deneme_kuyrugu` sekmesindeki 5 günden eski
 * satırları temizleyen FIFO mekanizması da (eskiKayitlariTemizle_) ayrı bir
 * trigger yerine, zaten var olan giriş noktalarına ucuz bir ilk-adım olarak
 * eklendi. **FIFO SADECE `TAMAMLANDI` durumundaki satırları siler** —
 * `BEKLIYOR`/`ISLENIYOR` hâlâ aktif bir işi, `PES_EDILDI` ise kullanıcının
 * kaydetmesi gereken bir harcamayı temsil eder; ikisi de yaşı ne olursa
 * olsun ASLA otomatik silinmez (kullanıcı kararı — bir harcamayı sessizce
 * unutmak/kaybetmek kabul edilemez). Başarıyla işlenen bir satır bu yüzden
 * hemen silinmez, `TAMAMLANDI`'ya geçer ve ancak 5 gün sonra temizlenir.
 *
 * `telegram_queue` sekmesiyle (Queue.js, Fitness projesiyle paylaşılan) HİÇBİR
 * ilişkisi yoktur — bu dosya tamamen ayrı, yeni bir sekme (`yeniden_deneme_kuyrugu`)
 * kullanır ve Queue.js'e hiç dokunmaz.
 *
 * İlgili diğer dosyalar:
 *   - Main.js: callGeminiIleTekrarDeneme_ / hataGeciciMi_ / mesajiIsleVeYanitla_ /
 *     doPost (geçici hatada yenidenDenemeKuyruguEkle_'yi, kalıcı hatada
 *     pesEdildiKuyruguEkleVeBildir_'i çağırır)
 *   - Expenses.js: getTargetSpreadsheet_ (kuyruk da aynı spreadsheet'i kullanır)
 */

// ============================================================================
// Sabitler
// ============================================================================

/** Kuyruk sekmesinin adı — telegram_queue'dan tamamen bağımsız, yeni bir sekme. */
const RETRY_SHEET_NAME = "yeniden_deneme_kuyrugu";

/** Kuyruk sekmesi başlık satırı (kolon sırası satırGuncelle_/okuma ile birebir eşleşmeli). */
const RETRY_HEADERS = [
  "update_id",
  "chat_id",
  "text",
  "mesaj_tarihi",
  "durum",
  "deneme_asamasi",
  "sonraki_deneme_zamani",
  "ilk_hata_zamani",
  "son_deneme_zamani",
  "son_hata_mesaji",
  "trigger_id",
];

const RETRY_DURUM = {
  BEKLIYOR: "BEKLIYOR", // bir trigger'ı var, vakti geldiğinde işlenecek
  ISLENIYOR: "ISLENIYOR", // şu an bir trigger tarafından işleniyor (çok kısa ömürlü ara durum)
  PES_EDILDI: "PES_EDILDI", // tüm aşamalar (ya da kalıcı hata) tükendi, retry durduruldu — ASLA SİLİNMEZ
  TAMAMLANDI: "TAMAMLANDI", // gecikmeli de olsa başarıyla işlendi — SADECE bu durum FIFO ile silinebilir
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

/** FIFO temizlik eşiği: ilk_hata_zamani'ndan itibaren bu süreyi aşan satırlar silinir. */
const RETRY_TEMIZLIK_ESIK_MS = 5 * 24 * 60 * 60 * 1000; // 5 gün

// ============================================================================
// Sheets erişim yardımcıları
// ============================================================================

/**
 * Kuyruk sekmesini döndürür, yoksa başlık satırıyla birlikte oluşturur. Harcama
 * tablosuyla AYNI spreadsheet'te (getTargetSpreadsheet_, bkz. Expenses.js) ayrı
 * bir sekme olarak tutulur.
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getOrCreateRetrySheet_() {
  var spreadsheet = getTargetSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(RETRY_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(RETRY_SHEET_NAME);
    sheet.appendRow(RETRY_HEADERS);
    log_("yenidenDeneme.sekme-olusturuldu", RETRY_SHEET_NAME);
  }
  return sheet;
}

/**
 * 2. satırdan itibaren tüm veri satırlarını okur, her birini RETRY_HEADERS
 * sırasıyla eşleşen alan adlarıyla bir nesneye çevirir. `satirNo` 1-indeksli
 * gerçek sheet satır numarasıdır (güncelleme/silme için gerekli).
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {Array<Object>}
 */
function retryTumSatirlariOku_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }
  var degerler = sheet
    .getRange(2, 1, lastRow - 1, RETRY_HEADERS.length)
    .getValues();
  return degerler.map(function (row, i) {
    return {
      satirNo: i + 2,
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
  });
}

/**
 * `row` nesnesini (retryTumSatirlariOku_'dan) `alanlar` ile birleştirip TEK bir
 * setValues çağrısıyla ilgili satırı günceller — sadece değişen alanları
 * belirtmek yeterli, diğerleri `row`'daki mevcut değerleriyle korunur.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Object} row retryTumSatirlariOku_'dan gelen satır nesnesi.
 * @param {Object} alanlar Güncellenecek alanlar (kısmi).
 */
function satiriGuncelle_(sheet, row, alanlar) {
  var guncel = Object.assign({}, row, alanlar);
  sheet
    .getRange(row.satirNo, 1, 1, RETRY_HEADERS.length)
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
 * Bir satırı PES_EDILDI durumuna işaretler (silmez, trigger_id temizlenir —
 * artık kurulu bir trigger'ı yok).
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
 * `ilk_hata_zamani`'ndan itibaren RETRY_TEMIZLIK_ESIK_MS'i (5 gün) aşan
 * satırları siler — AMA SADECE `durum=TAMAMLANDI` olanları. `BEKLIYOR` ve
 * `ISLENIYOR` hâlâ devam eden aktif bir işi temsil eder, `PES_EDILDI` ise
 * kullanıcının haberdar olması gereken, hiçbir yere kaydedilmemiş bir
 * harcamadır — ikisi de yaşı ne olursa olsun ASLA otomatik silinmez, aksi
 * halde bir harcama sessizce unutulmuş/kaybedilmiş olur (kullanıcı kararı).
 * Yalnızca gecikmeli de olsa başarıyla işlenip TAMAMLANDI'ya geçmiş satırlar
 * (bkz. zamanlanmisTekrarDenemeyiIsle) zaman aşımıyla temizlenmeye uygundur.
 *
 * Ayrı bir periyodik trigger YOK (kullanıcı kararı); bu yüzden bu fonksiyon
 * zaten var olan giriş noktalarının (yenidenDenemeKuyruguEkle_,
 * pesEdildiKuyruguEkleVeBildir_, zamanlanmisTekrarDenemeyiIsle) başında ucuz
 * bir ilk-adım olarak çağrılır.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Date} simdi
 */
function eskiKayitlariTemizle_(sheet, simdi) {
  var satirlar = retryTumSatirlariOku_(sheet);
  var silinecekler = satirlar
    .filter(function (row) {
      if (row.durum !== RETRY_DURUM.TAMAMLANDI) {
        return false;
      }
      var ilkHataMs =
        row.ilkHataZamani instanceof Date
          ? row.ilkHataZamani.getTime()
          : new Date(row.ilkHataZamani).getTime();
      return simdi.getTime() - ilkHataMs > RETRY_TEMIZLIK_ESIK_MS;
    })
    .sort(function (a, b) {
      return b.satirNo - a.satirNo; // azalan sırayla sil, index kaymasını önler
    });

  silinecekler.forEach(function (row) {
    log_("yenidenDeneme.fifo-temizlik", {
      updateId: row.updateId,
      satirNo: row.satirNo,
    });
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
 * `doPost` tarafından çağrılır: mesajı kuyruğa yazar ve 1 saat sonrasına ilk
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
    var sheet = getOrCreateRetrySheet_();
    var simdi = new Date();
    eskiKayitlariTemizle_(sheet, simdi);

    var ilkAsama = 1;
    var gecikmeSaat = sonrakiGecikmeSaat_(ilkAsama);
    var triggerId = zamanliTetikleyiciKur_(gecikmeSaat);
    var sonrakiDenemeZamani = new Date(
      simdi.getTime() + gecikmeSaat * 60 * 60 * 1000,
    );

    sheet.appendRow([
      updateId,
      chatId,
      text,
      new Date(mesajTarihiSaniye * 1000),
      RETRY_DURUM.BEKLIYOR,
      ilkAsama,
      sonrakiDenemeZamani,
      simdi,
      simdi,
      hataMesaji,
      triggerId,
    ]);
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
 * tarafından çağrılır: hiç retry denenmeden satır doğrudan PES_EDILDI olarak
 * kuyruğa yazılır ve kullanıcıya bildirim gönderilir.
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
  var sheet, yeniSatirNo;
  try {
    sheet = getOrCreateRetrySheet_();
    var simdi = new Date();
    eskiKayitlariTemizle_(sheet, simdi);

    sheet.appendRow([
      updateId,
      chatId,
      text,
      new Date(mesajTarihiSaniye * 1000),
      RETRY_DURUM.PES_EDILDI,
      0,
      "",
      simdi,
      simdi,
      hataMesaji,
      "",
    ]);
    yeniSatirNo = sheet.getLastRow();
    log_("yenidenDeneme.kalici-hata-kuyruklandi", {
      updateId: updateId,
      satirNo: yeniSatirNo,
    });
  } finally {
    lock.releaseLock();
  }

  // Telegram gönderimi kilit DIŞINDA yapılır (ağ çağrısı kilit altında tutulmaz).
  pesEdildiBildirimGonder_(sheet, chatId, text, hataMesaji, yeniSatirNo);
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

  var digerPesEdilenler = retryTumSatirlariOku_(sheet).filter(function (row) {
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
 *   - Başarılı → "gecikmeli işlendi" notuyla Telegram'a gönderilir, satır silinir.
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
    sheet = getOrCreateRetrySheet_();
    var simdiClaim = new Date();
    eskiKayitlariTemizle_(sheet, simdiClaim);

    var tumSatirlar = retryTumSatirlariOku_(sheet);
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
      // temizliği (eskiKayitlariTemizle_) bu durumdaki satırları kaldırır.
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
// ve `/pesedilenleridene` komutlarının karşılığı)
// ============================================================================

/**
 * `/pesedilenler` komutunun çıktısı: kuyruktaki TÜM `PES_EDILDI` satırlarını
 * (otomatik tekrar denemesi tükenmiş/kalıcı hatayla başarısız kalmış mesajlar)
 * okunabilir bir listeye çevirir. Gemini'ye hiç gitmez, tamamen deterministik.
 * @return {string}
 */
function pesEdilenleriListele_() {
  var sheet = getOrCreateRetrySheet_();
  var simdi = new Date();
  var pesEdilenler = retryTumSatirlariOku_(sheet).filter(function (row) {
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
    " pes edilmiş mesaj var — /pesedilenleridene ile topluca tekrar deneyebilirsin:\n\n" +
    satirlar.join("\n\n")
  );
}

/**
 * `/pesedilenleridene` komutunun çıktısı: kuyruktaki TÜM `PES_EDILDI`
 * satırlarını, her biri için Katman 1'i (callGeminiIleTekrarDeneme_, en fazla
 * GEMINI_MAX_DENEME hızlı deneme) kullanarak ŞİMDİ topluca tekrar dener.
 * Katman 2'ye (yeni trigger kurma) HİÇ girmez — bu SADECE anlık, manuel bir
 * deneme; hâlâ başarısız kalanlar PES_EDILDI'de kalır (silinmez), sadece
 * `son_hata_mesaji`/`son_deneme_zamani` güncellenir. Başarılı olanlar
 * otomatik akışla simetrik şekilde TAMAMLANDI'ya geçer (hemen silinmez,
 * 5 günlük FIFO'ya bırakılır) — bkz. eskiKayitlariTemizle_.
 * @return {string} Kullanıcıya gösterilecek özet.
 */
function pesEdilenleriTekrarDene_() {
  var sheet = getOrCreateRetrySheet_();
  var pesEdilenler = retryTumSatirlariOku_(sheet)
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
 * Kuyruğun anlık durumunu özetler: kaç satır BEKLIYOR/ISLENIYOR/PES_EDILDI/
 * TAMAMLANDI, en eski `ilk_hata_zamani` kaç saat önce, kaç trigger kayıtlı.
 * `pesEdilen` satırlar ASLA otomatik silinmez (bkz. eskiKayitlariTemizle_) —
 * bu sayı > 0 ise kullanıcının Sheets'te elle kaydetmesi gereken, sistemin
 * işleyemediği harcama(lar) olduğu anlamına gelir. `isleniyor` sayısının bir
 * tarama sürmüyorken > 0 görünmesi, önceki bir execution'ın ortasında
 * kesintiye uğrayıp satırın ISLENIYOR'da takılı kaldığına işaret edebilir
 * (periyodik bir self-heal YOK, bkz. dosya başı yorum) — bu durumda satır
 * elle BEKLIYOR'a çekilip trigger yeniden kurulmalıdır (silinmemeli).
 * @return {Object}
 */
function yenidenDenemeKuyruguDurumu() {
  var sheet = getOrCreateRetrySheet_();
  var simdi = new Date();
  var satirlar = retryTumSatirlariOku_(sheet);

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
    toplamSatir: satirlar.length,
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
