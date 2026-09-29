/**
 * ============================================================================
 * Gider İşleyici — LLM Entegrasyonu (sağlayıcıdan bağımsız) + Katman 1 Tekrar Deneme
 * ============================================================================
 * Sağlayıcıdan bağımsız çekirdek: mesaj zamanına göre dinamik kurulan
 * systemInstruction, LLM geçici hatalarına karşı senkron tekrar deneme
 * (Katman 1), hata sınıflandırma ve LLM'in döndürdüğü function call'ları
 * çalıştıran dispatch mantığı burada tutulur. Sağlayıcıya özgü HTTP/format
 * kodu adaptör dosyalarındadır (şimdilik LLMGroq.js) ve yanıtı ortak
 * `parts` biçimine normalize eder: [{functionCall:{name,args}} | {text}].
 *
 * PROD / TEST profilleri: CONFIG.llm.prod (doPost ve retry akışı) ve
 * CONFIG.llm.test (yalnızca LLMTest.js'teki elle çalıştırılan test
 * fonksiyonları). Bkz. Config.js > llmProfilOku_.
 *
 * İlgili diğer dosyalar:
 *   - Config.js: CONFIG (llm profilleri), TIME_ZONE, KATEGORILER, TOOLS
 *   - LLMGroq.js: Groq adaptörü (llmSaglayici_("groq"))
 *   - LLMTest.js: yan etkisiz API test fonksiyonları (TEST profili)
 *   - Expenses.js: harcamaEkle / taksitliHarcamaEkle / sonHarcamalariGetir / sonHarcamalariTopla (FUNCTION_MAP hedefleri)
 *   - Logging.js: log_ / logHata_
 *   - Telegram.js: islemSonuclariniBirlestir_ (bu dosyadaki calistirFonksiyon_'u kullanır)
 *   - Main.js: doPost (mesajiIsleVeYanitla_'yı ilk/canlı denemede çağırır)
 *   - retry/RetryCore.js: zamanlanmisTekrarDenemeyiIsle (mesajiIsleVeYanitla_'yı
 *     gecikmeli denemede çağırır) — LLM çağırma/fonksiyon çalıştırma/cevap
 *     birleştirme mantığı iki yerde ayrı ayrı yazılmaz, hep buradan geçer.
 */


// ============================================================================
// FUNCTION_MAP — LLM fonksiyon dispatch
// ============================================================================

/**
 * LLM'in döndürdüğü (İNGİLİZCE) tool adını gerçek implementasyona eşler. Her
 * giriş, İngilizce parametre adlarını Expenses.js'in Türkçe iç adlarına çeviren
 * ince bir sarmalayıcıdır — Expenses.js bilinçli olarak değişmedi. Opsiyonel
 * alanlar model tarafından hiç gönderilmeyebilir (undefined geçer).
 */
const FUNCTION_MAP = {
  // İç (LLM şemasında YOK): add_expenses dizisi llmPartsGenislet_ ile bu tekil çağrılara açılır.
  add_expense: function (a) {
    return harcamaEkle({
      tutar: a.amount,
      kategori: a.category,
      aciklama: a.note,
      tarih: a.date,
      firma: a.merchant,
      malzeme: a.item,
    });
  },
  // Genişletme dizi vermediyse (model bozuk çıktı) buraya düşer → kullanıcıya uyarı.
  add_expenses: function () {
    throw new Error("Harcama listesi (expenses) eksik ya da geçersiz.");
  },
  add_installment_expense: function (a) {
    return taksitliHarcamaEkle({
      tutar: a.amount,
      // Bilinmeyen değer OLDUĞU GİBİ geçer; Expenses.js kendi doğrulamasıyla reddeder.
      tutarTipi: TUTAR_TIPI_CEVIRI_[a.amount_type] || a.amount_type,
      taksitSayisi: a.installment_count,
      kategori: a.category,
      ilkTarih: a.first_date,
      firma: a.merchant,
      malzeme: a.item,
      aciklama: a.note,
    });
  },
  get_recent_expenses: function (a) {
    return sonHarcamalariGetir({ adet: a.count });
  },
  sum_recent_expenses: function (a) {
    return sonHarcamalariTopla({ adet: a.count });
  },
};

