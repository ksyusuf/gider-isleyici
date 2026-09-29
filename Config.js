/**
 * ============================================================================
 * Gider İşleyici — Konfigürasyon ve LLM Tool Şeması
 * ============================================================================
 * Sır/ortam bilgileri (CONFIG), sheet düzeni sabitleri (SHEET_LAYOUT), sabit
 * harcama kategorileri (KATEGORILER) ve LLM'e gönderilen function-calling
 * şemaları (TOOLS) burada tutulur.
 *
 * İlgili diğer dosyalar:
 *   - Expenses.js: Sheets erişim yardımcıları + harcamaEkle / sonHarcamalariGetir / sonHarcamalariTopla
 *   - Main.js: doPost giriş noktası; LLM.js: FUNCTION_MAP, LLM entegrasyonu
 */

// ============================================================================
// CONFIG / SHEET_LAYOUT
// ============================================================================

/**
 * Bir LLM profilini Script Properties'ten okur. Öneke göre:
 * <ONEK>_PROVIDER (varsayılan "groq"), <ONEK>_API_KEY, <ONEK>_MODEL,
 * <ONEK>_REASONING_EFFORT (opsiyonel).
 * Model adı kodda sabit DEĞİL — değiştirmek için redeploy gerekmez.
 * @param {string} onek "LLM_PROD" | "LLM_TEST"
 * @return {{provider:string, apiKey:?string, model:?string}}
 */
function llmProfilOku_(onek) {
  var p = PropertiesService.getScriptProperties();
  return {
    provider: p.getProperty(onek + "_PROVIDER") || "groq",
    apiKey: p.getProperty(onek + "_API_KEY"),
    model: p.getProperty(onek + "_MODEL"),
    // Opsiyonel: reasoning_effort ("low"|"medium"|"high"). Doğruluk öncelikli olduğundan prod/test için "medium" önerilir; boşsa gönderilmez (modelin varsayılanı).
    reasoningEffort: p.getProperty(onek + "_REASONING_EFFORT") || null,
  };
}

/** Sır/ortam bilgileri — asla kod içine sabit yazılmaz, Script Properties'ten okunur. */
const CONFIG = {
  // LLM profilleri: prod (doPost + retry akışı) ve test (yalnızca LLMTest.js).
  llm: {
    prod: llmProfilOku_("LLM_PROD"),
    test: llmProfilOku_("LLM_TEST"),
  },
  telegramToken:
    PropertiesService.getScriptProperties().getProperty("TELEGRAM_TOKEN"),
  chatId: PropertiesService.getScriptProperties().getProperty("CHAT_ID"),
  // Test modu: prod tabloya dokunmadan geliştirme/test yapabilmek için.
  testMode:
    PropertiesService.getScriptProperties().getProperty("TEST_MODE") === "true",
  testSpreadsheetId: PropertiesService.getScriptProperties().getProperty(
    "TEST_SPREADSHEET_ID",
  ),
  // Boş bırakılırsa ilk sayfa (Sheets sekmesi) kullanılır.
  sheetName: PropertiesService.getScriptProperties().getProperty("SHEET_NAME"),
  // Web App deployment'ının /exec URL'i. ScriptApp.getService().getUrl() editörden
  // elle çalıştırıldığında (gerçek bir web isteği bağlamı olmadan) güvenilir biçimde
  // /exec değil /dev (test deployment) URL'i döndürebiliyor; bu yüzden deploy sonrası
  // gerçek /exec URL'i buraya Script Property olarak girilip kurulumWebhook() bu
  // değeri önceliklendiriyor. Bkz. Main.js > kurulumWebhook().
  webAppUrl: PropertiesService.getScriptProperties().getProperty("WEBAPP_URL"),
};

/** Saat dilimi: tarih biçimlendirme ve göreceli tarih hesapları için sabit. */
const TIME_ZONE = "Europe/Istanbul";

/**
 * Sheet'teki veri bloğunun konumu. Orijinal Python akışında (services/SheetsGoogle.py)
 * harcamalar D3:I3 aralığından itibaren ekleniyordu (D=TARİH, E=TUTAR, F=FİRMA,
 * G=TÜR, H=MALZEME, I=AÇIKLAMA). Gerçek tablonuz farklı bir satır/sütundan
 * başlıyorsa sadece bu sabitleri güncellemeniz yeterli.
 */
const SHEET_LAYOUT = {
  START_ROW: 3,
  START_COL: 4, // D sütunu
  NUM_COLS: 6, // D..I
};

// ============================================================================
// KATEGORILER — sabit harcama kategorisi listesi
// ============================================================================

