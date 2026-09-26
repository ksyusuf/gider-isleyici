/**
 * ============================================================================
 * Gider İşleyici — Ortak Loglama
 * ============================================================================
 * Tüm dosyaların (Main.js, Gemini.js, Telegram.js, Queue.js, retry/*) kullandığı
 * cross-cutting log yardımcıları. Apps Script'te tüm proje dosyaları aynı
 * global scope'u paylaştığı için ayrı bir dosyada tutulması diğer dosyaların
 * bunu "import" etmesini gerektirmez — sadece bu iki fonksiyonun tek bir
 * yerde yaşamasını sağlar.
 */

/** Tek bir log satırının en fazla kaç karakter basılacağı. */
const LOG_MAX_UZUNLUK = 1500;

/**
 * Cloud günlüklerinde greplenebilir tek biçimli log satırı: `[etiket] gövde`.
 *
 * Anonim Web App execution'larında bile Apps Script > Executions altında
 * görünür. Uzun gövdeler kısaltılır ki tek bir devasa satır logu boğmasın.
 *
 * GÜVENLİK: Sır asla loglanmaz. Özellikle Gemini istek URL'i API key içerdiği
 * için hiçbir zaman basılmaz; Telegram URL'i de bot token içerir.
 *
 * @param {string} etiket Nokta ile ayrılmış kısa yol, ör. "doPost.mesaj".
 * @param {*} [veri] Metin ya da JSON'a çevrilebilir herhangi bir değer.
 */
function log_(etiket, veri) {
  var govde = "";
  if (veri !== undefined) {
    try {
      govde = typeof veri === "string" ? veri : JSON.stringify(veri);
    } catch (err) {
      govde = "<serileştirilemedi: " + err.message + ">";
    }
    if (govde === undefined || govde === null) {
      govde = String(veri);
    }
    if (govde.length > LOG_MAX_UZUNLUK) {
      govde =
        govde.slice(0, LOG_MAX_UZUNLUK) +
        "... [kısaltıldı, toplam " +
        govde.length +
        " karakter]";
    }
  }

  console.log(govde ? "[" + etiket + "] " + govde : "[" + etiket + "]");
}

/**
 * Hatayı stack trace'iyle birlikte basar. `console.error(err)` tek başına
 * Cloud günlüklerinde çoğu zaman sadece "[object Object]" gösteriyor.
 * @param {string} etiket
 * @param {*} err
 */
function logHata_(etiket, err) {
  var detay = err && err.stack ? err.stack : String(err);
  console.error("[" + etiket + "] " + detay);
}
