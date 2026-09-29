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

/** LLM'in döndürdüğü fonksiyon adını (bkz. Expenses.js) gerçek implementasyona eşler. */
const FUNCTION_MAP = {
  harcamaEkle: harcamaEkle,
  taksitliHarcamaEkle: taksitliHarcamaEkle,
  sonHarcamalariGetir: sonHarcamalariGetir,
  sonHarcamalariTopla: sonHarcamalariTopla,
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
 * LLM'e gönderilen systemInstruction şablonu. {ZAMAN_BAGLAMI} her istekte
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
  "- Ev ↔ Yemek (gıda alımı): bağlam bazlı karar — dışarıdayken/bir aktivite",
  "  sırasında ya da sonrasında anlık tüketmek için alınan atıştırmalık/içecek",
  "  → Yemek; markette toplu/stoklamak amacıyla alınan gıda → Ev (malzeme",
  '  alanına "Market" yaz).',
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
  '- "spor sonrası atıştırmalık aldım" → Yemek (aktivite sonrası anlık',
  "  tüketim, market alışverişi değil)",
  '- "markette atıştırmalık stoku aldım" → Ev (toplu/stoklama amaçlı market',
  "  alışverişi)",
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
  return islemSonuclariniBirlestir_(parts);
}