/**
 * LLM'in tek `add_expenses` çağrısındaki `expenses` dizisini, her kalem için
 * AYRI bir iç `add_expense` functionCall'una açar. Sebep: (a) Groq/gpt-oss aynı
 * yanıtta birden fazla paralel tool çağrısı üretmekte zayıf — çoklu harcama tek
 * çağrıda liste olarak alınır; (b) kalemler ayrı çalıştırılınca
 * `calistirFonksiyon_`'un hata izolasyonu (bir kalem patlarsa diğerleri yine
 * yazılır) ve kalem başına ayrı onay/hata bloğu aynen korunur. Dizi olmayan/boş
 * `add_expenses` olduğu gibi bırakılır (FUNCTION_MAP.add_expenses uyarı üretir).
 * @param {Array<Object>} parts
 * @return {Array<Object>}
 */
function llmPartsGenislet_(parts) {
  var out = [];
  parts.forEach(function (part) {
    var fc = part.functionCall;
    if (
      fc &&
      fc.name === "add_expenses" &&
      fc.args &&
      Array.isArray(fc.args.expenses) &&
      fc.args.expenses.length > 0
    ) {
      fc.args.expenses.forEach(function (kalem) {
        out.push({ functionCall: { name: "add_expense", args: kalem || {} } });
      });
    } else {
      out.push(part);
    }
  });
  return out;
}
/** `amount_type` (LLM tarafı) → Expenses.js `tutarTipi` değerleri. */
const TUTAR_TIPI_CEVIRI_ = {
  TOTAL: "TOPLAM",
  PER_INSTALLMENT: "TAKSIT_BASI",
};

/**
 * Tek bir functionCall part'ını çalıştırır. Hata durumunda batch'in
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

// ============================================================================
// systemInstruction
// ============================================================================

/**
 * LLM'e gönderilen systemInstruction şablonu (İNGİLİZCE talimat, Türkçe veri).
 * Yapı: statik bölümler önce, mesaj zamanı ({MESSAGE_TIME}) EN SONDA — böylece
 * önek sabit kalır (prompt caching'e uygun) ve göreceli tarih ifadeleri script'in
 * çalıştığı ana değil mesajın gönderildiği ana göre çözülür. {CATEGORY_DEFINITIONS}
 * KATEGORILER'den (Config.js) üretilir. Örnek kullanıcı cümleleri KASITLI olarak
 * Türkçe ve çevrilmemiş bırakılır (LANGUAGE CONTRACT bunu modele bildirir).
 */