/**
 * Kanonik, sabit kategori listesi (bkz. apps-script/CLAUDE.md > madde 11,
 * kullanıcıyla 2026-08-31'de kesinleştirildi — yeniden tartışılmadan
 * korunmalı). TEK KAYNAK budur: `TOOLS`'taki `kategori` enum'u ve
 * `Main.js`'teki systemInstruction'a gömülen kategori tanımları buradan
 * üretilir, aksi halde iki yerde tutulan tanımlar zamanla birbirinden sapar.
 *
 * - `ad`: kanonik görünen isim; `harfBuyukYap_`'ın (Expenses.js) üreteceği
 *   tam title-case biçimde yazılır — hem LLM enum üyesi hem de sheet'e
 *   yazılacak literal TÜR değeri budur.
 * - `anahtar`: ASCII büyük-harf-alt-tire kimlik; bugün kullanılmıyor ama
 *   ileride bir `BUTCE_<KATEGORI>` Script Property anahtarı olarak
 *   kullanılabilsin diye şimdiden netleştirildi.
 * - `kapsar` (zorunlu) / `kapsamaz` (yalnızca karışabilen kategorilerde var):
 *   modelin doğal dil metnindeki sinyalleri (ürün adı, mekan adı, fiil,
 *   sağlayıcı tipi) doğru kategoriyle eşleştirebilmesi için gereken tanım —
 *   enum TEK BAŞINA (isim listesi) bunun için yeterli değildir.
 */
const KATEGORILER = [
  {
    ad: "Ev",
    anahtar: "EV",
    kapsar:
      "Household goods, furniture, home repair/maintenance, and supermarket/grocery " +
      'shopping (for supermarket shopping set item to "Market").',
    kapsamaz:
      "Snacks/drinks bought for immediate consumption while out or during/after an " +
      "activity (see Yemek).",
  },
  {
    ad: "Yemek",
    anahtar: "YEMEK",
    kapsar:
      "Meals eaten out or ordered in. Also snacks/drinks bought for immediate " +
      "consumption while out or during/after an activity.",
    kapsamaz:
      "Anything eaten/drunk at a cafe: if the venue is a cafe, the category is Cafe " +
      "whatever the product. Groceries bought in bulk/to stock up at a supermarket (see Ev).",
  },
  {
    ad: "Cafe",
    anahtar: "CAFE",
    kapsar:
      "Cafe spending for chatting/hanging out; if the venue is a cafe, it belongs " +
      'here whatever the product (coffee, "tost", dessert).',
  },
  {
    ad: "Spor",
    anahtar: "SPOR",
    kapsar:
      "All sports activities: gym membership, lesson fees, sports equipment/gear.",
    kapsamaz: "Sports clothing/shoes (see Giyim).",
  },
  {
    ad: "Elektronik",
    anahtar: "ELEKTRONIK",
    kapsar:
      "Physical electronic devices/products (phone, headphones, charger, etc.).",
    kapsamaz: "Software/apps/digital services (see Dijital).",
  },
  {
    ad: "Araç",
    anahtar: "ARAC",
    kapsar:
      "Costs of the user's OWN vehicle: fuel, maintenance, repair, insurance, " +
      'inspection ("muayene"), parking with own vehicle.',
    kapsamaz:
      "Vehicle rental (see Kiralama), transport other than own vehicle (see Ulaşım).",
  },
  {
    ad: "Kişisel",
    anahtar: "KISISEL",
    kapsar: "Personal care/cosmetics and stationery/small office-home supplies.",
  },
  {
    ad: "Destek",
    anahtar: "DESTEK",
    kapsar:
      'Money given with nothing expected back: wedding/invitation cash or gold gifts ("takı"), ' +
      'charity ("sadaka"), "zekat", interest-free loans given to others.',
    kapsamaz: "Concrete gift items (see Hediye).",
  },
  {
    ad: "Giyim",
    anahtar: "GIYIM",
    kapsar: "Clothing items (including sports clothing/shoes).",
  },
  {
    ad: "Eğlence",
    anahtar: "EGLENCE",
    kapsar: "Organized entertainment: cinema, concert, game tickets.",
    kapsamaz: "Chatting/hanging out at a cafe (see Cafe).",
  },
  {
    ad: "Ulaşım",
    anahtar: "ULASIM",
    kapsar:
      'Transport other than own vehicle: bus, metro, "akbil"/pass, taxi/Uber, ' +
      "plane/train tickets.",
  },
  {
    ad: "Hastane",
    anahtar: "HASTANE",
    kapsar:
      'Health/medical costs: doctor, pharmacy ("eczane")/medicine/vitamins, treatment.',
    kapsamaz: "Cosmetic/care products (see Kişisel).",
  },
  {
    ad: "Hediye",
    anahtar: "HEDIYE",
    kapsar: "Concrete gift items.",
    kapsamaz: "Cash/gold given with nothing expected back (see Destek).",
  },
  {
    ad: "Eğitim",
    anahtar: "EGITIM",
    kapsar: "Education, courses, textbooks, etc.",
  },
  {
    ad: "Kiralama",
    anahtar: "KIRALAMA",
    kapsar: "Renting a vehicle, home, or anything else (including house rent).",
  },
  {
    ad: "Fatura",
    anahtar: "FATURA",
    kapsar:
      "Mandatory recurring payments to infrastructure/line providers: electricity, " +
      "water, natural gas, internet, phone line.",
    kapsamaz: "Content/software platform subscriptions (see Dijital).",
  },
  {
    ad: "Dijital",
    anahtar: "DIJITAL",
    kapsar:
      "Netflix, Spotify, cloud storage, software/app subscriptions, digital " +
      "game/app purchases (including one-off).",
    kapsamaz:
      "Physical device purchases (see Elektronik), infrastructure/line bills (see Fatura).",
  },
];

