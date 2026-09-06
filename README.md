# gider-isleyici — Telegram Harcama Botu

`gider-isleyici`, Google Apps Script tabanlı bir Telegram harcama botudur.
Telegram'a Türkçe doğal dille yazılan harcama mesajları Gemini function
calling ile ayrıştırılıp, bu Apps Script projesinin bağlı olduğu Google
Sheets tablosuna doğrudan yazılır.

## Gerekli Script Properties

Apps Script editöründe **Project Settings → Script Properties** kısmından
ekleyin:

| Anahtar               | Zorunlu                       | Açıklama                                                                                                                                                |
| --------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY`      | ✅                            | Google AI Studio / Gemini API anahtarı                                                                                                                  |
| `TELEGRAM_TOKEN`      | ✅                            | BotFather'dan alınan bot token'ı                                                                                                                        |
| `CHAT_ID`             | önerilir                      | Botu kullanacak kişinin Telegram chat id'si. Boş bırakılırsa **herkes** webhook URL'ine mesaj gönderip botu kullanabilir                                |
| `TEST_MODE`           | opsiyonel                     | `"true"` verilirse prod tablo yerine `TEST_SPREADSHEET_ID` kullanılır                                                                                   |
| `TEST_SPREADSHEET_ID` | `TEST_MODE=true` iken zorunlu | Test/kopya spreadsheet ID'si                                                                                                                            |
| `SHEET_NAME`          | opsiyonel                     | Belirli bir sayfa (tab) adı; boşsa spreadsheet'teki ilk sayfa kullanılır                                                                                |
| `WEBAPP_URL`          | önerilir                      | Deploy sonrası **Manage deployments**'tan kopyaladığınız `/exec` URL'i. `kurulumWebhook()`'un doğru URL'i kullanmasını garantiler (bkz. Kurulum adım 4) |

## Kurulum

1. Bu repoyu bir Apps Script projesine bağlayın:

   ```bash
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

## Sorun giderme — `webhookDurumu()`

Bot **aynı cevabı tekrar tekrar gönderiyorsa** ya da **hiç cevap vermiyorsa**,
ilk bakılacak yer editörden elle çalıştırılan `webhookDurumu()` fonksiyonudur.
Telegram'ın `getWebhookInfo` çıktısını loglar; önemli alanlar:

| Alan                   | Ne anlama gelir                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `url`                  | Webhook'un bağlı olduğu adres. Boşsa webhook kurulu değil; `/dev` ile bitiyorsa yanlış (anonim çağrılarda 401 verir) |
| `pending_update_count` | Teslim edilememiş, kuyrukta bekleyen update sayısı. Sıfırdan büyükse teslimat tıkanmış demektir                     |
| `last_error_message`   | Telegram'ın teslimatı neden başarısız saydığı — yanıt zaman aşımı mı, 2XX olmayan bir yanıt mı                      |

### Tekrar eden mesajlar

Telegram, webhook isteğine 2XX dışı bir yanıt aldığında **aynı update'i üstel
geri çekilmeyle saatlerce yeniden gönderir**. Bot kendi mesajlarını asla geri
almaz — tekrar eden mesajların sebebi her zaman budur, bir yankı döngüsü değil.

**Kök sebep ve düzeltmesi:** Apps Script Web App'e gelen POST önce bir Google
front-end sunucusuna düşer ve `ContentService` çıktısında bu sunucu `302 Found`
ile yönlendirme yapar. Telegram doğrudan 2XX bekler, redirect'i takip etmez ve
teslimatı başarısız sayar. Bu yüzden `respondOk_()` **`HtmlService.
createHtmlOutput()`** kullanır — `ContentService`'e geri dönülmemelidir.

**Savunma katmanı:** `doPost` ayrıca `update_id` bazlı dedup uygular
(`isYeniUpdate_`, `Main.js`): işlenmiş en yüksek `update_id`, işlemin
**başında** Script Properties'e (`SON_UPDATE_ID`) yazılır. `update_id` kesin
artan olduğu için gelen id bu işaretten büyük değilse update sessizce atlanır.
Süresi dolmaz, büyümez. Yani bir mesaj **en fazla bir kez** işlenir: tek cevap,
tabloda tek satır.

> ⚠️ Bot token'ı değişirse `update_id` sayacı sıfırlanır. Script
> Properties'ten `SON_UPDATE_ID`'yi **elle silin**, aksi halde yeni botun tüm
> mesajları "eski" sayılıp atlanır.

Doğru çalıştığının kanıtı `webhookDurumu()` çıktısıdır: `last_error_message`
**olmamalı**, `pending_update_count` **0** olmalı. Executions listesinde de bir
mesaj için tek bir `doPost` görünmelidir.

### Logları göremiyorum

Apps Script, **anonim çağıranlar** tarafından tetiklenen Web App
execution'larının Cloud günlüklerini, projeye standart bir GCP projesi
bağlanmadıkça sahibine göstermez. Telegram anonim bir çağıran olduğu için
Executions listesinde `doPost` satırları **görünür ama açılıp log okunamaz** —
`Execute as: Me` olması bunu değiştirmez.

Logları görmek için Project Settings → **Google Cloud Platform (GCP) Project**
kısmından standart bir GCP projesi bağlayın; ardından loglar Cloud Logging'de
(Logs Explorer) tam olarak görünür.

Bu yapılmadan da doğrulanabilecek iki şey var ve bunlar her zaman görünür:
execution **sayısı** ve **süreleri**, bir de **durum sütunu** (Tamamlandı /
Başarısız). Cevapsız kalan bir mesajda durum sütunu tek başına çok şey söyler.

## Dosya yapısı

Kod, sorumluluklarına göre 3 dosyaya ayrılmıştır (Apps Script'te tüm proje
dosyaları aynı global scope'u paylaşır, dosya sırası önemli değildir):

| Dosya         | İçerik                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Config.js`   | `CONFIG`, `TIME_ZONE`, `SHEET_LAYOUT`, `TOOLS` (Gemini function declarations)                                          |
| `Expenses.js` | Sheets D:I yazma/okuma/sıralama yardımcıları + `harcamaEkle` / `sonHarcamalariGetir` / `sonHarcamalariTopla`           |
| `Main.js`     | `FUNCTION_MAP`, Gemini REST entegrasyonu, Telegram entegrasyonu, `update_id` dedup (`isYeniUpdate_`), `doPost` giriş noktası, `kurulumWebhook`/`webhookDurumu`/`webhookSil` |

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

## clasp.json

{
"scriptId": "SCRIPT_ID",
"rootDir": "",
"scriptExtensions": [".js", ".gs"],
"htmlExtensions": [".html"],
"jsonExtensions": [".json"],
"filePushOrder": [],
"skipSubdirectories": false
}