const SYSTEM_INSTRUCTION_TEMPLATE = `# ROLE
You are a personal expense-tracking assistant. The user sends Telegram messages in Turkish that describe one or more expenses. You extract each expense and record it by calling the tools. If you do not call a tool (or skip some items), explain why in a short plain-text reply written in Turkish.

# LANGUAGE CONTRACT
- The user's messages are in Turkish. Every example user message in this prompt is Turkish and shown verbatim; never translate user text.
- Free-text tool values (merchant, item, note) stay in Turkish, as the user wrote them.
- category must be exactly one of the Turkish names listed under CATEGORIES.
- Every text reply to the user must be in Turkish.
- Tool names and parameter names are English; use them exactly as declared.

# TOOL RULES
- Available tools: add_expenses, add_installment_expense, get_recent_expenses, sum_recent_expenses. Use these exact names.
- RECORDING EXPENSES: use ONE add_expenses call per message. First split the message into its individual expense items (often separated by commas, "ve", "de", "sonra", or a new time expression such as "bugün"/"dün"), then put EVERY certain item into the "expenses" array, one element per item. A single expense is a one-element array. Never stop after the first item and never make several add_expenses calls.
- Every item must end up either as a tool call or, if unclear, as a mention in your Turkish text reply. Never silently drop an item. Never merge items, sum amounts, or mix categories.
- Optional parameters: send them only when you have a value. Never send null, an empty string, or a placeholder; omit the parameter instead.
- Use get_recent_expenses / sum_recent_expenses only when the user explicitly asks to see or total recent expenses.

# DATE RULES
The message time is given in CURRENT MESSAGE CONTEXT at the end. Resolve every relative date against it and send absolute dates as YYYY-MM-DD (never relative text).
- "bugün" = the message date. "dün" = one day before. "önceki gün" / "evvelsi gün" = two days before.
- "geçen <weekday>" (e.g. "geçen pazartesi") = the nearest such weekday BEFORE the current week.
- A bare "<weekday>" (e.g. "pazartesi") = that day this week or the nearest past one; if the context does not tell which, the date is AMBIGUOUS.
- "X gün önce" = X days before the message date.
- No time expression at all = the message date (today). This is NOT ambiguity; it is a valid default.

# CATEGORIES
Exactly these 17 categories exist. Names are Turkish and must be used verbatim. Never invent, abbreviate, or alter a category.
{CATEGORY_DEFINITIONS}

Disambiguation rules:
- Yemek vs Cafe: decided by venue. If the venue is a cafe, it is Cafe, whatever the product.
- Ev vs Yemek (food): decided by context. A snack/drink bought for immediate consumption while out or during/after an activity = Yemek; groceries bought at a supermarket in bulk/to stock up = Ev (item "Market").
- Fatura vs Dijital: decided by provider type. Infrastructure/line provider = Fatura; content/software platform = Dijital.
- Elektronik vs Dijital: physical device = Elektronik; service/software/digital content = Dijital.
- Araç vs Ulaşım vs Kiralama: upkeep of the user's own vehicle = Araç; transport other than own vehicle = Ulaşım; renting a vehicle/home = Kiralama.
- Destek vs Hediye: cash/gold given with nothing expected back = Destek; a concrete item = Hediye.
- Kişisel / Hastane / Giyim / Eğitim / Spor: cosmetics/care/stationery = Kişisel; health purpose (vitamins included) = Hastane; anything worn (sports clothing included) = Giyim; courses/textbooks = Eğitim; equipment/membership/lesson fees (not clothing) = Spor.
If an expense clearly fits none of the 17 categories, do NOT call a tool for it; ask the user (see MANDATORY CLARITY RULE).

# INSTALLMENTS
If the user says a purchase is paid in installments (e.g. "5 taksitle ... aldım", "6 taksitte alacağım"), call add_installment_expense ONCE. Do not put installments into add_expenses and do not compute dates or amounts yourself; the code does that.
- amount_type: "toplamda/toplam X TL", "X TL'yi N taksitte" = TOTAL; "ayda/taksit başına X TL", "her ay X TL" = PER_INSTALLMENT.
- If the text does not make clear whether the amount is total or per installment (e.g. only "5 taksitle ayakkabı aldım, 5000 TL"), do NOT call the tool; ask in Turkish whether it is total or per installment ("toplam mı yoksa taksit başına mı?"). Never assume.
- first_date: resolve with the DATE RULES; the reference day is the purchase day the user states (used as-is even if it is earlier or later in the current month); if none is stated, the message date.

# MANDATORY CLARITY RULE
An item may be recorded only when amount, date and category are all certain:
- amount: an explicit number ("5 tl", "150 lira"). For vague wording ("birkaç lira", "epey para harcadım") never guess.
- date: must resolve via the DATE RULES; if it stays ambiguous, never guess.
- category: must match exactly ONE of the 17 categories clearly. If it is unclear, fits several, or fits none, never guess and never invent one.
If any of the three is uncertain, do NOT call a tool for that item. Instead, in your Turkish text reply, state exactly which information is missing or ambiguous so the user can write a clearer next message. Still record the certain items of the same message with tool calls; partial recording plus partial clarification may appear in one response. When in doubt, ask instead of guessing.

# FIELD RULES
- merchant: the business/place name. Remove Turkish case suffixes (-dan/-den/-tan/-ten, -da/-de/-ta/-te, -a/-e, -ı/-i/-u/-ü, -ın/-in/-un/-ün, -yla/-yle) but keep the name's own letters; if unsure, keep the user's spelling. "teknosadan" -> "Teknosa", "migros'ta" -> "Migros".
- Generic place words ("market", "kafe", "eczane", "benzinlik") are NOT merchants: leave merchant out unless a specific business is named (e.g. "Migros", "Starbucks").
- item: the concrete product bought ("telefon", "ekmek"), if stated.
- note: any relevant detail that fits no other field (with whom, for whom, reason). Never drop such information. Omit note if there is none.

# EXAMPLES
The user messages below are Turkish and shown verbatim. "<yesterday>" means the computed absolute date.
1. "dün teknosadan telefon aldım 50000 tl" -> add_expenses(expenses=[{amount=50000, category="Elektronik", date=<yesterday>, merchant="Teknosa", item="telefon"}])
2. "cups clouds'da ice americano içtim 120 tl" -> Cafe (venue is a cafe, whatever the product)
3. "kafede tost yedim 90 tl" -> Cafe (the venue signal wins over the verb "yedim")
4. "eczaneden vitamin aldım 300 tl" -> Hastane (health purpose, not cosmetics)
5. "netflix aboneliğim yenilendi 229 tl" -> Dijital (content platform)
6. "telefon hattı faturamı ödedim 400 tl" -> Fatura (line provider)
7. "markette alışveriş yaptım 350 tl" -> Ev, item="Market"
8. "spor sonrası atıştırmalık aldım 105tl" -> Yemek (immediate consumption after an activity)
9. "markette atıştırmalık stoku aldım 200 tl" -> Ev (stocking up at a supermarket)
10. "spor ayakkabısı aldım 2500 tl" -> Giyim (sports shoes are clothing, not Spor)
11. "bir araba kiraladım 3000 tl" -> Kiralama
12. "markette 200 tl alışveriş yaptım, otobüse 15 lira verdim" -> ONE add_expenses call with TWO elements: {amount=200, category="Ev", item="Market"} and {amount=15, category="Ulaşım"}. Omitting the second element is an error.
   "dün kafede 120 tl kahve içtim, bugün taksiye 250 tl verdim, eczaneden 90 tl vitamin aldım" -> ONE add_expenses call with THREE elements: Cafe 120 (yesterday), Ulaşım 250 (today), Hastane 90 (today)
13. "iphone'u 6 taksitle aldım, taksit başı 5000 tl" -> add_installment_expense(amount=5000, amount_type="PER_INSTALLMENT", installment_count=6, category="Elektronik", item="iPhone")
14. "5 taksitle ayakkabı aldım 5000 tl" -> no tool call; Turkish reply asking whether 5000 TL is total or per installment
15. "bugün biraz para harcadım" -> no tool call; Turkish reply asking for the amount and what it was for
16. "dün 150 tl bir şeye harcadım, bugün de 40 tl otobüs" -> add_expenses with ONE element for the bus (Ulaşım, 40, today); Turkish reply asking what the 150 TL was for
17. "merhaba" -> no tool call; short Turkish greeting explaining that the user can write their expenses

# CURRENT MESSAGE CONTEXT
{MESSAGE_TIME}`;

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
  return "This message was sent on " + etiket + " (Europe/Istanbul).";
}

