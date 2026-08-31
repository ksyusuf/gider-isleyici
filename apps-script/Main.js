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
 *   2. Loglama (log_ / logHata_)
 *   3. Gemini REST entegrasyonu
 *   4. Telegram entegrasyonu (update dedup + doPost)
 *   5. Geliştirici yardımcı fonksiyonları (webhook kurulum/durum/kaldırma)
 */

// ============================================================================
// 1. FUNCTION_MAP
// ============================================================================

/** Gemini'nin döndürdüğü fonksiyon adını (bkz. Expenses.js) gerçek implementasyona eşler. */
const FUNCTION_MAP = {
  harcamaEkle: harcamaEkle,
  taksitliHarcamaEkle: taksitliHarcamaEkle,
  sonHarcamalariGetir: sonHarcamalariGetir,
  sonHarcamalariTopla: sonHarcamalariTopla,
};

// ============================================================================
// 2. Loglama
// ============================================================================

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

// ============================================================================
// 3. Gemini REST entegrasyonu
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
  "KATEGORİLER:",
  "Aşağıdaki 17 kategori SABİTTİR; kategori seçimini SADECE bu listeden yap, listede",
  "olmayan ya da benzetilmiş yeni bir kategori ASLA üretme:",
  "{KATEGORI_TANIMLARI}",
  "",
  "KARIŞABİLEN KATEGORİLER — ÖNCELİK KURALLARI:",
  "- Yemek ↔ Cafe: mekan bazlı karar — mekan kafeyse ürün ne olursa olsun Cafe.",
  "- Fatura ↔ Dijital: sağlayıcı tipi bazlı — altyapı/hat sağlayıcısı → Fatura;",
  "  içerik/yazılım platformu → Dijital.",
  "- Elektronik ↔ Dijital: fiziksel mi dijital mi — cihaz → Elektronik; hizmet/",
  "  yazılım/dijital içerik → Dijital.",
  "- Araç ↔ Ulaşım ↔ Kiralama: kimin aracı + mülkiyet mi kiralama mı — kendi",
  "  aracı bakım/gideri → Araç; kendi aracı dışı ulaşım → Ulaşım; araç/ev",
  "  kiralama → Kiralama.",
  "- Destek ↔ Hediye: nakit/altın mı eşya mı — nakit/altın karşılıksız yardım →",
  "  Destek; somut eşya → Hediye.",
  "- Kişisel ↔ Hastane ↔ Giyim ↔ Eğitim ↔ Spor: kozmetik/bakım/kırtasiye →",
  "  Kişisel; sağlık amaçlı (vitamin dahil) → Hastane; giyilen her şey (spor",
  "  kıyafeti dahil) → Giyim; kurs/ders kitabı → Eğitim; ekipman/üyelik/ders",
  "  ücreti (kıyafet hariç) → Spor.",
  "",
  "ÖRNEKLER (kategori ayrımı):",
  '- "cups clouds\'da ice americano içtim" → Cafe (mekan kafe, ürün ne olursa olsun)',
  '- "kafede tost yedim" → Cafe (fiil "yedim" olsa da mekan sinyali kazanır)',
  '- "eczaneden vitamin aldım" → Hastane (sağlık amaçlı, kozmetik değil)',
  '- "telefon hattı faturamı ödedim" → Fatura (altyapı/hat sağlayıcısı)',
  '- "netflix aboneliğim yenilendi" → Dijital (içerik platformu)',
  '- "markette alışveriş yaptım" → Ev (malzeme alanına "Market" yaz)',
  '- "spor ayakkabısı aldım" → Giyim (spor kıyafeti/ayakkabısı Spor\'a girmez)',
  '- "bir araba kiraladım" → Kiralama (mülkiyet değil kiralama; kendi aracı da değil)',
  "",
  "Yukarıdaki 17 kategori TAM LİSTEDİR: bunların dışında yeni bir kategori ASLA",
  "üretme, adını kısaltma/değiştirme. Bir harcama bu 17'den hiçbirine net",
  "oturmuyorsa ZORUNLU NETLİK KURALI gereği o kalem için harcamaEkle'yi çağırma,",
  "kullanıcıya sor.",
  "",
  "TAKSİTLİ HARCAMALAR:",
  'Kullanıcı bir harcamayı taksitle yaptığını belirtirse (ör. "5 taksitle X',
  'aldım", "X\'i 6 taksitte alacağım") harcamaEkle YERİNE taksitliHarcamaEkle',
  "fonksiyonunu TEK SEFER çağır — taksit sayısı kadar ayrı harcamaEkle çağırma,",
  "tarih/tutar hesaplamasını SEN yapma; bunlar kodda deterministik olarak",
  "hesaplanır.",
  '- tutarTipi: "toplamda/toplam X TL\'ye", "X TL\'yi N taksitte" gibi ifadeler',
  '  TOPLAM\'a; "ayda/taksit başına X TL", "her ay X TL ödeyeceğim" gibi',
  "  ifadeler TAKSIT_BASI'na işaret eder. Metinden hangisi olduğu NET",
  '  çıkarılamıyorsa (ör. sadece "5 taksitle X aldım, 5000 TL" dendiğinde',
  "  5000'in toplam mı taksit başı mı olduğu belirsizse) ZORUNLU NETLİK KURALI",
  '  gibi fonksiyonu ÇAĞIRMA, kullanıcıya "toplam mı yoksa taksit başına mı?"',
  "  diye açıkça sor — ASLA varsayım yapıp tahmin etme.",
  "- ilkTarih: harcamaEkle'deki tarih alanıyla AYNI ZAMAN BAĞLAMI kurallarıyla",
  "  hesapla; referans gün her zaman kullanıcının belirttiği satın alma günüdür",
  "  (mevcut ay içinde geçmiş/gelecek bir gün belirtilse bile o gün aynen",
  "  kullanılır).",
  '- Her taksidin "(k/N)" etiketi ve ay sonu çakışması gibi hesaplamalar',
  "  otomatik yapılır, bunlarla ilgilenmene gerek yok.",
  "",
  "ZORUNLU NETLİK KURALI (çok önemli):",
  "Bir harcama kaleminin TUTAR, TARİH ve TÜR/KATEGORİ bilgisi kesin ve tartışmasız",
  "biçimde belirlenebilir olmalıdır:",
  '- tutar: açık, sayısal bir değer olmalı ("5 tl", "150 lira" gibi). "birkaç lira",',
  '  "epey para harcadım" gibi belirsiz ifadelerde tutarı ASLA tahmin edip uydurma.',
  "- tarih: yukarıdaki ZAMAN BAĞLAMI kurallarıyla netleşmiyorsa (ör. hangi gün olduğu",
  '  belirsiz kalan bir "geçen [gün adı]" ifadesi) ASLA tahmin edip uydurma.',
  "- tür/kategori: yukarıdaki KATEGORİLER listesindeki 17 kategoriden TAM OLARAK",
  "  BİRİNE net biçimde karşılık gelmiyorsa (belirsiz, birden fazla kategoriye uyan",
  "  ya da listede hiç bulunmayan bir harcama türüyse) ASLA tahmin edip uydurma ve",
  "  ASLA listede olmayan yeni bir kategori üretme.",
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
 * KATEGORILER sabitinden (Config.js) systemInstruction'a gömülecek numaralı
 * kategori tanımları bloğunu üretir. Tek kaynak KATEGORILER'dır; kapsar/
 * kapsamaz metinleri burada TEKRARLANMAZ, sadece biçimlendirilir.
 * @return {string}
 */
