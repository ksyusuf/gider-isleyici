/**
 * ============================================================================
 * Gider İşleyici — Harcama Verisi: Sheets Erişimi ve İş Mantığı
 * ============================================================================
 * Google Sheets D:I sütunlarına (TARİH, TUTAR, FİRMA, TÜR, MALZEME, AÇIKLAMA)
 * okuma/yazma yapan yardımcı fonksiyonlar ve Gemini'nin çağıracağı asıl iş
 * mantığı fonksiyonları (harcamaEkle, sonHarcamalariGetir, sonHarcamalariTopla)
 * burada tutulur.
 *
 * İlgili diğer dosyalar:
 *   - Config.js: CONFIG, SHEET_LAYOUT, TOOLS (Gemini function declarations)
 *   - Main.js: Gemini/Telegram entegrasyonu, doPost giriş noktası, FUNCTION_MAP
 */

// ============================================================================
// Sheets erişim yardımcıları
// ============================================================================

/**
 * Hedef spreadsheet'i döndürür. Test modunda (Script Properties: TEST_MODE=true)
 * prod tabloya dokunmamak için ayrı bir test spreadsheet ID'si kullanılır.
 * @return {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function getTargetSpreadsheet_() {
  if (CONFIG.testMode) {
    if (!CONFIG.testSpreadsheetId) {
      throw new Error(
        "TEST_MODE aktif ama Script Properties içinde TEST_SPREADSHEET_ID tanımlı değil.",
      );
    }
    return SpreadsheetApp.openById(CONFIG.testSpreadsheetId);
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * Hedef sayfayı (tab) döndürür. CONFIG.sheetName boşsa ilk sayfa kullanılır.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} spreadsheet
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getTargetSheet_(spreadsheet) {
  if (CONFIG.sheetName) {
    var sheet = spreadsheet.getSheetByName(CONFIG.sheetName);
    if (!sheet) {
      throw new Error(
        "'" + CONFIG.sheetName + "' adında bir sayfa bulunamadı.",
      );
    }
    return sheet;
  }
  return spreadsheet.getSheets()[0];
}

/**
 * SHEET_LAYOUT.START_ROW'dan başlayarak TARİH sütununda ilk boş satırı bulur.
 * Orijinal Sheets REST API'nin "append" davranışının yerel karşılığıdır.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {number} 1-indeksli satır numarası
 */
function findNextDataRow_(sheet) {
  var startRow = SHEET_LAYOUT.START_ROW;
  var lastRow = sheet.getLastRow();
  if (lastRow < startRow) {
    return startRow;
  }
  var values = sheet
    .getRange(startRow, SHEET_LAYOUT.START_COL, lastRow - startRow + 1, 1)
    .getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === "" || values[i][0] === null) {
      return startRow + i;
    }
  }
  return lastRow + 1;
}

/**
 * SHEET_LAYOUT.START_ROW'dan lastRow'a kadar olan veri bloğunu TARİH sütununa
 * göre azalan sıralar (orijinal Python akışındaki sortRange batchUpdate'in karşılığı).
 * En güncel tarih her zaman en üstte kalır.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} lastRow
 */
function sortByDateDescending_(sheet, lastRow) {
  var startRow = SHEET_LAYOUT.START_ROW;
  if (lastRow <= startRow) {
    return;
  }
  var numCols = Math.max(
    sheet.getLastColumn(),
    SHEET_LAYOUT.START_COL + SHEET_LAYOUT.NUM_COLS - 1,
  );
  var range = sheet.getRange(startRow, 1, lastRow - startRow + 1, numCols);
  range.sort({ column: SHEET_LAYOUT.START_COL, ascending: false });
}

/**
 * "YYYY-MM-DD" metnini yerel bir Date nesnesine çevirir. Öğlen saatine (12:00)
 * sabitlenir; bunun nedeni, gece yarısına yakın saatlerde olası DST/UTC
 * kaymasının tarihi bir gün geriye/ileriye kaydırmasını önlemektir.
 * @param {string} tarihStr "YYYY-MM-DD" formatında ya da boş.
 * @return {Date}
 */
function parseTarih_(tarihStr) {
  if (!tarihStr) {
    return new Date();
  }
  var parcalar = tarihStr.split("-");
  if (parcalar.length !== 3) {
    return new Date();
  }
  var yil = parseInt(parcalar[0], 10);
  var ay = parseInt(parcalar[1], 10);
  var gun = parseInt(parcalar[2], 10);
  if (!isFinite(yil) || !isFinite(ay) || !isFinite(gun)) {
    return new Date();
  }
  return new Date(yil, ay - 1, gun, 12, 0, 0);
}

/**
 * Verilen metni kelime kelime baş harfi büyük biçime çevirir (orijinal Python
 * akışındaki .capitalize() davranışının karşılığı).
 * @param {string} text
 * @return {string}
 */
function harfBuyukYap_(text) {
  if (!text) {
    return "";
  }
  return text
    .toString()
    .trim()
    .split(/\s+/)
    .map(function (kelime) {
      return (
        kelime.charAt(0).toLocaleUpperCase("tr") +
        kelime.slice(1).toLocaleLowerCase("tr")
      );
    })
    .join(" ");
}

