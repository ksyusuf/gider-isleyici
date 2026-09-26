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
 *   - retry/RetryCommands.js: pesEdilenleriListele_ / pesEdilenleriTekrarDene_ (islemKomut_ tarafından çağrılır)
 *   - Main.js: doPost (bu dosyadaki sendTelegramMessage_/islemKomut_/islemSonuclariniBirlestir_'i kullanır)
 */

/**
 * Telegram Bot API sendMessage çağrısı.
 * @param {number|string} chatId
 * @param {string} text
 */
function sendTelegramMessage_(chatId, text) {
  // NOT: `url` bot token içeriyor — asla loglanmaz.
  var url =
    "https://api.telegram.org/bot" + CONFIG.telegramToken + "/sendMessage";
  log_("telegram.gonder", { chatId: chatId, uzunluk: (text || "").length });

  var response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ chat_id: chatId, text: text }),
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
  }
}

/** `/komutlar` çıktısı ve tanınmayan komutlarda gösterilecek ortak liste. */
const KOMUT_LISTESI_METNI = [
  "Kullanılabilir komutlar:",
  "/son [N] — son N harcamayı listeler (belirtilmezse 5).",
  "/toplam [N] — son N harcamanın toplamını hesaplar (belirtilmezse 5).",
  "/pesedilenler — otomatik tekrar denemesi tükenmiş (pes edilmiş) mesajları listeler.",
  "/pesdene — pes edilmiş TÜM mesajları şimdi topluca tekrar dener.",
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
 * @return {string} Telegram'a gönderilecek yanıt.
 */
function islemKomut_(text) {
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
