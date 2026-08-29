# Apps Script — Telegram Harcama Botu

Bu klasör, `gider-isleyici` projesinin Google Apps Script tabanlı Telegram
botunu içerir. Docs adımı olmadan, Telegram'a Türkçe doğal dille yazılan
harcama mesajları Gemini function calling ile ayrıştırılıp, bu Apps Script
projesinin bağlı olduğu Google Sheets tablosuna doğrudan yazılır.

## Gerekli Script Properties

Apps Script editöründe **Project Settings → Script Properties** kısmından
ekleyin:

| Anahtar | Zorunlu | Açıklama |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | Google AI Studio / Gemini API anahtarı |
| `TELEGRAM_TOKEN` | ✅ | BotFather'dan alınan bot token'ı |
| `CHAT_ID` | önerilir | Botu kullanacak kişinin Telegram chat id'si. Boş bırakılırsa **herkes** webhook URL'ine mesaj gönderip botu kullanabilir |
| `TEST_MODE` | opsiyonel | `"true"` verilirse prod tablo yerine `TEST_SPREADSHEET_ID` kullanılır |
| `TEST_SPREADSHEET_ID` | `TEST_MODE=true` iken zorunlu | Test/kopya spreadsheet ID'si |
| `SHEET_NAME` | opsiyonel | Belirli bir sayfa (tab) adı; boşsa spreadsheet'teki ilk sayfa kullanılır |

## Kurulum

1. Bu klasörü bir Apps Script projesine bağlayın:

   ```bash
   cd apps-script
   cp .clasp.json.example .clasp.json
   # .clasp.json içindeki scriptId'yi kendi Apps Script projenizle değiştirin
   clasp push
   ```

2. Yukarıdaki Script Properties'i girin.
3. Apps Script editöründen **Deploy → New deployment → Web app** seçip
   `Execute as: Me`, `Who has access: Anyone` ayarlarıyla deploy edin.
4. Editörden `kurulumWebhook` fonksiyonunu bir kez elle çalıştırarak Telegram
   webhook'unu bu deployment URL'ine bağlayın (loglarda Telegram'ın
   `{"ok":true, ...}` yanıtını görmelisiniz).
5. Botu Telegram'dan test edin. Webhook'u kaldırmak isterseniz `webhookSil`
   fonksiyonunu çalıştırın.

## Dosya yapısı

Kod, sorumluluklarına göre 3 dosyaya ayrılmıştır (Apps Script'te tüm proje
dosyaları aynı global scope'u paylaşır, dosya sırası önemli değildir):

| Dosya | İçerik |
|---|---|
| `Config.js` | `CONFIG`, `TIME_ZONE`, `SHEET_LAYOUT`, `TOOLS` (Gemini function declarations) |
| `Expenses.js` | Sheets D:I yazma/okuma/sıralama yardımcıları + `harcamaEkle` / `sonHarcamalariGetir` / `sonHarcamalariTopla` |
| `Main.js` | `FUNCTION_MAP`, Gemini REST entegrasyonu, Telegram entegrasyonu, `doPost` giriş noktası, `kurulumWebhook`/`webhookSil` |

## Sheets sütun sözleşmesi

`D:I` sütunları → `TARİH, TUTAR, FİRMA, TÜR, MALZEME, AÇIKLAMA`; veri
`Config.js` içindeki `SHEET_LAYOUT.START_ROW` (varsayılan `3`) satırından
itibaren yazılır ve her eklemeden sonra tablo TARİH sütununa göre azalan
sıralanır (en güncel tarih her zaman en üstte). Kendi tablonuz farklı bir
satır/sütundan başlıyorsa `Config.js` içindeki `SHEET_LAYOUT` sabitini
güncellemeniz yeterlidir.

## Test modu

`clasp push` sonrası kendi hesabınızda boş bir "test spreadsheet" oluşturup
ID'sini `TEST_SPREADSHEET_ID`'ye, `TEST_MODE`'u `"true"`'ya ayarlarsanız bot
gerçek tabloya hiç dokunmadan çalışır. Prod'a almadan önce `TEST_MODE`'u
kaldırmayı (veya `"false"` yapmayı) unutmayın.