/**
 * adet parametresini güvenli bir pozitif tam sayıya normalize eder.
 * @param {*} adet
 * @return {number}
 */
function normalizeAdet_(adet) {
  var n = Number(adet);
  if (!isFinite(n) || n <= 0) {
    return 5;
  }
  return Math.floor(n);
}

/**
 * Veri bloğunun en üstünden (en güncel tarihli) en fazla `adet` satırı okur.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} adet
 * @return {Array<Array<*>>}
 */
function readTopRows_(sheet, adet) {
  var startRow = SHEET_LAYOUT.START_ROW;
  var lastRow = sheet.getLastRow();
  if (lastRow < startRow) {
    return [];
  }
  var mevcutSatirSayisi = lastRow - startRow + 1;
  var okunacakSatir = Math.min(adet, mevcutSatirSayisi);
  return sheet
    .getRange(
      startRow,
      SHEET_LAYOUT.START_COL,
      okunacakSatir,
      SHEET_LAYOUT.NUM_COLS,
    )
    .getValues();
}

// ============================================================================
// İş mantığı fonksiyonları
// ============================================================================

/**
 * Yeni bir harcama satırı ekler ve tabloyu tarihe göre azalan sıralar.
 * @param {{tutar:number, kategori:string, aciklama?:string, tarih?:string, firma?:string, malzeme?:string}} args
 * @return {string} Kullanıcıya gösterilecek onay metni.
 */
function harcamaEkle(args) {
  args = args || {};

  var tutar = Number(args.tutar);
  if (!isFinite(tutar) || tutar <= 0) {
    throw new Error("Geçersiz tutar: harcama tutarı pozitif bir sayı olmalı.");
  }

  var kategoriGirdi = (args.kategori || "").toString().trim();
  if (!kategoriGirdi) {
    throw new Error("Kategori/tür bilgisi eksik.");
  }

  var tarihDate = parseTarih_(args.tarih);
  var firma = harfBuyukYap_(args.firma || "");
  var tur = harfBuyukYap_(kategoriGirdi);
  var malzeme = args.malzeme ? harfBuyukYap_(args.malzeme) : "";
  var aciklama = harfBuyukYap_(args.aciklama || "");

  var spreadsheet = getTargetSpreadsheet_();
  var sheet = getTargetSheet_(spreadsheet);
  var hedefSatir = findNextDataRow_(sheet);

  sheet
    .getRange(hedefSatir, SHEET_LAYOUT.START_COL, 1, SHEET_LAYOUT.NUM_COLS)
    .setValues([[tarihDate, tutar, firma, tur, malzeme, aciklama]]);

  var sonSatir = Math.max(sheet.getLastRow(), hedefSatir);
  sortByDateDescending_(sheet, sonSatir);

  var tarihEtiketi = Utilities.formatDate(tarihDate, TIME_ZONE, "dd.MM.yyyy");
  var ozet =
    "✅ " + tutar.toFixed(2) + " TL - " + tur + " (" + tarihEtiketi + ")";
  if (aciklama) {
    ozet += " - " + aciklama;
  }
  return ozet;
}

/**
 * En son eklenen (tablonun en üstündeki) N harcamayı okunabilir metne çevirir.
 * @param {{adet?:number}} args
 * @return {string}
 */
function sonHarcamalariGetir(args) {
  args = args || {};
  var adet = normalizeAdet_(args.adet);

  var spreadsheet = getTargetSpreadsheet_();
  var sheet = getTargetSheet_(spreadsheet);
  var satirlar = readTopRows_(sheet, adet);

  if (satirlar.length === 0) {
    return "Henüz kayıtlı harcama yok.";
  }

  var satirMetinleri = satirlar.map(function (row) {
    var tarih = Utilities.formatDate(new Date(row[0]), TIME_ZONE, "dd.MM.yyyy");
    var tutar = Number(row[1] || 0).toFixed(2);
    var tur = row[3] || "-";
    var aciklama = row[5] || "";
    var satir = "📅 " + tarih + " | 💰 " + tutar + " TL | " + tur;
    if (aciklama) {
      satir += " | " + aciklama;
    }
    return satir;
  });

  return "Son " + satirlar.length + " harcama:\n" + satirMetinleri.join("\n");
}

/**
 * En son eklenen N harcamanın toplam tutarını hesaplar.
 * @param {{adet:number}} args
 * @return {string}
 */
function sonHarcamalariTopla(args) {
  args = args || {};
  var adet = normalizeAdet_(args.adet);

  var spreadsheet = getTargetSpreadsheet_();
  var sheet = getTargetSheet_(spreadsheet);
  var satirlar = readTopRows_(sheet, adet);

  if (satirlar.length === 0) {
    return "Henüz kayıtlı harcama yok.";
  }

  var toplam = satirlar.reduce(function (acc, row) {
    return acc + Number(row[1] || 0);
  }, 0);

  return (
    "Son " +
    satirlar.length +
    " harcamanın toplamı: " +
    toplam.toFixed(2) +
    " TL"
  );
}
