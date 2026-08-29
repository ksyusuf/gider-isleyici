/**
 * ============================================================================
 * Gider İşleyici — Telegram + Gemini Function Calling Botu (Orkestrasyon)
 * ============================================================================
 * Gemini generateContent REST çağrısı, mesaj zamanına göre dinamik kurulan
 * systemInstruction, Telegram sendMessage/doPost entegrasyonu ve geliştirici
 * yardımcı fonksiyonları (webhook kurulum/kaldırma) burada tutulur.
 *
 * İlgili diğer dosyalar:
 *   - Config.js: CONFIG, SHEET_LAYOUT, TOOLS (Gemini function declarations)
 *   - Expenses.js: Sheets erişim yardımcıları + harcamaEkle / sonHarcamalariGetir / sonHarcamalariTopla
 *
 * Bölümler:
 *   1. FUNCTION_MAP — Gemini fonksiyon adı → gerçek implementasyon eşlemesi
 *   2. Gemini REST entegrasyonu
 *   3. Telegram entegrasyonu (doPost)
 *   4. Geliştirici yardımcı fonksiyonları (webhook kurulum/kaldırma)
 */

// ============================================================================
// 1. FUNCTION_MAP
// ============================================================================

/** Gemini'nin döndürdüğü fonksiyon adını (bkz. Expenses.js) gerçek implementasyona eşler. */
const FUNCTION_MAP = {
  harcamaEkle: harcamaEkle,
  sonHarcamalariGetir: sonHarcamalariGetir,
  sonHarcamalariTopla: sonHarcamalariTopla,
};

// ============================================================================
// 2. Gemini REST entegrasyonu
// ============================================================================

/**
 * Gemini'ye gönderilen systemInstruction şablonu. {ZAMAN_BAGLAMI} her istekte
 * mesajın Telegram'a gönderildiği ana göre doldurulur — göreceli tarih
 * ifadeleri ("dün", "bugün" vb.) script'in çalıştığı ana göre DEĞİL, mesajın
 * gönderildiği ana göre çözülmelidir.
 */