// ============================================================================
// TOOLS — LLM function declarations
// ============================================================================

/**
 * LLM'e her istekte gönderilen fonksiyon şemaları. Tool/parametre adları ve
 * description'lar İNGİLİZCE (Türkçe bitişik adlar modelde bozuluyordu, bkz.
 * CLAUDE.md); `category` enum değerleri TÜRKÇE (sheet'e literal yazılır). Kurallar
 * systemInstruction'da (LLM.js) TEK yerde tutulur — burada yalnızca kısa alan
 * anlamı + şema zorlaması (enum/required) var. Türkçe iç adlara çeviri:
 * LLM.js > FUNCTION_MAP.
 */
const TOOLS = [
  {
    name: "add_expenses",
    description:
      "Record one or more expense items in a SINGLE call: put EVERY expense of the " +
      "message in the `expenses` array, one element per item (a single expense = a " +
      "one-element array). Include only items whose amount, date and category are " +
      "unambiguous; for the others do not add an element and ask the user (in Turkish).",
    parameters: {
      type: "OBJECT",
      properties: {
        expenses: {
          type: "ARRAY",
          description: "One element per expense item, in the order they appear.",
          items: {
            type: "OBJECT",
            properties: {
              amount: {
                type: "NUMBER",
                description: "Amount in TL as a plain number (e.g. 150).",
              },
              category: {
                type: "STRING",
                enum: KATEGORILER.map(function (k) {
                  return k.ad;
                }),
                description: "Exactly one of the listed Turkish category names.",
              },
              date: {
                type: "STRING",
                description:
                  "Absolute date YYYY-MM-DD, resolved against the message time. " +
                  "Omit only if the user gave no date (today is then used).",
              },
              merchant: {
                type: "STRING",
                description:
                  "Optional. Specific business name, Turkish suffixes removed.",
              },
              item: {
                type: "STRING",
                description: "Optional. Concrete product/item bought.",
              },
              note: {
                type: "STRING",
                description:
                  "Optional. Relevant extra info that fits no other field. Omit if none.",
              },
            },
            required: ["amount", "category"],
          },
        },
      },
      required: ["expenses"],
    },
  },
  {
    name: "add_installment_expense",
    description:
      "Add ONE purchase paid in installments; the code splits it into rows, do NOT " +
      "compute dates or amounts yourself. Call only when amount, amount_type, " +
      "installment_count and category are unambiguous; otherwise ask the user (in Turkish).",
    parameters: {
      type: "OBJECT",
      properties: {
        amount: {
          type: "NUMBER",
          description:
            "Amount in TL as stated by the user; its meaning is given by amount_type.",
        },
        amount_type: {
          type: "STRING",
          enum: ["TOTAL", "PER_INSTALLMENT"],
          description:
            "TOTAL if amount is the whole price, PER_INSTALLMENT if it is one installment.",
        },
        installment_count: {
          type: "NUMBER",
          description: "Number of installments, at least 2.",
        },
        category: {
          type: "STRING",
          enum: KATEGORILER.map(function (k) {
            return k.ad;
          }),
          description: "Exactly one of the listed Turkish category names.",
        },
        first_date: {
          type: "STRING",
          description:
            "Date of the first installment, absolute YYYY-MM-DD, resolved like the expenses[].date field.",
        },
        merchant: {
          type: "STRING",
          description: "Optional. Business/place name, Turkish suffixes removed.",
        },
        item: {
          type: "STRING",
          description: "Optional. Concrete product/item bought.",
        },
        note: {
          type: "STRING",
          description: "Optional. Extra info. Omit if none.",
        },
      },
      required: ["amount", "amount_type", "installment_count", "category"],
    },
  },
  {
    name: "get_recent_expenses",
    description: "List the most recently added expenses.",
    parameters: {
      type: "OBJECT",
      properties: {
        count: {
          type: "NUMBER",
          description: "How many to list. Optional, default 5.",
        },
      },
      required: [],
    },
  },
  {
    name: "sum_recent_expenses",
    description: "Sum the amounts of the N most recently added expenses.",
    parameters: {
      type: "OBJECT",
      properties: {
        count: {
          type: "NUMBER",
          description: "How many recent expenses to sum.",
        },
      },
      required: ["count"],
    },
  },
];
