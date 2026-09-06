/**
 * ============================================================================
 * Gider İşleyici — Telegram Mesaj Kuyruğu (Fitness projesi için köprü)
 * ============================================================================
 * Bu bot Fitness adlı ayrı bir Apps Script projesiyle AYNI Telegram botunu
 * paylaşıyor. Telegram bir bota aynı anda hem webhook hem getUpdates polling
 * kullanılmasına izin vermiyor ("This method will not work if an outgoing
 * webhook is set up") — bu webhook burada aktif olduğu için Fitness'in kendi
 * getUpdates çağrısı hep sessizce boş dönüyordu (json.ok:false, hata logu
 * bile yok), yani Fitness'e yönelik mesajlar hiç işlenmemiş gibi kayboluyordu.
 *
 * Çözüm: gider-isleyici'nin webhook'u Telegram'ın TEK tüketicisi kalır; her
 * gelen mesajı (konu — harcama/spor/vs. — fark etmeksizin) ham olarak bu
 * dosyadaki kuyruk sekmesine yazar. Fitness kendi tetikleyicisinde Telegram
 * yerine bu sekmeyi okur, kendi mevcut update_id cursor + today/yesterday/
 * stale etiketleme mantığı hiç değişmeden (bkz. Fitness/durumYonetimi.js >
 * yeniTelegramMesajlariniGetir).
 *
 * İlgili diğer dosyalar:
 *   - Expenses.js: getTargetSpreadsheet_ (test/prod spreadsheet seçimi, kuyruk da aynı spreadsheet'i kullanır)
 *   - Main.js: doPost, mesaj başarıyla parse edildikten sonra kuyrugaEkle_ çağrılır
 */

/** Kuyruk sekmesinin adı — Fitness projesindeki QUEUE_SHEET_ADI ile birebir aynı olmalı. */
const QUEUE_SHEET_NAME = "telegram_queue";

/** Kuyruk sekmesi başlık satırı. */
const QUEUE_HEADERS = ["update_id", "chat_id", "text", "date"];

/**
 * Kuyruk sekmesini döndürür, yoksa başlık satırıyla birlikte oluşturur.
 * Kuyruk, harcama tablosuyla AYNI spreadsheet'te (getTargetSpreadsheet_,
 * bkz. Expenses.js) ayrı bir sekme olarak tutulur — yeni bir kaynak
 * oluşturup paylaşmaya gerek kalmaz, test/prod ayrımı da otomatik miras alınır.
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getOrCreateQueueSheet_() {
  var spreadsheet = getTargetSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(QUEUE_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(QUEUE_SHEET_NAME);
    sheet.appendRow(QUEUE_HEADERS);
    log_("kuyruk.sekme-olusturuldu", QUEUE_SHEET_NAME);
  }
  return sheet;
}

/**
 * Gelen bir Telegram mesajını, konusu (harcama/spor/vs.) fark etmeksizin ham
 * olarak kuyruk sekmesine ekler. Hiçbir sınıflandırma/filtreleme yapılmaz —
 * Fitness projesi kendi mevcut off/blok filtresiyle (tekMesajiIsle) kendine
 * ait olmayan mesajları zaten sessizce eliyor.
 *
 * Hata durumunda ana harcama akışını (Gemini çağrısı, Telegram cevabı) ASLA
 * bozmaz — sadece loglanır. Kuyruk yazımı bu proje için yan etkidir, kritik
 * değildir; doPost'un kendi işini tamamlaması her zaman önceliklidir.
 * @param {number} updateId
 * @param {number|string} chatId
 * @param {string} text
 * @param {number} dateSaniye Telegram update.message.date (Unix saniye).
 */
function kuyrugaEkle_(updateId, chatId, text, dateSaniye) {
  try {
    var sheet = getOrCreateQueueSheet_();
    sheet.appendRow([updateId, chatId, text, new Date(dateSaniye * 1000)]);
    log_("kuyruk.eklendi", { updateId: updateId });
  } catch (err) {
    logHata_("kuyruk.HATA", err);
  }
}

/**
 * Geliştirici yardımcı fonksiyonu: bu spreadsheet container-bound olduğu için
 * ID'si kod içinde sabit tutulmuyor. Fitness projesinin Script Properties'ine
 * QUEUE_SPREADSHEET_ID olarak girilmesi gereken değeri loglar — Apps Script
 * editöründen bir kez elle çalıştırıp sonucu kopyalayın.
 * @return {string}
 */
function kuyrukSpreadsheetIdYazdir() {
  var id = getTargetSpreadsheet_().getId();
  Logger.log(id);
  return id;
}