/**
 * KATEGORILER sabitinden (Config.js) systemInstruction'a gömülecek numaralı
 * kategori tanımları bloğunu üretir. Tek kaynak KATEGORILER'dır; kapsar/
 * kapsamaz metinleri burada TEKRARLANMAZ, sadece biçimlendirilir.
 * @return {string}
 */
function buildKategoriTanimlariBlok_() {
  return KATEGORILER.map(function (k, i) {
    var satir = i + 1 + ". " + k.ad + " — Includes: " + k.kapsar;
    if (k.kapsamaz) {
      satir += " Excludes: " + k.kapsamaz;
    }
    return satir;
  }).join("\n");
}

/**
 * SYSTEM_INSTRUCTION_TEMPLATE içindeki {CATEGORY_DEFINITIONS} ve {MESSAGE_TIME}
 * yer tutucularını doldurur. Kategori bloğu her çağrıda (istek zamanında)
 * yeniden üretilir — Config.js'in LLM.js'ten önce yüklendiği varsayımına
 * (clasp'ın dosya sırasına) bağlı kalmamak için modül yüklenirken değil,
 * burada hesaplanır; maliyeti (17 elemanlı bir map+join) ihmal edilebilir.
 * @param {Date} mesajZamani
 * @return {string}
 */
function buildSystemInstruction_(mesajZamani) {
  return SYSTEM_INSTRUCTION_TEMPLATE.replace(
    "{CATEGORY_DEFINITIONS}",
    buildKategoriTanimlariBlok_(),
  ).replace("{MESSAGE_TIME}", formatZamanBaglami_(mesajZamani));
}

