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
 * **A:D kolonları (update_id/chat_id/text/date) Fitness'in okuduğu SABİT
 * sözleşmedir — bunlara ASLA dokunulmaz/yeniden sıralanmaz.** E:K kolonları
 * (2026-09-26'da eklendi) gider-isleyici'nin KENDİ retry bookkeeping'idir
 * (bkz. Retry.js) — Fitness bunları hiç okumaz/kullanmaz, sadece kuyrugaEkle_
 * her mesaj için A:D'yi doldurup E:K'yı boş bırakır; bir mesaj Gemini'de
 * başarısız olursa Retry.js AYNI satırı update_id ile bulup E:K'yı sonradan
 * doldurur (yeni bir satır EKLEMEZ). Bu yüzden bu sekmedeki HER satır bir
 * retry-takip kaydı DEĞİLDİR — durum (E) sütunu boşsa o mesaj ya normal
 * işlendi ya da hiç Gemini'ye gitmedi (komut vb.).
 *
 * İlgili diğer dosyalar:
 *   - Expenses.js: getTargetSpreadsheet_ (test/prod spreadsheet seçimi, kuyruk da aynı spreadsheet'i kullanır)
 *   - Main.js: doPost, mesaj başarıyla parse edildikten sonra kuyrugaEkle_ çağrılır
 *   - Retry.js: aynı sekmenin E:K kolonlarını okuyup güncelleyen retry mantığı
 */

/** Kuyruk sekmesinin adı — Fitness projesindeki QUEUE_SHEET_ADI ile birebir aynı olmalı. */
const QUEUE_SHEET_NAME = "telegram_queue";

/**
 * Kuyruk sekmesi başlık satırı. İlk 4 kolon (A:D) Fitness'in okuduğu SABİT
 * sözleşme — sırası/isimleri değiştirilmez. Kalan 7 kolon (E:K) gider-isleyici'nin
 * kendi retry bookkeeping'i (bkz. Retry.js > RETRY_DURUM ve ilgili fonksiyonlar);
 * Fitness bunları görmezden gelir.
 */
const QUEUE_HEADERS = [
  "update_id",
  "chat_id",
  "text",
  "date",
  "durum",
  "deneme_asamasi",
  "sonraki_deneme_zamani",
  "ilk_hata_zamani",
  "son_deneme_zamani",
  "son_hata_mesaji",
  "trigger_id",
  "message_id",
];

/**
 * Kuyruk sekmesini döndürür, yoksa başlık satırıyla birlikte oluşturur.
 * Kuyruk, harcama tablosuyla AYNI spreadsheet'te (getTargetSpreadsheet_,
 * bkz. Expenses.js) ayrı bir sekme olarak tutulur — yeni bir kaynak
 * oluşturup paylaşmaya gerek kalmaz, test/prod ayrımı da otomatik miras alınır.
 *
 * Sekme zaten (retry kolonları eklenmeden ÖNCEKİ, 4 kolonlu haliyle) mevcutsa
 * başlık satırı E:K ile SESSİZCE genişletilir (tek seferlik, idempotent
 * göç) — A:D'deki mevcut verilere hiç dokunulmaz.
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getOrCreateQueueSheet_() {
  var spreadsheet = getTargetSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(QUEUE_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(QUEUE_SHEET_NAME);
    sheet.appendRow(QUEUE_HEADERS);
    log_("kuyruk.sekme-olusturuldu", QUEUE_SHEET_NAME);
    return sheet;
  }

  var mevcutKolonSayisi = sheet.getLastColumn();
  if (mevcutKolonSayisi < QUEUE_HEADERS.length) {
    sheet
      .getRange(1, mevcutKolonSayisi + 1, 1, QUEUE_HEADERS.length - mevcutKolonSayisi)
      .setValues([QUEUE_HEADERS.slice(mevcutKolonSayisi)]);
    log_("kuyruk.basliklar-genisletildi", {
      eskiKolonSayisi: mevcutKolonSayisi,
      yeniKolonSayisi: QUEUE_HEADERS.length,
    });
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
 *
 * Bu çağrı SADECE A:D'yi doldurur (E:K, yani retry bookkeeping, bilerek boş
 * bırakılır) — mesaj Gemini'de başarısız olursa Retry.js bu AYNI satırı
 * update_id ile bulup E:K'yı sonradan doldurur, yeni bir satır EKLEMEZ.
 * `messageId` (Telegram `update.message.message_id` — `update_id`'den FARKLI
 * bir alan) ayrıca L kolonuna yazılır; `/sonmesajisil` komutunun Telegram
 * `deleteMessage` çağrısı için gerekir (bkz. retry/RetryCommands.js >
 * sonMesajiSil_). A:D'nin `appendRow` ile yazılma şekli DEĞİŞMEDİ — L kolonu
 * ayrı bir `setValue` ile doldurulur, Fitness'in A:D sözleşmesini etkilemez.
 *
 * Satır eklendikten sonra `retry/RetryCore.js > bakimYapKilitli_` çağrılır —
 * bu, hem `RETRY_TEMIZLIK_ESIK_MS`'i aşan (ve retry'a hiç girmemiş/TAMAMLANDI)
 * satırların FIFO temizliğinin HEM de sahipsiz kalmış (artık hiçbir satırın
 * işaret etmediği) trigger'ların temizliğinin HER mesajda bir fırsat
 * bulmasını sağlar. Aksi halde bu bakım SADECE bir Gemini hatası olduğunda
 * tetiklenirdi — Gemini hiç hata vermezse hiç çalışmazdı (2026-09-26/
 * 2026-09-29 kararları, bkz. RetryCore.js dosya başı yorumu).
 * @param {number} updateId
 * @param {number|string} chatId
 * @param {string} text
 * @param {number} dateSaniye Telegram update.message.date (Unix saniye).
 * @param {number} [messageId] Telegram update.message.message_id.
 */
function kuyrugaEkle_(updateId, chatId, text, dateSaniye, messageId) {
  try {
    var sheet = getOrCreateQueueSheet_();
    sheet.appendRow([updateId, chatId, text, new Date(dateSaniye * 1000)]);
    if (messageId !== undefined && messageId !== null) {
      sheet.getRange(sheet.getLastRow(), QUEUE_HEADERS.length).setValue(messageId);
    }
    log_("kuyruk.eklendi", { updateId: updateId });
    bakimYapKilitli_(sheet);
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