const SYSTEM_INSTRUCTION_TEMPLATE = [
  "Sen bir kişisel harcama takip asistanısın. Kullanıcının Telegram'a Türkçe serbest",
  "metinle yazdığı mesajdan bir veya birden fazla harcama kalemini ayıklayıp, her kalem",
  "için ayrı ayrı harcamaEkle fonksiyonunu çağırırsın. Fonksiyon çağırmıyorsan (ya da bazı",
  "kalemler için çağırmıyorsan) bunun sebebini normal metin yanıtında kullanıcıya Türkçe",
  "ve açık şekilde belirtirsin.",
  "",
  "ZAMAN BAĞLAMI:",
  "{ZAMAN_BAGLAMI}",
  '- "bugün" bu mesajın gönderildiği tarihe karşılık gelir.',
  '- "dün" bu tarihten bir gün öncesine karşılık gelir.',
  '- "önceki gün" / "evvelsi gün" iki gün öncesine karşılık gelir.',
  '- "geçen [gün adı]" (örn. "geçen pazartesi") bu haftadan ÖNCEKİ en yakın o günü ifade eder.',
  '- Sadece "[gün adı]" (örn. yalnızca "pazartesi") bu hafta içindeki ya da en yakın',
  "  geçmişteki o günü ifade eder; bağlamdan hangisi olduğu çıkarılamıyorsa tarihi BELİRSİZ kabul et.",
  '- "X gün önce" mesaj tarihinden X gün geriye gidilerek hesaplanır.',
  "- Kullanıcı hiçbir tarih/zaman ifadesi kullanmamışsa tarih = mesajın gönderildiği tarih",
  "  (bugün) kabul edilir; bu durum belirsizlik SAYILMAZ, açık ve geçerli bir varsayılandır.",
  "- Tüm tarihleri harcamaEkle'ye YYYY-MM-DD formatında, yukarıdaki mesaj tarihine göre",
  '  hesaplanmış mutlak tarih olarak ver (asla "dün" gibi göreceli metin gönderme).',
  "",
  "ÇOKLU HARCAMA:",
  "Tek bir mesaj birden fazla, birbirinden bağımsız harcama içerebilir",
  '(örnek: "dün markette 200 liraya yemek aldım, bugün de otobüse 15 lira verdim").',
  "Böyle durumlarda her harcama kalemi için harcamaEkle fonksiyonunu AYRI AYRI ve",
  "gerekiyorsa aynı yanıt içinde birden fazla kez çağır. Farklı kalemleri tek bir çağrıda",
  "birleştirme, tutarları toplama, kategorileri karıştırma.",
  "",
  "ZORUNLU NETLİK KURALI (çok önemli):",
  "Bir harcama kaleminin TUTAR, TARİH ve TÜR/KATEGORİ bilgisi kesin ve tartışmasız",
  "biçimde belirlenebilir olmalıdır:",
  '- tutar: açık, sayısal bir değer olmalı ("5 tl", "150 lira" gibi). "birkaç lira",',
  '  "epey para harcadım" gibi belirsiz ifadelerde tutarı ASLA tahmin edip uydurma.',
  "- tarih: yukarıdaki ZAMAN BAĞLAMI kurallarıyla netleşmiyorsa (ör. hangi gün olduğu",
  '  belirsiz kalan bir "geçen [gün adı]" ifadesi) ASLA tahmin edip uydurma.',
  '- tür/kategori: metinden makul biçimde çıkarılamıyorsa ("harcama yaptım" gibi) ASLA uydurma.',
  "Bu üç alandan HERHANGİ BİRİ net değilse, O KALEM İÇİN harcamaEkle'yi ÇAĞIRMA. Bunun",
  "yerine metin yanıtında o kalemle ilgili hangi bilginin eksik/belirsiz olduğunu açıkça",
  "belirt, böylece kullanıcı bir sonraki mesajında daha açıklayıcı yazabilsin. Aynı",
  "mesajdaki NET olan diğer kalemleri yine de normal şekilde fonksiyon çağrısıyla ekle —",
  "kısmen ekleme + kısmen netleştirme isteği aynı yanıtta bir arada olabilir.",
  "",
  "AÇIKLAMA (aciklama) ALANI:",
  "tutar/tarih/tür/firma/malzeme alanlarının hiçbirine tam oturmayan ama harcamayla ilgili",
  "olan her bilgiyi (kiminle yapıldığı, kimin için alındığı, ek sebep/not vb.) kısa ve öz",
  "biçimde aciklama alanına yaz. Bu tür bilgiyi asla atma.",
  "",
  "Kesin olmadığın durumlarda tahmin yürütüp fonksiyon çağırmak yerine HER ZAMAN kullanıcıya",
  "açıkça sormayı tercih et.",
].join("\n");

/**
 * Mesajın gönderildiği zamanı Europe/Istanbul diliminde okunabilir bir
 * bağlam cümlesine çevirir.
 * @param {Date} mesajZamani
 * @return {string}
 */
function formatZamanBaglami_(mesajZamani) {
  var etiket = Utilities.formatDate(
    mesajZamani,
    TIME_ZONE,
    "EEEE, dd.MM.yyyy HH:mm",
  );
  return (
    "Bu mesaj " + etiket + " (Europe/Istanbul) tarihinde/saatinde gönderildi."
  );
}

/**
 * SYSTEM_INSTRUCTION_TEMPLATE içindeki {ZAMAN_BAGLAMI} yer tutucusunu doldurur.
 * @param {Date} mesajZamani
 * @return {string}
 */
function buildSystemInstruction_(mesajZamani) {
  return SYSTEM_INSTRUCTION_TEMPLATE.replace(
    "{ZAMAN_BAGLAMI}",
    formatZamanBaglami_(mesajZamani),
  );
}