function buildKategoriTanimlariBlok_() {
  return KATEGORILER.map(function (k, i) {
    var satir = i + 1 + ". **" + k.ad + "** — Kapsar: " + k.kapsar;
    if (k.kapsamaz) {
      satir += " Kapsamaz: " + k.kapsamaz;
    }
    return satir;
  }).join("\n");
}

/**
 * SYSTEM_INSTRUCTION_TEMPLATE içindeki {ZAMAN_BAGLAMI} ve {KATEGORI_TANIMLARI}
 * yer tutucularını doldurur. Kategori bloğu her çağrıda (istek zamanında)
 * yeniden üretilir — Config.js'in Main.js'ten önce yüklendiği varsayımına
 * (clasp'ın dosya sırasına) bağlı kalmamak için modül yüklenirken değil,
 * burada hesaplanır; maliyeti (17 elemanlı bir map+join) ihmal edilebilir.
 * @param {Date} mesajZamani
 * @return {string}
 */
function buildSystemInstruction_(mesajZamani) {
  return SYSTEM_INSTRUCTION_TEMPLATE.replace(
    "{ZAMAN_BAGLAMI}",
    formatZamanBaglami_(mesajZamani),
  ).replace("{KATEGORI_TANIMLARI}", buildKategoriTanimlariBlok_());
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

  // NOT: `url` API key içeriyor — asla loglanmaz.
  log_("gemini.istek", {
    model: CONFIG.geminiModel,
    mesajZamani: Utilities.formatDate(
      mesajZamani,
      TIME_ZONE,
      "yyyy-MM-dd HH:mm:ss",
    ),
    metin: userText,
  });

  var t0 = Date.now();
  var response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(requestBody),
    muteHttpExceptions: true,
  });
  var sureMs = Date.now() - t0;

  var statusCode = response.getResponseCode();
  var govde = response.getContentText();
  log_("gemini.yanit", { http: statusCode, sureMs: sureMs, govde: govde });

  if (statusCode !== 200) {
    throw new Error("Gemini API hatası (HTTP " + statusCode + "): " + govde);
  }

  var json = JSON.parse(govde);
  var candidate = json.candidates && json.candidates[0];
  if (!candidate || !candidate.content || !candidate.content.parts) {
    // Güvenlik filtresi ya da boş yanıt burada yakalanır; promptFeedback
    // genellikle sebebi söyler.
    log_("gemini.bos-yanit", {
      promptFeedback: json.promptFeedback,
      candidates: json.candidates,
    });
    throw new Error("Gemini API beklenmeyen bir yanıt döndürdü: " + govde);
  }

  log_("gemini.finishReason", candidate.finishReason);
  log_(
    "gemini.parts",
    candidate.content.parts.map(function (part) {
      return part.functionCall
        ? { fonksiyon: part.functionCall.name, args: part.functionCall.args }
        : { text: part.text };
    }),
  );

  return candidate.content.parts;
}

