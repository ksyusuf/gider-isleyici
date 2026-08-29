/**
 * ============================================================================
 * Gider İşleyici — Konfigürasyon ve Gemini Tool Şeması
 * ============================================================================
 * Sır/ortam bilgileri (CONFIG), sheet düzeni sabitleri (SHEET_LAYOUT) ve
 * Gemini'ye gönderilen function-calling şemaları (TOOLS) burada tutulur.
 *
 * İlgili diğer dosyalar:
 *   - Expenses.js: Sheets erişim yardımcıları + harcamaEkle / sonHarcamalariGetir / sonHarcamalariTopla
 *   - Main.js: Gemini/Telegram entegrasyonu, doPost giriş noktası, FUNCTION_MAP
 */

// ============================================================================
// CONFIG / SHEET_LAYOUT
// ============================================================================

/** Sır/ortam bilgileri — asla kod içine sabit yazılmaz, Script Properties'ten okunur. */
const CONFIG = {
  geminiApiKey:
    PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY"),
  geminiModel: "gemini-3.5-flash",
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
// TOOLS — Gemini function declarations
// ============================================================================

/**
 * Gemini'ye her istekte gönderilen fonksiyon şemaları. Her parametrenin
 * description'ı, Main.js'teki systemInstruction'daki kurallarla kasıtlı
 * olarak örtüşür (çift katman: tek başına systemInstruction'a güvenilmez).
 */
const TOOLS = [
  {
    name: "harcamaEkle",
    description:
      "Kullanıcının doğal dilde belirttiği TEK bir harcama kalemini tabloya ekler. " +
      "Sadece tutar, tarih ve tür/kategori kesin ve tartışmasız biçimde belirlenebiliyorsa " +
      "çağır; aksi halde bu kalem için ÇAĞIRMA ve belirsizliği metin yanıtında açıkla.",
    parameters: {
      type: "OBJECT",
      properties: {
        tutar: {
          type: "NUMBER",
          description:
            "Harcamanın TL cinsinden tutarı. Açık ve sayısal olmalı (örn. 150). " +
            "'birkaç lira', 'epey para' gibi belirsiz ifadelerde bu alanı DOLDURMA " +
            "ve fonksiyonu çağırma.",
        },
        kategori: {
          type: "STRING",
          description:
            "Harcamanın türü/kategorisi (örn. Yemek, Ulaşım, Market, Kişisel, Fatura). " +
            "Metinden makul biçimde çıkarılamıyorsa bu alanı doldurma ve fonksiyonu çağırma.",
        },
        aciklama: {
          type: "STRING",
          description:
            "tutar/kategori/tarih/firma/malzeme alanlarının hiçbirine tam oturmayan ama " +
            "harcamayla ilgili ek bilgi: kiminle/kimin için yapıldığı, sebep, not vb. Opsiyonel.",
        },
        tarih: {
          type: "STRING",
          description:
            "Harcamanın tarihi, YYYY-MM-DD formatında MUTLAK tarih (asla 'dün' gibi göreceli " +
            "metin gönderme). systemInstruction'daki ZAMAN BAĞLAMI kurallarına göre, mesajın " +
            "gönderildiği tarihe göre hesapla. Kullanıcı hiç tarih belirtmediyse mesajın " +
            "gönderildiği günü (bugün) kullan — bu belirsizlik sayılmaz. Hangi güne karşılık " +
            "geldiği gerçekten belirsizse bu alanı doldurma ve fonksiyonu çağırma.",
        },
        firma: {
          type: "STRING",
          description:
            "Harcamanın yapıldığı firma/işletme/yer adı (varsa, örn. 'Migros', 'Starbucks'). Opsiyonel.",
        },
        malzeme: {
          type: "STRING",
          description:
            "Satın alınan somut ürün/malzeme adı (varsa, örn. 'Ekmek', 'Bilet'). Opsiyonel.",
        },
      },
      required: ["tutar", "kategori"],
    },
  },
  {
    name: "sonHarcamalariGetir",
    description:
      "En son eklenen harcamaları listeler (tablo tarihe göre azalan sıralı olduğundan " +
      "'son eklenenler' tablonun en üstündeki satırlardır).",
    parameters: {
      type: "OBJECT",
      properties: {
        adet: {
          type: "NUMBER",
          description:
            "Listelenecek harcama sayısı. Belirtilmezse 5 kullanılır.",
        },
      },
      required: [],
    },
  },
  {
    name: "sonHarcamalariTopla",
    description: "En son eklenen N adet harcamanın toplam tutarını hesaplar.",
    parameters: {
      type: "OBJECT",
      properties: {
        adet: {
          type: "NUMBER",
          description: "Toplanacak son harcama sayısı.",
        },
      },
      required: ["adet"],
    },
  },
];