/**
 * Gemini generateContent REST endpoint'ine tools + systemInstruction ile istek atar.
 * @param {string} userText Kullanıcının Telegram mesaj metni.
 * @param {number} [mesajZamaniSaniye] Telegram update.message.date (Unix saniye).
 *   Verilmezse script'in çalıştığı an kullanılır (yalnızca yedek/geriye dönük durum).
 * @return {Array<Object>} candidates[0].content.parts dizisi.
 */
function callGemini_(userText, mesajZamaniSaniye) {
  var mesajZamani = mesajZamaniSaniye
    ? new Date(mesajZamaniSaniye * 1000)
    : new Date();

  var url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    CONFIG.geminiModel +
    ":generateContent?key=" +
    CONFIG.geminiApiKey;

  var requestBody = {
    contents: [{ role: "user", parts: [{ text: userText }] }],
    tools: [{ functionDeclarations: TOOLS }],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    systemInstruction: {
      role: "system",
      parts: [{ text: buildSystemInstruction_(mesajZamani) }],
    },
  };

  var response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(requestBody),
    muteHttpExceptions: true,
  });

  var statusCode = response.getResponseCode();
  if (statusCode !== 200) {
    throw new Error(
      "Gemini API hatası (HTTP " +
        statusCode +
        "): " +
        response.getContentText(),
    );
  }

  var json = JSON.parse(response.getContentText());
  var candidate = json.candidates && json.candidates[0];
  if (!candidate || !candidate.content || !candidate.content.parts) {
    throw new Error(
      "Gemini API beklenmeyen bir yanıt döndürdü: " + response.getContentText(),
    );
  }

  return candidate.content.parts;
}

// ============================================================================
// 3. Telegram entegrasyonu
// ============================================================================

/**
 * Telegram Bot API sendMessage çağrısı.
 * @param {number|string} chatId
 * @param {string} text
 */
function sendTelegramMessage_(chatId, text) {
  var url =
    "https://api.telegram.org/bot" + CONFIG.telegramToken + "/sendMessage";
  var response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ chat_id: chatId, text: text }),
    muteHttpExceptions: true,
  });
  var statusCode = response.getResponseCode();
  if (statusCode !== 200) {
    console.error(
      "Telegram sendMessage hatası (HTTP " +
        statusCode +
        "): " +
        response.getContentText(),
    );
  }
}

/**
 * Tek bir Gemini functionCall part'ını çalıştırır. Hata durumunda batch'in
 * geri kalanını etkilememesi için hatayı kullanıcıya dönecek bir metne çevirir.
 * @param {{name:string, args:Object}} functionCall
 * @return {string}
 */
function calistirFonksiyon_(functionCall) {
  var fn = FUNCTION_MAP[functionCall.name];
  if (!fn) {
    return "⚠️ Bilinmeyen fonksiyon çağrısı: " + functionCall.name;
  }
  try {
    return fn(functionCall.args || {});
  } catch (err) {
    return (
      "⚠️ '" + functionCall.name + "' işlenirken hata oluştu: " + err.message
    );
  }
}

/**
 * Gemini'den dönen parts dizisini (birden fazla functionCall + opsiyonel bir
 * text part aynı anda bulunabilir) tek bir Telegram mesajına birleştirir.
 * @param {Array<Object>} parts
 * @return {string}
 */
function islemSonuclariniBirlestir_(parts) {
  var fonksiyonSonuclari = [];
  var netlestirmeMetinleri = [];

  parts.forEach(function (part) {
    if (part.functionCall) {
      fonksiyonSonuclari.push(calistirFonksiyon_(part.functionCall));
    } else if (part.text && part.text.trim()) {
      netlestirmeMetinleri.push(part.text.trim());
    }
  });

  var bloklar = [];
  if (fonksiyonSonuclari.length > 0) {
    bloklar.push(fonksiyonSonuclari.join("\n\n"));
  }
  if (netlestirmeMetinleri.length > 0) {
    bloklar.push(
      "❓ Netleştirilmesi gerekenler:\n" + netlestirmeMetinleri.join("\n"),
    );
  }

  if (bloklar.length === 0) {
    return "Anlayamadım, tekrar dener misin?";
  }

  return bloklar.join("\n\n");
}