// ============================================================================
// LLM sağlayıcı çağrısı (adaptör dispatch)
// ============================================================================

/**
 * Kayıtlı sağlayıcı adaptörleri (ad → adaptör). Her adaptör:
 *   istekGonder(profil, systemMetni, userText) → parts dizisi (ortak biçim);
 *   hata durumunda `httpStatus`/`httpBody` set edilmiş Error fırlatır (ve
 *   gerekirse `tekrarDenenebilir` işareti, bkz. hataGeciciMi_).
 * Yeni bir sağlayıcı eklemek = yeni adaptör dosyası + buraya kayıt.
 */
function llmSaglayici_(ad) {
  // Fonksiyon (const değil): adaptör dosyası bu dosyadan SONRA yüklenirse bile
  // çağrı anında çözülür — dosya yükleme sırasına bağımlılık yok.
  var kayit = {
    groq: { istekGonder: groqIstekGonder_, modelleriListele: groqModelleriListele_ },
  };
  return kayit[ad];
}

/**
 * Profildeki sağlayıcıyla istek atar. `profil` = CONFIG.llm.prod | CONFIG.llm.test.
 * @param {{provider:string, apiKey:string, model:string}} profil
 * @param {string} userText Kullanıcının Telegram mesaj metni.
 * @param {number} [mesajZamaniSaniye] Telegram update.message.date (Unix saniye).
 *   Verilmezse script'in çalıştığı an kullanılır (yalnızca yedek/geriye dönük durum).
 * @return {Array<Object>} Ortak `parts` dizisi.
 */
function llmCagir_(profil, userText, mesajZamaniSaniye) {
  var saglayici = llmSaglayici_(profil.provider);
  if (!saglayici) {
    throw new Error("Bilinmeyen LLM sağlayıcısı: " + profil.provider);
  }
  if (!profil.apiKey || !profil.model) {
    throw new Error(
      "LLM profili eksik: API_KEY ve MODEL Script Property'leri tanımlı olmalı.",
    );
  }
  var mesajZamani = mesajZamaniSaniye
    ? new Date(mesajZamaniSaniye * 1000)
    : new Date();
  // NOT: profil.apiKey asla loglanmaz.
  log_("llm.istek", {
    saglayici: profil.provider,
    model: profil.model,
    mesajZamani: Utilities.formatDate(mesajZamani, TIME_ZONE, "yyyy-MM-dd HH:mm:ss"),
    metin: userText,
  });
  var parts = saglayici.istekGonder(
    profil,
    buildSystemInstruction_(mesajZamani),
    userText,
  );
  log_(
    "llm.parts",
    parts.map(function (part) {
      return part.functionCall
        ? { fonksiyon: part.functionCall.name, args: part.functionCall.args }
        : { text: part.text };
    }),
  );
  return parts;
}


/** Katman 1 (senkron) tekrar deneme parametreleri. */
const LLM_MAX_DENEME = 3;
const LLM_RETRY_GECIKMELER_MS = [2000, 5000]; // 3 deneme arası: 2sn, 5sn bekleme
const LLM_KALICI_HTTP_KODLARI = [400, 401, 403, 404];

/**
 * Bir LLM hatasının GEÇİCİ (retry'a değer) mi yoksa KALICI (retry asla
 * düzeltmez) mi olduğuna karar verir. BLACKLIST mantığı: sadece
 * LLM_KALICI_HTTP_KODLARI'nda listelenen HTTP durumları kalıcı sayılır;
 * ağ hatası, boş/beklenmeyen yanıt ya da bilinmeyen bir durum kodu dahil geri
 * kalan HER ŞEY varsayılan olarak GEÇİCİ kabul edilir. Bu, kullanıcının
 * "LLM'in veriyi yorumlayamaması DIŞINDA hiçbir şey için elle tekrar
 * göndermek istemiyorum" isteğiyle uyumlu — yorumlayamama zaten bir exception
 * değil, ayrı ve değişmeyen bir akıştır (bkz. Telegram.js > islemSonuclariniBirlestir_).
 * @param {Error} err
 * @return {boolean}
 */
