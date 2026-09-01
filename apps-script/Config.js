/**
 * ============================================================================
 * Gider İşleyici — Konfigürasyon ve Gemini Tool Şeması
 * ============================================================================
 * Sır/ortam bilgileri (CONFIG), sheet düzeni sabitleri (SHEET_LAYOUT), sabit
 * harcama kategorileri (KATEGORILER) ve Gemini'ye gönderilen function-calling
 * şemaları (TOOLS) burada tutulur.
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
 *   tam title-case biçimde yazılır — hem Gemini enum üyesi hem de sheet'e
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
      "Ev eşyası, mobilya, ev tadilat/bakım harcamaları ve market/gıda " +
      'alışverişi (market alışverişinde malzeme alanına "Market" yazılır).',
    kapsamaz:
      "Dışarıdayken veya bir aktivite sırasında/sonrasında anlık tüketim " +
      "amacıyla alınan atıştırmalık/içecek (bkz. Yemek).",
  },
  {
    ad: "Yemek",
    anahtar: "YEMEK",
    kapsar:
      "Dışarıda yenilen veya sipariş edilen yemekler. Dışarıdayken/bir " +
      "aktivite sırasında veya sonrasında anlık tüketim amacıyla alınan " +
      "atıştırmalık/içecek de buraya girer.",
    kapsamaz:
      "Kafede yenilen/içilen her şey; mekan kafeyse ürün ne olursa olsun " +
      "kategori Cafe'dir. Markette toplu/stoklamak amacıyla alınan gıda " +
      "(bkz. Ev).",
  },
  {
    ad: "Cafe",
    anahtar: "CAFE",
    kapsar:
      "Sohbet/vakit geçirme amaçlı kafe harcamaları; mekan kafeyse ürün ne " +
      "olursa olsun (kahve, tost, tatlı) buraya girer.",
  },
  {
    ad: "Spor",
    anahtar: "SPOR",
    kapsar:
      "Sportif faaliyetlerin tümü: salon üyeliği, ders ücreti, spor " +
      "ekipmanı/malzemesi.",
    kapsamaz: "Spor kıyafeti/ayakkabısı (bkz. Giyim).",
  },
  {
    ad: "Elektronik",
    anahtar: "ELEKTRONIK",
    kapsar:
      "Fiziksel elektronik cihaz/ürün satın alımları (telefon, kulaklık, " +
      "şarj aleti vb.).",
    kapsamaz: "Yazılım/uygulama/dijital hizmet (bkz. Dijital).",
  },
  {
    ad: "Araç",
    anahtar: "ARAC",
    kapsar:
      "Kullanıcının kendi aracının bakım ve giderleri: yakıt, bakım, " +
      "tamir, sigorta, muayene, kendi aracıyla otopark.",
    kapsamaz:
      "Araç kiralama (bkz. Kiralama), kendi aracı dışındaki ulaşım " +
      "(bkz. Ulaşım).",
  },
  {
    ad: "Kişisel",
    anahtar: "KISISEL",
    kapsar:
      "Kişisel bakım/kozmetik harcamaları ve kırtasiye/küçük ofis-ev " +
      "malzemesi.",
  },
  {
    ad: "Destek",
    anahtar: "DESTEK",
    kapsar:
      "Karşılıksız verilen paralar: düğün/davet takı-nakit hediyeleri, " +
      "sadaka, zekat, karşılıksız (faizsiz) verilen borçlar.",
    kapsamaz: "Somut hediye eşyası (bkz. Hediye).",
  },
  {
    ad: "Giyim",
    anahtar: "GIYIM",
    kapsar: "Giyim eşyası (spor kıyafeti/ayakkabısı dahil).",
  },
  {
    ad: "Eğlence",
    anahtar: "EGLENCE",
    kapsar: "Sinema, konser, oyun bileti gibi organize eğlence etkinlikleri.",
    kapsamaz: "Kafede sohbet/vakit geçirme (bkz. Cafe).",
  },
  {
    ad: "Ulaşım",
    anahtar: "ULASIM",
    kapsar:
      "Kendi aracı dışındaki ulaşım: otobüs, metro, akbil/abonman, " +
      "taksi/uber, uçak/tren bileti.",
  },
  {
    ad: "Hastane",
    anahtar: "HASTANE",
    kapsar: "Sağlık/tıbbi harcamalar: doktor, eczane/ilaç/vitamin, tedavi.",
    kapsamaz: "Kozmetik/bakım ürünü (bkz. Kişisel).",
  },
  {
    ad: "Hediye",
    anahtar: "HEDIYE",
    kapsar: "Somut hediye eşyaları.",
    kapsamaz: "Nakit/altın karşılıksız yardım (bkz. Destek).",
  },
  {
    ad: "Eğitim",
    anahtar: "EGITIM",
    kapsar: "Eğitim, kurs, ders kitabı vb. harcamalar.",
  },
  {
    ad: "Kiralama",
    anahtar: "KIRALAMA",
    kapsar: "Araç, ev veya başka bir şeyin kiralanması (ev kirası dahil).",
  },
  {
    ad: "Fatura",
    anahtar: "FATURA",
    kapsar:
      "Elektrik, su, doğalgaz, internet, telefon hattı gibi altyapı/hat " +
      "sağlayıcısına yapılan zorunlu düzenli ödemeler.",
    kapsamaz: "İçerik/yazılım platformu abonelikleri (bkz. Dijital).",
  },
  {
    ad: "Dijital",
    anahtar: "DIJITAL",
    kapsar:
      "Netflix, Spotify, bulut depolama, yazılım/uygulama abonelikleri, " +
      "dijital oyun/uygulama satın alımı (tek seferlik dahil).",
    kapsamaz:
      "Fiziksel cihaz satın alımı (bkz. Elektronik), altyapı/hat faturası " +
      "(bkz. Fatura).",
  },
];

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
          enum: KATEGORILER.map(function (k) {
            return k.ad;
          }),
          description:
            "Harcamanın kategorisi. KATEGORILER listesinden (enum) BİREBİR birini " +
            "seç; listede olmayan ya da benzetilmiş yeni bir kategori ASLA üretme. " +
            "Kategori tanımları ve ayrım kuralları systemInstruction'da verilmiştir; " +
            "hangi kategoriye karşılık geldiği net değilse bu alanı doldurma ve " +
            "fonksiyonu çağırma.",
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
    name: "taksitliHarcamaEkle",
    description:
      "Kullanıcının taksitli olarak yaptığı TEK bir harcamayı otomatik olarak " +
      "taksitSayisi kadar ayrı satıra böler (her biri ilgili ayın aynı gününde, " +
      "açıklamasında 'k/N' etiketiyle). Taksit tarihi/tutarı hesaplaması KODDA " +
      "yapılır, sen sadece alanları eksiksiz çıkarırsın. tutar, tutarTipi, " +
      "taksitSayisi ve kategori kesin ve tartışmasız biçimde belirlenebiliyorsa " +
      "çağır; aksi halde ÇAĞIRMA ve belirsizliği metin yanıtında açıkla.",
    parameters: {
      type: "OBJECT",
      properties: {
        tutar: {
          type: "NUMBER",
          description:
            "Kullanıcının belirttiği tutar — tutarTipi'ne göre TOPLAM tutar ya " +
            "da TEK bir taksidin tutarı olabilir (ikisi karıştırılmamalı, bkz. " +
            "tutarTipi).",
        },
        tutarTipi: {
          type: "STRING",
          enum: ["TOPLAM", "TAKSIT_BASI"],
          description:
            "Yukarıdaki tutar alanının anlamı. 'toplamda/toplam X TL'ye', " +
            "'X TL'yi N taksitte' gibi ifadeler TOPLAM'a; 'ayda/taksit başına " +
            "X TL', 'her ay X TL ödeyeceğim' gibi ifadeler TAKSIT_BASI'na " +
            "işaret eder. Metinden hangisi olduğu net çıkarılamıyorsa bu alanı " +
            "doldurma ve fonksiyonu çağırma — kullanıcıya toplam mı taksit " +
            "başı mı olduğunu sor.",
        },
        taksitSayisi: {
          type: "NUMBER",
          description: "Taksit sayısı (N). En az 2 olmalı.",
        },
        kategori: {
          type: "STRING",
          enum: KATEGORILER.map(function (k) {
            return k.ad;
          }),
          description:
            "Harcamanın kategorisi — harcamaEkle'deki kategori alanıyla " +
            "BİREBİR aynı kurallar geçerlidir (KATEGORILER listesinden birebir " +
            "seç).",
        },
        ilkTarih: {
          type: "STRING",
          description:
            "İlk taksidin tarihi, YYYY-MM-DD formatında MUTLAK tarih. " +
            "harcamaEkle'deki tarih alanıyla AYNI ZAMAN BAĞLAMI kurallarıyla " +
            "hesapla; kullanıcı tarih belirtmediyse mesajın gönderildiği günü " +
            "kullan.",
        },
        firma: {
          type: "STRING",
          description:
            "Harcamanın yapıldığı firma/işletme/yer adı (varsa). Opsiyonel.",
        },
        malzeme: {
          type: "STRING",
          description: "Satın alınan somut ürün/malzeme adı (varsa). Opsiyonel.",
        },
        aciklama: {
          type: "STRING",
          description:
            "Ek bilgi (opsiyonel). Her satırın açıklamasına otomatik eklenen " +
            "'(k/N)' etiketinden ÖNCE, ham haliyle verilir.",
        },
      },
      required: ["tutar", "tutarTipi", "taksitSayisi", "kategori"],
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