// ============================================================================
// 4. Telegram entegrasyonu
// ============================================================================

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
      "[telegram.HATA] sendMessage başarısız (HTTP " + statusCode + "): " + govde,
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
  log_("fonksiyon.cagri", {
    ad: functionCall.name,
    args: functionCall.args,
  });

  var fn = FUNCTION_MAP[functionCall.name];
  if (!fn) {
    log_("fonksiyon.bilinmeyen", functionCall.name);
    return "⚠️ Bilinmeyen fonksiyon çağrısı: " + functionCall.name;
  }

  var t0 = Date.now();
  try {
    var sonuc = fn(functionCall.args || {});
    log_("fonksiyon.sonuc", {
      ad: functionCall.name,
      sureMs: Date.now() - t0,
      sonuc: sonuc,
    });
    return sonuc;
  } catch (err) {
    logHata_("fonksiyon.HATA:" + functionCall.name, err);
    return (
      "⚠️ '" + functionCall.name + "' işlenirken hata oluştu: " + err.message
    );
  }
}

/** `/komutlar` çıktısı ve tanınmayan komutlarda gösterilecek ortak liste. */
const KOMUT_LISTESI_METNI = [
  "Kullanılabilir komutlar:",
  "/son [N] — son N harcamayı listeler (belirtilmezse 5).",
  "/toplam [N] — son N harcamanın toplamını hesaplar (belirtilmezse 5).",
  "/komutlar — bu listeyi gösterir.",
].join("\n");

/**
 * `/` ile başlayan komutları Gemini'ye HİÇ göndermeden doğrudan işler —
 * sıfır Gemini API maliyeti/gecikmesi, tamamen deterministik (bkz.
 * apps-script/CLAUDE.md madde 2). Tanınmayan komutlar bir hata mesajı +
 * komut listesiyle karşılanır.
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
    // systemInstruction > ZORUNLU NETLİK KURALI, kısmi ekleme senaryosu).
    bloklar.push("❓ Netleştirilmesi gerekenler:\n" + metinParcalari.join("\n"));
  }

  return bloklar.join("\n\n");
}

/** İşlenmiş en yüksek update_id'nin saklandığı Script Property anahtarı. */
const SON_UPDATE_ID_KEY = "SON_UPDATE_ID";

/** Oku/karşılaştır/yaz kritik bölümü için kilit bekleme süresi (ms). */
const UPDATE_LOCK_TIMEOUT_MS = 10000;

/**
 * Bu update daha önce işlendi mi? `respondOk_()` düzeltmesinden sonra Telegram
 * teslimatı başarılı saydığı için normal şartlarda hiç tekrar gelmemeli; bu
 * fonksiyon bir SAVUNMA KATMANI olarak duruyor (ağ kesintisi, gerçek timeout,
 * elle yeniden gönderim). Korunmazsa her tekrarda Gemini yeniden çağrılır, aynı
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
 *     (milisaniyeler), Gemini çağrısını DEĞİL — aksi halde tüm istekler seri
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
      log_("doPost.gecersiz-istek", "postData yok — Telegram dışı istek, yok sayıldı.");
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

    // `/` ile başlayan komutlar Gemini'ye hiç gitmeden burada, deterministik
    // olarak işlenir (bkz. islemKomut_ ve apps-script/CLAUDE.md madde 2).
    if (text.trim().charAt(0) === "/") {
      var komutCevabi = islemKomut_(text);
      log_("doPost.komut-cevap", komutCevabi);
      sendTelegramMessage_(chatId, komutCevabi);
      log_("doPost.tamamlandi", { toplamSureMs: Date.now() - baslangic });
      return respondOk_();
    }

    var parts = callGemini_(text, message.date);
    var cevapMetni = islemSonuclariniBirlestir_(parts);
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
          "⚠️ Bir hata oluştu, işlem tamamlanamadı: " + err.message,
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
// 5. Geliştirici yardımcı fonksiyonları (doPost'a bağlı değil, editörden elle çalıştırılır)
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