/**
 * Apps Script Web App POST giriş noktası — Telegram webhook'u buraya bağlanır.
 * @param {GoogleAppsScript.Events.DoPost} e
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function doPost(e) {
  var chatId = null;
  try {
    var update = JSON.parse(e.postData.contents);
    var message = update.message;

    if (!message) {
      // edited_message, channel_post vb. desteklenmeyen güncelleme tipleri sessizce yok sayılır.
      return respondOk_();
    }

    chatId = message.chat && message.chat.id;
    var text = message.text;

    // Güvenlik: CONFIG.chatId tanımlıysa sadece o sohbetten gelen mesajlar işlenir.
    // Web App URL'i herkese açık olduğu için bu, tek kullanıcılık bot için asgari korumadır.
    if (CONFIG.chatId && String(chatId) !== String(CONFIG.chatId)) {
      return respondOk_();
    }

    if (!text) {
      sendTelegramMessage_(
        chatId,
        "Şu an sadece yazılı mesajları anlayabiliyorum. 🙂",
      );
      return respondOk_();
    }

    var parts = callGemini_(text, message.date);
    var cevapMetni = islemSonuclariniBirlestir_(parts);
    sendTelegramMessage_(chatId, cevapMetni);
  } catch (err) {
    console.error(err);
    var hedefChatId = chatId || CONFIG.chatId;
    if (hedefChatId) {
      try {
        sendTelegramMessage_(
          hedefChatId,
          "⚠️ Bir hata oluştu, işlem tamamlanamadı: " + err.message,
        );
      } catch (gonderimHatasi) {
        console.error(
          "Hata mesajı Telegram'a gönderilemedi: " + gonderimHatasi,
        );
      }
    }
  }
  return respondOk_();
}

/**
 * Telegram'ın retry/backoff mekanizmasına girmemesi için doPost her koşulda
 * 200 döner.
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function respondOk_() {
  return ContentService.createTextOutput(
    JSON.stringify({ status: "ok" }),
  ).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================================
// 4. Geliştirici yardımcı fonksiyonları (doPost'a bağlı değil, editörden elle çalıştırılır)
// ============================================================================

/**
 * Bu Web App deployment'ının URL'ini Telegram'a webhook olarak kaydeder.
 * Deploy ettikten sonra Apps Script editöründen bir kez elle çalıştırın.
 * @return {string} Telegram API yanıtı.
 */
function kurulumWebhook() {
  var url = ScriptApp.getService().getUrl();
  if (!url) {
    throw new Error(
      "Web App URL'i alınamadı. Önce projeyi Deploy > New deployment > Web app ile deploy edin.",
    );
  }
  var telegramUrl =
    "https://api.telegram.org/bot" + CONFIG.telegramToken + "/setWebhook";
  var response = UrlFetchApp.fetch(telegramUrl, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ url: url }),
    muteHttpExceptions: true,
  });
  Logger.log(response.getContentText());
  return response.getContentText();
}

/**
 * Telegram webhook kaydını kaldırır (test/temizlik amaçlı).
 * @return {string} Telegram API yanıtı.
 */
function webhookSil() {
  var telegramUrl =
    "https://api.telegram.org/bot" + CONFIG.telegramToken + "/deleteWebhook";
  var response = UrlFetchApp.fetch(telegramUrl, {
    method: "post",
    muteHttpExceptions: true,
  });
  Logger.log(response.getContentText());
  return response.getContentText();
}