function hataGeciciMi_(err) {
  if (err && err.tekrarDenenebilir === true) {
    return true; // adaptör açıkça işaretledi (örn. Groq 400 tool_use_failed)
  }
  if (err && typeof err.httpStatus === "number") {
    return LLM_KALICI_HTTP_KODLARI.indexOf(err.httpStatus) === -1;
  }
  return true;
}

/**
 * Katman 1'in hızlı (saniyeler içinde) tekrar denemesinin ANLAMSIZ olduğu,
 * sebebi zaten KESİN bilinen iki durumu tespit eder — ikisinde de doğrudan
 * Katman 2'ye (saatlik trigger) geçilir, kalan hızlı deneme hakları harcanmaz:
 *   (a) "Yüksek talep/kapasite" — `httpStatus === 503` (model o an
 *       meşgul/aşırı yüklü, "over capacity" / "high demand"). Birkaç
 *       saniye arayla tekrar denemek durumu değiştirmez (sorun saatler
 *       sürebiliyor, bkz. CLAUDE.md test notları).
 *   (b) "Kota/rate-limit doldu" — `httpStatus === 429`. Kota zaten dolu
 *       durumdayken hemen tekrar istek atmak sorunu ÇÖZMEK yerine kotayı daha
 *       da zorlar (2026-09-29, prod'da gözlemlendi) — bu yüzden gövdeye hiç
 *       bakılmadan doğrudan true döner.
 * Sağlayıcıdan bağımsızdır: yalnızca HTTP durum koduna bakar.
 * @param {Error} err
 * @return {boolean}
 */
function hataYuksekTalepMi_(err) {
  return !!err && (err.httpStatus === 429 || err.httpStatus === 503);
}

/**
 * Kullanıcıya (ve Sheets'teki `son_hata_mesaji` sütununa — bu da
 * `/pesedilenler` üzerinden Telegram'a dökülüyor) gösterilecek, HAM JSON
 * gövdesi İÇERMEYEN kısa bir Türkçe açıklama üretir. Ham `err.message`
 * (Sağlayıcının `{"error":{...}}` gövdesini birebir içerir) doğrudan
 * kullanıcıya gösterilmez — teşhis için ham hata `logHata_` ile loglanmaya
 * devam eder, SADECE kullanıcı yüzeyine giden metin buradan geçirilir.
 * @param {Error} err
 * @return {string}
 */
function kullaniciyaGosterilecekHataMetni_(err) {
  if (!err) {
    return "Beklenmeyen bir hata oluştu.";
  }
  if (hataYuksekTalepMi_(err)) {
    return err.httpStatus === 429
      ? "Yapay zeka servisi kullanım kotası doldu (çok fazla istek gönderildi)."
      : "Yapay zeka servisi şu an yoğun (yüksek talep).";
  }
  if (typeof err.httpStatus === "number") {
    // Bu noktaya gelen err HER ZAMAN llmCagir_'nin HTTP-durumu dalından
    // gelir ve `.message` ham sağlayıcı JSON gövdesini içerir — asla olduğu
    // gibi gösterilmez.
    if (LLM_KALICI_HTTP_KODLARI.indexOf(err.httpStatus) !== -1) {
      return (
        "Yapay zeka servisi isteği reddetti (HTTP " +
        err.httpStatus +
        ") — bu genellikle API key ya da istek biçimiyle ilgili kalıcı bir sorundur."
      );
    }
    return "Yapay zeka servisi hatası (HTTP " + err.httpStatus + ").";
  }
  // httpStatus yok: ya llmCagir_'nin "beklenmeyen yanıt" dalı (artık ham
  // gövde içermiyor) ya da kodun kendi ürettiği, zaten okunur bir Türkçe
  // hata mesajı (örn. kuyruklama/trigger hatası) — olduğu gibi gösterilir.
  return err.message || "Beklenmeyen bir hata oluştu.";
}

/**
 * llmCagir_'yi en fazla maxDeneme kez dener. Kalıcı bir hata alınırsa deneme
 * hakkı harcamadan hemen fırlatır. "Yüksek talep" (hataYuksekTalepMi_) tespit
 * edilirse de aynı şekilde hemen çıkılır — sebep zaten bilindiği için hızlı
 * tekrar denemeler anlamsızdır, doğrudan Katman 2'ye devredilir. Diğer geçici
 * hatalarda (ağ hatası, bilinmeyen durum vb.) normal şekilde beklenip tekrar
 * denenir. Tüm denemeler/erken çıkış sonrası hataya `gecici=true` işareti
 * koyup fırlatır — bu işaret, çağıranın (Main.js > doPost / retry/RetryCore.js)
 * mesajı Katman 2'ye (saatlik tekrar deneme kuyruğu) devretmesi gerektiğinin
 * sinyalidir.
 * @param {string} userText
 * @param {number} mesajZamaniSaniye
 * @param {number} maxDeneme
 * @param {Array<number>} gecikmelerMs maxDeneme-1 uzunluğunda, denemeler arası bekleme (ms).
 * @return {Array<Object>} Ortak `parts` dizisi.
 */
function llmIleTekrarDeneme_(
  userText,
  mesajZamaniSaniye,
  maxDeneme,
  gecikmelerMs,
) {
  var sonHata;
  for (var i = 0; i < maxDeneme; i++) {
    try {
      return llmCagir_(CONFIG.llm.prod, userText, mesajZamaniSaniye);
    } catch (err) {
      sonHata = err;
      if (!hataGeciciMi_(err)) {
        throw err; // kalıcı — deneme hakkı harcamadan hemen çık
      }
      if (hataYuksekTalepMi_(err)) {
        log_("llm.yuksek-talep-dogrudan-katman2", {
          deneme: i + 1,
          hata: err.message,
        });
        break; // sebep bilindiği için daha fazla hızlı deneme yapılmaz
      }
      log_("llm.tekrar-deneme", {
        deneme: i + 1,
        maxDeneme: maxDeneme,
        hata: err.message,
      });
      if (i < maxDeneme - 1) {
        Utilities.sleep(gecikmelerMs[i]);
      }
    }
  }
  sonHata.gecici = true;
  throw sonHata;
}

/**
 * Katman 1'in (llmIleTekrarDeneme_) tüm denemeleri geçici bir hatayla
 * tükendiğinde kullanıcıya gönderilen mesaj — mevcut generic "⚠️ Bir hata
 * oluştu" yerine, mesajın KAYBOLMADIĞINI ve otomatik tekrar denenecek
 * olduğunu açıkça belirtir.
 */
const LLM_YOGUN_KULLANICI_MESAJI =
  "⏳ Yapay zeka servisi şu an yoğun ya da erişilemiyor. Mesajınız kaybolmadı — " +
  "otomatik olarak tekrar denenecek, sonucu ayrıca bildireceğim. Elle " +
  "tekrar göndermenize gerek yok.";

/**
 * Bir kullanıcı mesajını uçtan uca işler: LLM'i (Katman 1 tekrar
 * denemeyle) çağırır, dönen fonksiyon çağrılarını çalıştırır, sonucu tek bir
 * Telegram cevap metnine birleştirir. `Main.js > doPost`'un ilk (canlı)
 * denemesi VE `retry/RetryCore.js > zamanlanmisTekrarDenemeyiIsle`'ın
 * gecikmeli denemeleri AYNI bu fonksiyonu kullanır — LLM çağırma/fonksiyon
 * çalıştırma/cevap birleştirme mantığı iki yerde ayrı ayrı yazılmaz. Hata
 * durumunda (geçici ya da kalıcı) olduğu gibi fırlatır; Telegram'a ne
 * gönderileceğine çağıran karar verir.
 * @param {string} text
 * @param {number} mesajZamaniSaniye
 * @return {string}
 */
function mesajiIsleVeYanitla_(text, mesajZamaniSaniye) {
  var parts = llmIleTekrarDeneme_(
    text,
    mesajZamaniSaniye,
    LLM_MAX_DENEME,
    LLM_RETRY_GECIKMELER_MS,
  );
  return islemSonuclariniBirlestir_(llmPartsGenislet_(parts));
}
