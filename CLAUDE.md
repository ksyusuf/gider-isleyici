# gider-isleyici — Proje Notları (Claude için)

`gider-isleyici`, Telegram'a Türkçe doğal dille yazılan harcama mesajlarını
Google Gemini function calling ile ayrıştırıp doğrudan bir Google Sheets
tablosuna (D:I sütunları) yazan bir Google Apps Script Web App'idir. Proje
eskiden bir Google Docs + Python/Flask akışı olarak başlamıştı; o akış
tamamen kaldırıldı (bkz. "Geçmiş" bölümü) ve bu proje artık tek başına bu
Apps Script akışından ibaret. Dosyaların çoğu repo kökünde; `retry/` alt
dizini SADECE Katman 2 (otomatik tekrar deneme) dosyalarını gruplar (bkz.
aşağıdaki "Ne yapıldı" ve "Script'lerin modülerleştirilmesi" bölümleri) —
Apps Script tüm dosyaları aynı global scope'ta çalıştırdığı için alt dizin
kullanımının çalışma zamanı etkisi yoktur, sadece organizasyoneldir. Detaylı
kurulum için `README.md`'ye bakın.

## Önemli Kurallar

**Asla git komutu çalıştırma** (add/commit/push/rm/mv fark etmez — hiçbiri).
Repo'nun git tarafı tamamen kullanıcının elinde; staging/commit/push işini
her zaman kullanıcı kendisi yapar.
**Asla clasp komutlarını çalıştırma** (`clasp push` dahil).
Bu iki kural yöneticinin açık isteği olmadan asla ihlal edilmez.

## CLAUDE.md bakım disiplini

Her agentic çalışma **başlamadan önce** bu dosyadaki kuralları kontrol eder.
Her agentic çalışma **bitiminde**, yapılan işleri ve alınan kararları bir
sonraki oturumun buradan doğrudan öğrenebileceği şekilde bu dosyaya işler
(yeni bölüm ekler, "Sonraki oturum için açık sorular" bölümünü günceller,
çözülen bir sorunu ilgili bölümden kaldırıp özetler vb.). Bu güncelleme
token maliyeti göz ardı edilerek **her zaman** yapılır — bu dosyanın güncel
kalması, tasarruf edilecek token'dan daha önceliklidir.

## Geçmiş: eski Python/Flask + Google Docs akışı (kaldırıldı)

Proje başlangıçta `index.py` + `services/*.py` (Flask) ile Google Docs'a
serbest-biçimli-ama-kurallı metinle girilen harcamaları ayrıştırıp aynı
Google Sheets veri sözleşmesine yazıyordu. Bu akış 2026-09-06'da tamamen
kaldırıldı (kod, `templates/`, `static/`, `requirements.txt`, `.env*`,
`keys/`, `venv/` dahil) — kullanıcı apps-script akışını tamamladı ve eski
akışa ihtiyaç kalmadı. GCP service-account anahtarları ve Netlify bağlantısı
(repo içinde hiç iz bırakmamıştı) kullanıcı tarafından harici olarak
kapatıldı/kapatılacak. Aşağıdaki "Ne yapıldı" bölümündeki
`services/SheetsGoogle.py` referansı artık repoda olmayan bu eski koda işaret
ediyor — yalnızca D:I sütun sözleşmesinin kökeni olarak tarihsel bilgi
değeri taşıyor.

## Ne yapıldı

- Kod, sorumluluklarına göre 9 dosyaya bölündü (Apps Script'te tüm dosyalar
  aynı global scope'u paylaştığı için fonksiyon adları dosyalar arası
  sorunsuz erişilebilir — fonksiyon bildirimleri proje genelinde hoisted
  olur; `retry/` bir alt dizin olsa da bu paylaşımı DEĞİŞTİRMEZ, bkz.
  "Script'lerin modülerleştirilmesi (2026-09-26)" bölümü):
  - `Config.js`: `CONFIG`, `TIME_ZONE`, `SHEET_LAYOUT`, `TOOLS` (Gemini
    function declarations şeması).
  - `Expenses.js`: Sheets D:I yazma/okuma/sıralama yardımcıları +
    `harcamaEkle` / `sonHarcamalariGetir` / `sonHarcamalariTopla`.
  - `Logging.js`: ortak loglama (`log_`, `logHata_`) — her dosyanın
    kullandığı cross-cutting altyapı.
  - `Gemini.js`: `FUNCTION_MAP`, Gemini REST entegrasyonu (v1beta
    `generateContent`, function calling, her istekte mesajın Telegram'a
    gönderildiği ana göre dinamik kurulan bir `systemInstruction`), Katman 1
    (senkron) tekrar deneme, `mesajiIsleVeYanitla_`.
  - `Telegram.js`: Telegram gönderim (`sendTelegramMessage_`), `/` komut
    işleme (`islemKomut_`), Gemini sonuçlarını cevaba birleştirme
    (`islemSonuclariniBirlestir_`).
  - `Main.js`: `update_id` bazlı dedup (`isYeniUpdate_`) ve `doPost` webhook
    giriş noktası, geliştirici yardımcı fonksiyonları (`kurulumWebhook`,
    `webhookDurumu`, `webhookSil`).
  - `Queue.js`: Fitness projesiyle paylaşılan Telegram mesaj kuyruğu
    (`kuyrugaEkle_`, bkz. aşağıdaki "Fitness projesiyle paylaşılan Telegram
    mesaj kuyruğu" bölümü).
  - `retry/RetryCore.js`: Gemini API geçici/kalıcı hatalarına karşı Katman 2
    — otomatik motor: mesaj bazlı, tek seferlik trigger'larla saatlik tekrar
    deneme (bkz. aşağıdaki "Gemini API geçici/kalıcı hatalarına karşı
    Katman 2" bölümü).
  - `retry/RetryCommands.js`: Katman 2'nin manuel komut yüzeyi
    (`/pesedilenler`, `/pesdene`) ve teşhis (`yenidenDenemeKuyruguDurumu`).
- Sheets sütun sözleşmesi repo kökündeki `services/SheetsGoogle.py`'den
  (eski Python/Flask akışı) tespit edildi: `D=TARİH, E=TUTAR, F=FİRMA, G=TÜR,
H=MALZEME, I=AÇIKLAMA`, veri `D3`'ten başlıyor, her eklemede TARİH'e göre
  azalan sıralanıyor. `SHEET_LAYOUT` sabiti (`Config.js` başında) bu
  varsayımı tek yerde topluyor.
- `appsscript.json`, `README.md` eklendi. Repo kökündeki `.gitignore`'a
  `.clasp.json` eklendi (scriptId ortam-özel); `appsscript.json` bilinçli
  olarak repoda tutuldu (sır içermiyor, `clasp push` için gerekli).

## Test durumu

**Uçtan uca çalışıyor (2026-08-30, kullanıcı onayı).** Gerçek Telegram bot
token'ı, gerçek Gemini API key'i ve gerçek spreadsheet ile deploy edildi;
selamlaşma ve harcama kaydı akışları doğrulandı.

- `CONFIG.geminiModel = "gemini-3.5-flash"` **gerçek ve çalışan bir model adı**
  olarak doğrulandı (önceki not bunun var olup olmadığından şüpheliydi).
  Yoğunluk anlarında HTTP 503 "high demand" dönebiliyor; bu geçici bir durum,
  yanlış model adı değil.

Hâlâ manuel koşulmayı bekleyen senaryolar: çoklu harcama + göreceli tarih,
belirsizlik reddi, karma senaryo (kısmi ekleme + kısmi netleştirme), yetkisiz
`chat.id`, hatalı payload.

## Tekrar teslim edilen update'ler (çözüldü — 2026-08-30)

İlk gerçek uçtan uca testte kullanıcı tek bir Telegram mesajı attı ve arka
arkaya birden fazla bot cevabı aldı; zinciri durdurmak için `webhookSil()`
çalıştırmak zorunda kaldı.

**Teşhis (Apps Script Executions logundan):** tek mesaj için 4 ayrı `doPost`
execution'ı, hepsi "Tamamlandı" (5.9 / 8.2 / 17.8 / 33.6 sn). Execution'lar hiç
örtüşmüyor ve aralar her execution bittikten sonra tam olarak **1 sn → 2 sn →
4 sn** — Telegram'ın üstel geri çekilmeli retry imzası. Yani Telegram yanıtı
her seferinde aldı, başarısız saydı ve aynı `update_id`'yi yeniden gönderdi.

**Elenen hipotezi not etmek gerekir:** "bot kendi mesajını duyuyor" geçersiz.
Telegram Bot API bir bota kendi gönderdiği mesajları update olarak geri vermez;
`sendMessage` → `doPost` şeklinde bir yankı zinciri kurulamaz.

Telegram'ın yanıtı neden başarısız saydığı iki adaydan biri — yanıtın yeterince
hızlı dönmemesi, ya da Apps Script `/exec`'in POST'a döndürdüğü **302 redirect**
(bilinen bir Apps Script webhook problemi). Bu ayrım loglardan yapılamıyor;
`webhookDurumu()`'nun `last_error_message` alanı söyler. **Çözüm her iki durumda
da aynı olduğu için** ayrım beklenmeden uygulandı.

**Uygulanan çözüm (`Main.js`):**

- `isYeniUpdate_(updateId)` — `CacheService.getScriptCache()` (script kapsamlı,
  anonim execution'lar arasında paylaşılır) + `LockService.getScriptLock()`.
  İki tasarım kararı kritik ve değiştirilmemeli:
  **(a)** işaret işin BAŞINDA atılır — tekrar teslim ilk execution hâlâ
  çalışırken gelebiliyor, sonda işaretlense ikisi de işi yapardı;
  **(b)** kilit yalnızca cache oku/yaz kritik bölümünü sarar, Gemini çağrısını
  değil — aksi halde tüm istekler seri hale gelirdi.
- Anahtar mesaj metni DEĞİL `update_id`; metin saklansaydı kullanıcı aynı metni
  bilerek iki kez yazdığında ikincisi yutulurdu.
- `webhookDurumu()` — `getWebhookInfo` teşhis yardımcısı.
- `kurulumWebhook()` artık `allowed_updates: ["message"]` gönderiyor.
- `doPost`, `e.postData` yoksa sessizce 200 dönüyor: Web App `ANYONE_ANONYMOUS`
  olduğu için URL'e gelen herhangi bir tarama isteği eskiden `JSON.parse`
  hatasına düşüp catch bloğu üzerinden **kullanıcıya Telegram'dan hata mesajı
  gönderiyordu**.

**Doğrulandı (2026-08-30):** düzeltme gerçek Telegram trafiğiyle çalışıyor;
tekrar eden mesajlar tamamen kesildi.

**Yol boyunca çıkan iki tuzak (tekrar yaşanmaması için):**

- **`clasp push` tek başına yetmiyor.** Web App `/exec`, dondurulmuş bir
  **sürüm** anlık görüntüsünü sunar; push yalnızca editördeki HEAD'i günceller.
  Manage deployments → Version: **New version** yapılmazsa `/exec` eski kodu
  çalıştırmaya devam eder. Bu bir kez atlandı ve düzeltme yayında sanılırken
  hata sürdü. Teşhis ipucu: Executions'taki **sürüm sütunu** ("Sürüm 1"), bir de
  `clasp versions` çıktısı. Editörden elle çalıştırılan fonksiyonlar (`kurulum
  Webhook` vb.) HEAD'i kullandığı için bu asimetri yanıltıcıdır.
- **Config dosyasının adı `.clasp.json`** (baştaki nokta şart). `clasp.json`
  olarak duruyordu ve `clasp push` "Project settings not found" veriyordu.

### İkinci raunt: kök sebep 302 redirect'miş (2026-08-30)

Dedup arka arkaya gelen tekrarları durdurdu ama tek bir harcama **~11 dakikada
bir** yeniden kaydedilmeye devam etti (16:38 → 16:49 → 17:00 → 17:11 → 17:22).

**Aritmetiği:** dedup işareti `CacheService`'te 600 sn duruyordu. Executions
logu adım adım gösteriyor: 16:38:00'de ilk işleme (5.383 sn) işareti koyuyor;
16:38–16:47 arası 11 retry dedup'a takılıyor (0.88–2.1 sn); işaret 16:48:00'de
doluyor ve 16:48:52'deki retry "yeni" sayılıp ikinci kaydı yazıyor (6.348 sn).
Her döngüde işaret 10 dk daha tazeleniyor. Telegram ise başarısız saydığı
teslimatı **saatlerce** yeniden dener — yani TTL retry penceresinden kısaydı.

**Ama asıl bulgu şu:** dedup'a takılan execution'lar **0.9 saniyede** 2XX
dönüyordu ve Telegram yine de tekrar deniyordu. Bu, ilk raunttan kalan "yanıt
çok yavaş" hipotezini kesin olarak eledi: Telegram yanıtı alıyor ama **kabul
etmiyordu**.

**Kök sebep:** `respondOk_()` içindeki `ContentService.createTextOutput()`.
Apps Script Web App'e gelen POST önce bir Google front-end sunucusuna düşer;
`ContentService` çıktısında bu sunucu `302 Found` + `Location` ile
`script.googleusercontent.com`'a yönlendirir. Telegram doğrudan 2XX bekler ve
**redirect'i takip etmez** → başarısız teslimat → saatlerce retry.

**Uygulanan düzeltme:**

- `respondOk_()` artık `HtmlService.createHtmlOutput("OK")` döndürüyor.
  **`ContentService`'e geri dönülmemeli** — fonksiyonun başındaki uyarı bunu
  anlatıyor.
- `isYeniUpdate_` savunma katmanı olarak kaldı ama `CacheService` yerine
  `PropertiesService`'te süresi dolmayan tek bir sayı (`SON_UPDATE_ID`)
  tutuyor. `update_id` kesin artan olduğu için anahtar kümesi gereksiz:
  gelen id saklanan işaretten büyük değilse atlanır. TTL deliği tamamen kapandı;
  CacheService'in "süresi dolmadan da tahliye edilebilir" riski de ortadan
  kalktı.

**Doğrulama sinyali:** `webhookDurumu()` çıktısında `last_error_message`
OLMAMALI ve `pending_update_count` 0 olmalı.

**⚠️ Bakım notu:** bot token'ı değişirse `update_id` sayacı sıfırlanır; Script
Properties'ten `SON_UPDATE_ID` elle silinmeli, aksi halde yeni botun tüm
mesajları "eski" sayılıp atlanır.

### Plan B — webhook yerine polling (İSTENMEDİ, ileride başvurulabilir)

Kullanıcı bunu **şimdilik istemedi**; ileride benzer bir teslimat sorunu
çıkarsa değerlendirmek üzere not edildi. Yani `HtmlService` düzeltmesi bir
şekilde yetmezse ya da Apps Script tarafında yanıt davranışı yine değişirse
başvurulacak mimari alternatif budur.

`setWebhook` tamamen kaldırılır (`webhookSil()`), yerine zamanlı bir tetikleyici
(`ScriptApp.newTrigger(...).timeBased().everyMinutes(n)`) `getUpdates` çağırır.

Neden sorunu kökten bitirir: webhook'ta teslimatı Telegram'ın "yanıtı beğenip
beğenmemesi" belirler. Polling'de böyle bir şey yoktur — **Telegram'ın kendi
`offset` mekanizması** onaylama görevini üstlenir: `getUpdates` bir sonraki
turda `offset = son_update_id + 1` ile çağrılınca eski update'ler sunucu
tarafında kapanır ve bir daha dönmez. Yani retry kavramı da, özel dedup
ihtiyacı da (`isYeniUpdate_` dahil) tamamen ortadan kalkar.

Bedeli:

- **Gecikme:** Apps Script zamanlı tetikleyicilerinin tabanı ~1 dakika; mesaj
  anında değil, en fazla o kadar sonra işlenir.
- **Kota:** bot hiç kullanılmasa bile tetikleyici sürekli çalışır ve günlük
  Apps Script çalışma süresi kotasını yer. Sık aralıklarda (1 dk) bu ciddi bir
  tüketim; 5 dk daha güvenli ama daha laggy.
- `getUpdates` ile `setWebhook` **birbirini dışlar** — webhook kuruluyken
  `getUpdates` çalışmaz, önce `webhookSil()` gerekir.

Referans: [Telegram Bot API](https://core.telegram.org/bots/api),
[GramIO getUpdates](https://gramio.dev/telegram/methods/getupdates).

## Fitness projesiyle paylaşılan Telegram mesaj kuyruğu (2026-09-04)

> **Güncelleme (2026-09-26):** Bu sekmenin şeması genişletildi — `retry/RetryCore.js`
> (Katman 2 tekrar deneme, bkz. "Script'lerin modülerleştirilmesi" bölümü)
> kendi sekmesini AÇMAK YERİNE bu `telegram_queue`
> sekmesine E:K kolonları ekledi (kullanıcı kararı). A:D (aşağıdaki
> `QUEUE_HEADERS`in ilk 4 elemanı) Fitness için DEĞİŞMEDEN sabit kalıyor;
> detay için aşağıdaki "Gemini API geçici/kalıcı hatalarına karşı Katman 2"
> bölümüne bakın.

**Problem:** Bu bot (`gider-isleyici`) ile ayrı bir Apps Script projesi olan
`Fitness` AYNI Telegram bot token'ını paylaşıyor. Fitness kendi tetikleyicisinde
(günde 3 kez) doğrudan Telegram `getUpdates` çağırıyordu. Ama Telegram bir bota
aynı anda hem webhook hem `getUpdates` polling kullanılmasına izin vermiyor
("This method will not work if an outgoing webhook is set up" — bkz. yukarıdaki
"Plan B" bölümü, resmi dokümantasyondan doğrulandı). Bu webhook burada aktif
olduğu için Fitness'in `getUpdates` çağrısı hep `ok:false` dönüyordu; Fitness'in
kodu bunu sessizce yutuyordu (hiçbir log yok), yani kullanıcının Fitness'e
yönelik mesajları (örn. "off") hiç işlenmemiş gibi kayboluyordu. Gerçek bir
vakada doğrulandı: kullanıcı bir "off" mesajı gönderdi, Fitness'in bir sonraki
tetikleyicisi bunu hiç görmedi, gün yanlışlıkla ACTIVE kaydedildi.

**Çözüm (`Queue.js`):** `setWebhook` kaldırılmadı, bu proje Telegram'ın TEK
tüketicisi olarak kaldı (Fitness'i de webhook'a taşımak ayrıca değerlendirildi
ve reddedildi — Telegram bir bota birden fazla webhook kaydına izin vermiyor,
`setWebhook` ikinci çağrıda öncekini SESSİZCE değiştirir, bu da hangi projenin
kazanacağı deploy sırasına bağlı, daha da öngörülemez bir "race condition"
yaratırdı). Bunun yerine `Main.js > doPost`, mesaj başarıyla parse edildikten
hemen sonra (`/` komut kontrolünden ÖNCE) `kuyrugaEkle_(update.update_id,
chatId, text, message.date)` çağırır — bu, harcama/spor konusu fark etmeksizin
her metin mesajını `getTargetSpreadsheet_()`'in döndürdüğü spreadsheet'teki
`telegram_queue` sekmesine (`update_id, chat_id, text, date` kolonları) ham
olarak ekler. Hiçbir sınıflandırma yapılmaz — kuyruk yazımı bilinçli olarak
"dümdüz" tutuldu, çünkü Fitness zaten kendi `tekMesajiIsle` fonksiyonunda
off/blok içermeyen mesajları sessizce eleyen bir filtreye sahip.

Fitness tarafında `yeniTelegramMesajlariniGetir` artık Telegram'a hiç
gitmiyor; `CONFIG.queueSpreadsheetId` (Script Properties: `QUEUE_SPREADSHEET_ID`)
ile bu sekmeyi okuyor. Kendi `update_id` cursor + today/yesterday/stale
etiketleme mantığı DEĞİŞMEDİ — sadece veri kaynağı değişti. Aynı tetikleyici
aralığında birden fazla farklı niyetli mesaj (örn. "bugün off" + ayrı bir
mesajda "yarın hacim") de desteklenir: Fitness zaten TÜM yeni mesajları
`update_id` sırasıyla tek tek işliyordu (sadece sonuncusunu almıyordu), bu
davranış veri kaynağı değişse de korunur.

**Kurulum adımı (bir kez, elle):** Bu proje deploy edildikten sonra Apps
Script editöründen `kuyrukSpreadsheetIdYazdir()` çalıştırılıp döndürdüğü ID,
Fitness projesinin Script Properties'ine `QUEUE_SPREADSHEET_ID` olarak
girilmeli. Fitness `SpreadsheetApp.openById()` ile bu spreadsheet'i (kendi
container-bound sheet'inden AYRI, harici bir spreadsheet olarak) açtığı için
Fitness'in bir sonraki çalıştırmasında yeni bir Google OAuth izin ekranı
çıkabilir (daha geniş Sheets erişim kapsamı gerekir) — normal, kabul edilmeli.

**Açık nokta (bilinçli olarak ertelendi):** Bu bot "off" gibi fitness-amaçlı
metinleri de Gemini'ye gönderip muhtemelen bir netleştirme cevabı döndürüyor
olabilir (kullanıcı için gereksiz ikinci bir bot cevabı). Kuyruk çözümü mesaj
KAYBINI giderir ama bu "yanlış bota cevap" gürültüsünü gidermez; istenirse
ileride bu projeye de hafif bir "muhtemelen bana ait değil" kısayolu
eklenebilir.

**Henüz yapılmadı / açık:**
- O 4 execution prod tabloya mükerrer satır yazmış olabilir. `❓ Netleştirilmesi
  gerekenler` başlığı (bkz. `islemSonuclariniBirlestir_`) yalnızca en az bir
  `harcamaEkle` başarılı olduğunda ekleniyor — kullanıcı bu başlığı gördüğüne
  göre her tekrar bir satır yazmış olabilir. Tablo elle kontrol edilmeli.
- Hızlı-ack + asenkron işleme (`doPost` hemen 200 döner, iş tek seferlik
  `ScriptApp.newTrigger().timeBased().after(1)` ile arka planda yapılır)
  bilinçli olarak yapılmadı: tetikleyici kotası ve belirgin karmaşıklık
  getiriyor, loglar timeout'tan çok backoff'lu retry'a işaret ediyor.
  `webhookDurumu()` çıktısı timeout gösterirse yeniden değerlendirilmeli.

## Gemini API geçici/kalıcı hatalarına karşı Katman 2: mesaj bazlı tekrar deneme (retry/RetryCore.js, 2026-09-25)

**Problem:** `callGemini_` (Gemini.js) Gemini'nin yoğun olduğu saatlerde (HTTP 503
"high demand", bkz. yukarıdaki "Test durumu" bölümü) sık sık hata veriyordu ve
bu hata hiç retry edilmeden doğrudan kullanıcıya "⚠️ Bir hata oluştu" olarak
gidiyordu — harcama Sheets'e hiç yazılmadan kayboluyordu, kullanıcı mesajı elle
tekrar göndermek zorunda kalıyordu. Kullanıcının isteği: Gemini'nin
yorumlayamaması (ZORUNLU NETLİK KURALI'nın netleştirme sorması) DIŞINDA hiçbir
durumda elle tekrar göndermeye gerek kalmamalı; Gemini'nin yoğun olduğu
periyotlar saatler sürebildiği için (5-10 dk'lık kısa retry'lar yetersiz) hem
hızlı hem de saatlik ölçekte bir tekrar deneme mekanizması gerekiyor.

**İki katmanlı çözüm:**

- **Katman 1 (senkron, `Gemini.js`):** `callGeminiIleTekrarDeneme_` her Gemini
  çağrısını en fazla `GEMINI_MAX_DENEME` (3) kez dener, denemeler arası kısa
  bekleme (`GEMINI_RETRY_GECIKMELER_MS`: 2sn, 5sn). Hata sınıflandırması
  `hataGeciciMi_` ile **blacklist** mantığında: sadece `GEMINI_KALICI_HTTP_KODLARI`
  (400/401/403/404) **kalıcı** sayılır ve deneme hakkı harcamadan hemen
  fırlatılır; ağ hatası, boş/beklenmeyen yanıt, bilinmeyen durum kodu dahil
  geri kalan HER ŞEY varsayılan olarak **geçici** kabul edilir (kullanıcının
  "yorumlanamaması DIŞINDA" isteğiyle uyumlu — yorumlayamama zaten bir
  exception değil, `islemSonuclariniBirlestir_`'in normal metin-cevap akışı).
  3 deneme de geçici hatayla tükenirse son hataya `err.gecici = true` işareti
  konur — bu, `doPost`'un mesajı Katman 2'ye devretme kararının sinyalidir.
  `doPost`'un ve `retry/RetryCore.js`'in Gemini çağırma + fonksiyon çalıştırma +
  cevap birleştirme mantığı **tek bir ortak fonksiyonda** (`Gemini.js >
  mesajiIsleVeYanitla_`) toplanır — iki yerde ayrı ayrı yazılmaz.

- **Katman 2 (mesaj bazlı, tek seferlik trigger'lar — `retry/RetryCore.js`):** Katman 1
  tükendiğinde **o mesaja özel, tek seferlik** bir Apps Script trigger kurulur.
  **Kasıtlı olarak sürekli/periyodik bir trigger YOK** (kullanıcı kararı, ilk
  önerilen "tek kalıcı periyodik tarayıcı" tasarımı reddedildi) — her trigger,
  bir mesajın gerçekten başarısız kalmasının doğal bir sonucu olarak kurulur.
  Aşama gecikmeleri `RETRY_BACKOFF_DAKIKA = [10, 20, 40, 60, 60, 120, 120,
  240]` (dakika, 8 aşama, toplam ~11 saat 10 dakika — 2026-09-29'da ilk üç
  aşama olarak 10-20-40 dakika eklendi, kullanıcı kararı: kısa/hızlı geçici
  blipler için önceki "1 saatte başla" çok yavaştı). Trigger ateşlendiğinde
  yine Katman 1 (3 hızlı deneme)
  çalışır; başarısızsa BİR SONRAKİ aşama için yeni trigger kurulur ve
  ÖNCEKİ (artık ateşlenmiş) trigger silinir — Apps Script'in tek seferlik
  (`after`) trigger'ları ateşlendikten sonra KENDİLİĞİNDEN silinmediği için bu
  temizlik atlanırsa proje trigger kotası (~20) sessizce tükenir.

  **Ayrı bir sekme YOK — `telegram_queue` (Queue.js) yeniden kullanılıyor
  (2026-09-26, kullanıcı kararı — ilk sürümde ayrı bir `yeniden_deneme_kuyrugu`
  sekmesi vardı, kullanıcı bunu istemedi: "mevcut kolon yapısının üzerine
  devam et").** `Queue.js > QUEUE_HEADERS` artık 12 kolon: `update_id, chat_id,
  text, date` (Fitness'in okuduğu SABİT A:D sözleşmesi, hiç değişmedi) +
  `durum, deneme_asamasi, sonraki_deneme_zamani, ilk_hata_zamani,
  son_deneme_zamani, son_hata_mesaji, trigger_id, message_id` (E:L,
  gider-isleyici'nin KENDİ retry bookkeeping'i — Fitness bunları hiç okumaz;
  `message_id` 2026-09-29'da `/sonmesajisil` için eklendi, bkz. aşağıdaki
  "2026-09-29" bölümü). `doPost` zaten HER
  metin mesajı için Gemini'den ÖNCE `kuyrugaEkle_`'yi çağırıyordu (A:D'yi
  doldurur); Gemini başarısız olduğunda `retry/RetryCore.js > kuyrukSatiriniUpdateIdIleBul_`
  AYNI satırı `update_id` ile bulup E:L'yi doldurur — YENİ bir satır asla
  eklenmez (bulunamazsa, olmaması gereken bir durum için savunma amaçlı yeni
  satır eklenir). Mevcut (retry kolonları eklenmeden önce oluşmuş, 4 kolonlu)
  production sekmesi için `getOrCreateQueueSheet_` başlık satırını sessizce
  E:L ile genişletir (tek seferlik, idempotent göç, A:D'deki veriye
  dokunmaz). Bu sekmedeki satırların TÜMÜ retry-takipli DEĞİLDİR — `durum`
  boşsa mesaj normal işlendi (ya da hiç Gemini'ye gitmedi, örn. komut).

  **8. (son, 4 saatlik) aşama da başarısız olursa sistem PES EDER** — 9. bir
  trigger KURULMAZ. Satır `durum=PES_EDILDI` olarak işaretlenir (**ASLA
  SİLİNMEZ** — bkz. aşağıdaki "FIFO temizlik" notu) ve kullanıcıya hem o
  mesaja özel bir bildirim hem de kuyrukta biriken TÜM `PES_EDILDI`
  satırlarının toplu bir özeti gönderilir (`pesEdildiBildirimGonder_`).
  Kalıcı bir HTTP hatası (400/401/403/404) alınırsa hiç retry denenmeden aynı
  PES_EDILDI yoluna girilir (`pesEdildiKuyruguEkleVeBildir_`, `doPost`'taki
  ikinci catch dalı). Sistemin en fazla ~11 saat içinde ya çözüleceği ya da
  pes edeceği garanti olduğundan, önceki taslaktaki "1 hafta sonra özel
  bildirim" fikri gereksiz hale geldi ve uygulanmadı — PES_EDILDI + toplu
  bildirim onun doğrudan yerini aldı.

  **"Yüksek talep" kısayolu (2026-09-26, kullanıcı isteği; 429 eklendi
  2026-09-29) — bkz. aşağıdaki "2026-09-29" bölümü:** Gemini'nin yaşanan
  gerçek hatalarının büyük çoğunluğu şu spesifik gövdeyle geliyor:
  `{"error":{"code":503,"message":"This model is currently experiencing high
  demand...","status":"UNAVAILABLE"}}`. Bu durumda sebep zaten KESİN olarak
  biliniyor (model o an aşırı yüklü) ve birkaç saniye arayla 3 kez hızlı
  tekrar denemek (Katman 1) bunu değiştirmez — sorun saatler sürebiliyor.
  `Gemini.js > hataYuksekTalepMi_` gövdedeki `error.status === "UNAVAILABLE"`
  alanını YA DA `httpStatus === 429`'u (kota/rate-limit dolu) tespit eder;
  tespit edilirse `callGeminiIleTekrarDeneme_` HİÇ beklemeden (sleep yok,
  kalan deneme hakları harcanmadan) doğrudan Katman 2'ye devreder. Gövde
  parse edilemez ya da farklı bir 503/geçici hata ise (örn. ağ zaman aşımı)
  normal 3-denemeli Katman 1 akışı aynen çalışmaya
  devam eder — bu kısayol SADECE bu spesifik, kesin-teşhisli duruma özeldir.

  **FIFO temizlik ve "asla unutma" ilkesi (2026-09-26, kullanıcı düzeltmesi
  — kritik, yeniden gevşetilmemeli):** İlk sürümde `eskiKayitlariTemizle_` 5
  günden eski TÜM satırları (durumu ne olursa olsun) siliyordu — bu, bir
  `PES_EDILDI` satırın (yani hiçbir yere kaydedilmemiş bir harcamanın) 5 gün
  sonra sessizce ve kalıcı olarak kaybolması demekti. Kullanıcı bunu açıkça
  reddetti: **"pes edilen mesajlar asla silinmemeli, harcamaları unutup da
  kayıt altına almamak olmaz."** Düzeltme: `BEKLIYOR`/`ISLENIYOR` (hâlâ aktif
  iş) ve `PES_EDILDI` (kullanıcının elle kaydetmesi gereken bir harcama) yaşı
  ne olursa olsun ASLA silinmez — bu kural `telegram_queue`'ya taşındıktan
  sonra da (aşağıya bkz.) DEĞİŞMEDEN korunuyor. Bunun doğal sonucu: başarıyla
  işlenen bir satır artık HEMEN silinmiyor — `TAMAMLANDI`'ya geçiyor ve ancak
  5 gün sonra temizleniyor. `yenidenDenemeKuyruguDurumu()` `tamamlanan`
  sayısını da raporluyor.

  **Silme mi, sadece kolon boşaltma mı? (2026-09-26, iki adımlı karar):**
  `telegram_queue` paylaşılan sekmeye taşınınca önce en güvenli yolu seçip
  `eskiKayitlariTemizle_`'yi satırı SİLMEYECEK, sadece E:K'yı boşaltacak
  şekilde yazdım (Fitness'in de okuduğu bir satırı silmenin onun cursor/geçmiş
  mantığını bilmediğimiz şekilde bozabileceği riskiyle). Kullanıcı bunu
  netleştirdi: **Fitness günde 3 kez çalışıp SADECE aynı günün mesajlarıyla
  ilgileniyor, 5 günden eski satırların silinmesi onun için sorun DEĞİL.**
  Bu bilgiyle `eskiKayitlariTemizle_` son haline geldi: `durum` boş (retry'a
  hiç girmemiş sıradan mesajlar) ya da `TAMAMLANDI` olan ve `date` sütunundan
  itibaren **10 günden** (kullanıcı kararıyla 5'ten 10'a çıkarıldı) eski
  satırlar **gerçekten silinir** (`sheet.deleteRow`).
  `BEKLIYOR`/`ISLENIYOR`/`PES_EDILDI` kuralı (yukarıdaki paragraf) bu
  netleşmeden BAĞIMSIZ ve DEĞİŞMEDEN duruyor — o üç durumun asla silinmemesi
  Fitness'ten değil, "bir harcamayı unutma" ilkesinden kaynaklanıyor.

  **Temizlik ne zaman tetiklenir? (2026-09-26, ikinci düzeltme):** İlk
  sürümde `eskiKayitlariTemizle_` SADECE üç retry-özel giriş noktasından
  (`yenidenDenemeKuyruguEkle_`, `pesEdildiKuyruguEkleVeBildir_`,
  `zamanlanmisTekrarDenemeyiIsle`) çağrılıyordu — yani sadece bir Gemini
  hatası yaşandığında. Bunun dürüst sonucu: **Gemini hiç hata vermezse
  temizlik de hiç çalışmaz**, `telegram_queue` sınırsız büyür — ki bu tam
  olarak kullanıcının "o sayfa gereksiz çok şişmesin" isteğiyle çelişirdi.
  Düzeltme: `retry/RetryCore.js > eskiKayitlariTemizleKilitli_` (diğer üç giriş
  noktasıyla AYNI script kilidini kullanan bir sarmalayıcı) artık
  `Queue.js > kuyrugaEkle_`'den de çağrılıyor — bu, konusu/başarısı fark
  etmeksizin HER metin mesajında çalıştığı için, Gemini hiç hata vermese
  bile temizlik düzenli fırsat bulur. Sürekli bir trigger kurulmadı (madde
  hâlâ geçerli) — bunun yerine zaten var olan, her mesajda çalışan bir
  fonksiyona (kuyrugaEkle_) ucuz bir ek adım eklendi.

  Gecikmeli başarıda cevaba "⏳ Gecikmeli işlendi (X saat önce gönderilmişti):"
  notu eklenir (kullanıcı kararı — hangi eski mesajın cevaplandığı belli olsun).

**FIFO silme toplu (batch) hale getirildi (2026-09-26, prod'da bulunan
sorun):** `eskiKayitlariTemizle_` ilk sürümde silinecek her satır için AYRI
bir `sheet.deleteRow(...)` çağırıyordu (N satır → N çağrı). Kullanıcı bunu
prod'da fark etti ve düzeltilmesini istedi. Düzeltme: silinecek satır
numaraları ardışık aralıklara gruplanıp her aralık için TEK bir
`sheet.deleteRows(start, sayi)` çağrılıyor — FIFO'da eski satırlar tipik
olarak sheet'in üst kısmında bitişik durduğundan bu genelde 1-2 çağrıya iner.
Aralıklar en alttakinden (satır no'su en büyük) başlanarak silinir, aksi
halde bir aralığı silmek henüz silinmemiş daha ÜSTTEKİ aralıkların satır
numaralarını kaydırırdı.

**Prod'da gerçek bir 503/UNAVAILABLE mesajı hiç kuyruklanmadı — kök sebep ve
düzeltme (2026-09-26):** Kullanıcı deploy sonrası gerçek bir Gemini 503
("high demand"/`UNAVAILABLE`) hatası aldı ama kullanıcıya beklenen
`GEMINI_YOGUN_KULLANICI_MESAJI` YERİNE generic "⚠️ Bir hata oluştu, işlem
tamamlanamadı: Gemini API hatası..." mesajı gitti VE `telegram_queue`'da o
satırın `durum`'u hiç güncellenmedi (retry hiç kuyruklanmadı).

**Teşhis:** `doPost`'un `mesajHatasi.gecici` dalındaki
`yenidenDenemeKuyruguEkle_` çağrısı bir hata fırlattığında (`catch
(kuyrukHatasi)`), kod `kuyrukHatasi`'yi SADECE loglayıp (Stackdriver'a — ki bu
proje GCP'ye bağlı değil, bkz. "Bilinen varsayımlar" bölümündeki "Logları
göremiyorum" notu, yani kullanıcı bu logu HİÇ göremez) `mesajHatasi`'yi (yani
orijinal Gemini hatasını) yeniden fırlatıyordu — bu, kullanıcının Telegram'da
gördüğü mesajın neden orijinal Gemini hata metniyle BİREBİR aynı olduğunu
açıklıyor: gerçek arıza (kuyruklama/trigger hatası) tamamen maskeleniyordu.

Gerçek arızanın kendisi muhtemelen `yenidenDenemeKuyruguEkle_ >
zamanliTetikleyiciKur_`'daki `ScriptApp.newTrigger(...).create()` çağrısının
başarısız olmasıydı (kullanıcının kendi hipotezi, doğru çıktı): trigger
oluşturma `script.scriptapp` OAuth kapsamını gerektirir; bu kapsam Retry.js
eklenmeden önce projede HİÇ kullanılmıyordu (Sheets/LockService kapsamları
zaten Queue.js/isYeniUpdate_'ten beri kullanımdaydı). **Kritik nokta: `clasp
push`/`clasp deploy` kod içindeki yeni kapsam ihtiyacını Web App'in ("Execute
as: Me") önceden verilmiş yetkilendirme onayına EKLEMEZ** — sahibinin Apps
Script editöründen HERHANGİ bir fonksiyonu bir kez elle çalıştırıp çıkan
"Review permissions" ekranını (artık trigger yönetimini de içeren güncel
kapsam listesiyle) onaylaması gerekir. Bu onay proje+kullanıcı bazlıdır, belirli
bir deployment'a bağlı değildir — bir kez verilince tüm deployment'lar (Web
App dahil) aynı onayı kullanır.

**Uygulanan iki düzeltme:**
1. `retry/RetryCore.js > yenidenDenemeKuyruguEkle_`: `zamanliTetikleyiciKur_`
   çağrısı artık kilit/sheet işlemlerinden ÖNCE ve ayrı denenir; başarısız
   olursa `zamanlanmisTekrarDenemeyiIsle`'daki AYNI "trigger kurulamadı → PES
   ET" deseniyle doğrudan `pesEdildiKuyruguEkleVeBildir_`'e devredilir —
   mesaj artık bu spesifik arızada da asla sessizce kaybolmuyor/generic hataya
   düşmüyor, doğrudan `PES_EDILDI` + kullanıcı bildirimi alıyor.
2. `Main.js > doPost`'taki HER İKİ `catch (kuyrukHatasi)` bloğu artık
   `mesajHatasi`'yi (orijinal Gemini hatasını) DEĞİL, `kuyrukHatasi.message`'ı
   da içeren birleşik bir hata fırlatıyor — bu SADECE beklenmeyen/başka bir
   kuyruklama arızasında (kilit zaman aşımı vb.) devreye girer ve artık
   kullanıcının Telegram'da gördüğü mesaj gerçek sebebi gösteriyor; GCP
   bağlanmadan Stackdriver'a bakılamadığı için bu, kullanıcının tek
   görünürlük kanalı.

**Kullanıcı için sonraki adım (deploy + yetkilendirme):** kod düzeltildi ama
prod'da hâlâ ESKİ (arızalı) kod çalışıyor — `clasp push` + mevcut deployment
ID'ye `clasp deploy -i <id>` ile yeni versiyon basılmalı. Ayrıca (kod
düzeltmesinden BAĞIMSIZ olarak, çünkü asıl trigger yetkisi sorunu hâlâ
sürüyor olabilir) editörden herhangi bir fonksiyon (`webhookDurumu` gibi) bir
kez elle çalıştırılıp izin ekranı onaylanmalı — bu adım atlanırsa trigger
kurulumu yine başarısız olur, ama artık en azından mesaj kaybolmaz
(PES_EDILDI'ye düşer, kullanıcı bilgilendirilir).

**İkinci, bağımsız bir gözlem (henüz doğrulanmadı):** `clasp deployments` bu
projede 2 deployment gösteriyor — biri `@HEAD`, biri versiyon numarasına
pinlenmiş (kullanıcının bu turda `clasp deploy -i <id>` ile güncellediği).
Telegram webhook'unun HANGİ deployment'ın URL'ine kayıtlı olduğu (yani
`CONFIG.webAppUrl` Script Property'sinin hangi ID'yi işaret ettiği)
doğrulanmalı — `webhookDurumu()` çıktısındaki `url` alanı bu ID'yi verir.
Eşleşmiyorsa (webhook eski/başka bir deployment'a kayıtlıysa) bu kod
düzeltmesi push edilse bile prod'a hiç yansımaz; bu durumda `WEBAPP_URL`
Script Property'si doğru deployment ID'sine güncellenip `kurulumWebhook()`
yeniden çalıştırılmalı.

**Bilinçli kabul edilen kısıt:** periyodik bir "self-heal" tarayıcı olmadığı
için, bir satırın `ISLENIYOR`'da takılı kalması (execution ortasında kesinti)
teorik olarak mümkün — bu, yalnızca BAŞKA bir mesaj kuyruklandığında/trigger
ateşlendiğinde (`eskiKayitlariTemizle_` çağrısı üzerinden değil, elle fark
edilip düzeltilmesi gereken bir durum olarak) ortaya çıkar. `PES_EDILDI`
satırlar için böyle bir "gecikme" riski YOK artık — onlar zaten hiçbir zaman
otomatik silinmiyor (bkz. yukarıdaki FIFO notu), sonsuza kadar (ya da
kullanıcı elle müdahale edene kadar) kuyrukta kalırlar, bu KASITLI. Kişisel/
düşük hacimli tek kullanıcılık bot için `ISLENIYOR` takılma riski kabul
edilebilir bulundu — `yenidenDenemeKuyruguDurumu()` (webhookDurumu() deseniyle
tutarlı, elle çalıştırılan teşhis fonksiyonu) `isleniyor` sayısının 0'dan
büyük görünmesini böyle bir takılmanın sinyali olarak yorumlar.

**Doğrulama:** Repo'da otomatik test altyapısı yok; mevcut projede yerleşik
"Node üzerinde mock Apps Script globalleriyle doğrulandı" deseniyle (scratch,
commit edilmeyen bir harness) uçtan uca doğrulandı — 38/38 kontrol PASS:
`telegram_queue` başlık göçü (4→11 kolon, A:D verisi korunarak) ve
`kuyrugaEkle_`'nin sadece A:D yazdığı, `sonrakiGecikmeSaat_`/`sonAsamaMi_`'nin
1-1-2-2-4 dizisi, `hataGeciciMi_` tablo testi, "yüksek talep" kısayolunun tek
çağrıda (sleep'siz) çıktığı, `doPost`'ta geçici/kalıcı hatanın `kuyrugaEkle_`'nin
AZ ÖNCE eklediği AYNI satırı bulup güncellediği (yeni satır oluşmadığı — bu
kontrol özellikle gerçekçi/"şimdi"ye yakın mesaj tarihleriyle yapıldı, çünkü
eski sabit bir test tarihi `eskiKayitlariTemizleKilitli_`'nin satırı erken
silip savunma-amaçlı "bulunamadı" dalını tetikleyip sonucu yanlışlıkla
maskeleyebiliyordu), tam 5 aşamalık escalation zinciri (paylaşılan sekme
üzerinde, her aşamada doğru gecikme + son aşamada PES_EDILDI + trigger
sızıntısı olmaması), erken başarı senaryosu (TAMAMLANDI'ya geçer, silinmez),
FIFO'nun TAMAMLANDI/boş-durumlu 10 günden eski satırları GERÇEKTEN sildiği
ama PES_EDILDI/BEKLIYOR/ISLENIYOR'u yaşı ne olursa olsun hiç silmediği,
`kuyrugaEkle_`'nin Gemini'ye hiç gidilmeden de (sıradan bir mesajda) temizliği
tetikledigi, toplu pes-edildi bildirimi, ve
`/pesedilenler`+`/pesdene` komutları. **Gerçek Telegram trafiğiyle uçtan uca
smoke-test henüz yapılmadı** — deploy (`clasp push` + Manage deployments →
New version, kullanıcı tarafından) sonrası gerçek bir 503/429 senaryosuyla ya
da geçici olarak `CONFIG.geminiModel`'i geçersiz bir isimle değiştirip 404
alarak doğrulanmalı.

> **Not (2026-09-29):** yukarıdaki "1-1-2-2-4 saat, 5 aşama" ifadesi bu
> doğrulamanın YAPILDIĞI ANA ait tarihsel bir kayıttır — aşama dizisi o
> tarihten SONRA `RETRY_BACKOFF_DAKIKA` olarak 8 aşamaya (10-20-40dk,
> 1-1-2-2-4sa) genişletildi, bkz. aşağıdaki "2026-09-29" bölümü.

**Sonraki oturum için not:** bu tasarımın kabul edilmeden önceki bir sürümünde
(kullanıcı tarafından reddedildi) tek bir kalıcı periyodik tarayıcı trigger
öneriliyordu; kullanıcı açıkça "sürekli bir trigger istemiyorum... her
başarısız ai isteği sonrası [mesaja özel] trigger kurulacak" dedi — bu karar
yeniden tartışılmadan korunmalı.

## Retry sistemi iyileştirmeleri v2 (2026-09-29)

Prod'da bir süre çalıştıktan sonra kullanıcı 4 ayrı iyileştirme istedi; hepsi
uygulandı, henüz `clasp push`/`deploy` edilmedi (kullanıcı tarafından
yapılmalı).

1. **`/sonmesajisil` komutu** (`Telegram.js > islemKomut_` → `retry/RetryCommands.js
   > sonMesajiSil_`): bu chat'e ait, komutun kendi satırı HARİÇ en son satırı
   bulur; `BEKLIYOR`/`ISLENIYOR` ise kurulu trigger'ı iptal eder
   (`zamanliTetikleyiciSil_`), durumu `RETRY_DURUM.SILINDI` yapar (TAMAMLANDI
   gibi FIFO'ya bırakılır, ASLA "unutulmuş harcama" sayılmaz — bilerek iptal
   edildi), ve Telegram'daki mesajı silmeyi DENER (`Telegram.js >
   telegramMesajiSil_`, `deleteMessage` API'si — özel sohbette bot kendisine
   gelen mesajları silebiliyor, AMA sadece gönderildikten sonraki 48 saat
   içinde; bu pencere dışında sessizce başarısız olur, sadece sistemdeki kayıt
   iptal edilmiş olarak kalır). Bunun için `Queue.js > QUEUE_HEADERS`'a 12.
   kolon olarak `message_id` (Telegram `update.message.message_id` —
   `update_id`'den FARKLI bir alan) eklendi; `kuyrugaEkle_` bunu A:D'nin
   `appendRow`'undan SONRA ayrı bir `setValue` ile L kolonuna yazıyor (A:D
   sözleşmesi/Fitness etkilenmedi). **KAPSAM DIŞI (bilinçli):** Expenses (D:I)
   harcama tablosuna DOKUNMAZ — taksitli harcama nedeniyle "hangi satır en son
   yazıldı" güvenilir bilinemiyor (aynı sebeple `/iptal` fikri de askıya
   alınmıştı, bkz. Geliştirme fikirleri madde 3).
2. **429 (kota/rate-limit) artık "yüksek talep" gibi ele alınıyor** —
   `Gemini.js > hataYuksekTalepMi_`'ye `httpStatus === 429` kontrolü eklendi;
   429 alındığında Katman 1'in kalan senkron denemeleri (kısa aralıklarla
   Gemini'yi tekrar yorması, kotayı daha da kötüleştirebilirdi) harcanmadan
   doğrudan Katman 2'ye geçiliyor. **Ayrıca kullanıcı kararıyla backoff dizisi
   genişletildi:** `RETRY_BACKOFF_SAAT = [1,1,2,2,4]` (saat) yerine
   `RETRY_BACKOFF_DAKIKA = [10,20,40,60,60,120,120,240]` (dakika, 8 aşama,
   toplam ~11sa10dk) — "1-1-2-2-4" dizisinin BAŞINA 10-20-40 dakikalık kısa
   aşamalar eklendi (kısa/geçici blipler artık ilk denemede 1 saat değil 10
   dakika sonra tekrar denenir). Bu, TÜM escalation yollarını (normal 3-deneme
   tükenmesi, 503 kısayolu, 429 kısayolu) aynı şekilde etkiler — hepsi aşama
   1'den (10dk) başlar. Yeni `RetryCore.js > gecenSureyiIfadeEt_(ms)` yardımcı
   fonksiyonu "X dakika"/"X saat" ifadesini dinamik üretir (`zamanlanmisTekrarDenemeyiIsle`
   ve `pesEdilenleriListele_` artık bunu kullanıyor — eskiden her şey saate
   yuvarlanırdı, 10 dakikalık bir gecikme yanlışlıkla "1 saat önce"
   gösterilirdi).

   **429/döngü teşhis sonucu (kullanıcı "kota bir anda tükeniyor mu"
   sorusuna cevaben):** Gerçek bir "sonsuz döngü" bulunamadı. Ama YUKARIDAKİ
   429 düzeltmesi gerçek bir riski gideriyor: önceden 429 alındığında Katman
   1 yine de 2sn/5sn aralıklarla 3 kez tekrar deniyordu — dolu bir kotanın
   üstüne istek atmak durumu kötüleştirebilirdi. İkincil, düşük olasılıklı
   bir teorik risk not edildi (kod değişikliği YAPILMADI, bkz. "Bilinen
   varsayımlar" bölümü): `RETRY_MAX_SATIR_PER_TETIKLEME` (5) sınırını aşacak
   şekilde 6+ mesajın trigger'ı TAM AYNI ANDA ateşlenirse, sınırı aşanlar
   claim edilmeden trigger'ları "tükenir" ve BEKLIYOR'da kalıcı takılabilir —
   kişisel/düşük hacimli kullanım için pratikte imkansıza yakın.
3. **Ham API/JSON hata metinleri artık kullanıcıya sızmıyor** — yeni
   `Gemini.js > kullaniciyaGosterilecekHataMetni_(err)` JSON gövdeyi ASLA
   içermeyen kısa bir Türkçe açıklama üretir (429/503/kalıcı-HTTP/bilinmeyen-
   HTTP/ağ-hatası için ayrı ayrı). `callGemini_`'nin "beklenmeyen yanıt" hata
   mesajı da artık ham `govde`yi içermiyor (detay zaten `log_` ile loglanıyor).
   Bu fonksiyon kullanıcıya/Sheets'e (`son_hata_mesaji` — `/pesedilenler`
   üzerinden zaten Telegram'a dökülüyor) giden HER yerde kullanılıyor: `doPost`
   (3 yer), `zamanlanmisTekrarDenemeyiIsle` (2 yer), `pesEdilenleriTekrarDene_`
   (1 yer). Loglar (`logHata_`) DEĞİŞMEDİ — hâlâ ham/detaylı hata basılıyor,
   sadece kullanıcı yüzeyine giden metin temizleniyor. `httpStatus`'u OLMAYAN
   hatalar (kendi ürettiğimiz Türkçe mesajlar — kuyruklama/trigger hataları
   gibi) bu fonksiyondan olduğu gibi geçer, YENİDEN yazılmaz.
4. **Kullanıcı mesajları artık backtick ile alıntılanıyor** (kullanıcı
   isteği — botun kendi metniyle karışmasın diye; kapsam SADECE alıntılanan
   kullanıcı mesajları, botun/Gemini'nin ürettiği diğer serbest metinler
   DEĞİŞMEDEN düz kaldı, regresyon riski yok). Yeni `Telegram.js >
   telegramAlinti_(metin)` backtick'e sarar (içindeki literal backtick'i tek
   tırnakla değiştirir). `sendTelegramMessage_` artık opsiyonel 3. parametre
   `parseMode` alıyor; kullanılırsa `parse_mode` gönderiliyor VE gönderim
   başarısız olursa (dengesiz `*`/`_`/backtick "can't parse entities" 400
   verebilir) aynı metin parseMode OLMADAN bir kez daha deneniyor (güvenlik
   ağı — biçimlendirme asla mesajın hiç gitmemesine yol açmamalı). `"Markdown"`
   SADECE 3 çağrıya eklendi: `doPost`'un komut-cevabı gönderimi, ve
   `pesEdildiBildirimGonder_`'ın 2 çağrısı — bunların hepsi ya tamamen bizim
   şablonlarımız ya da alıntılanmış kullanıcı metni içeriyor, Gemini'nin
   serbest metnini İÇERMİYOR (düşük risk).

**Fitness'e dokunulmadı:** `c:\Users\Lenovo\Documents\YusufKisisel\Fitness`
bu turda workspace'e eklendi ama kullanıcı açıkça "fitness modülümde
düzenleme yapma" dedi — hiçbir Fitness dosyası okunmadı/değiştirilmedi. Yeni
`message_id` kolonu Fitness'in okuduğu A:D'ye dokunmuyor.

**Doğrulama:** Saf fonksiyonlar (`sonrakiGecikmeDakika_`, `sonAsamaMi_`,
`gecenSureyiIfadeEt_`, `hataYuksekTalepMi_`, `kullaniciyaGosterilecekHataMetni_`,
`telegramAlinti_`) scratchpad'te izole bir Node scriptiyle 33/33 PASS
doğrulandı (JSON'un hiçbir hata metninde GÖRÜNMEDİĞİ teyit edildi). Fonksiyon
envanteri (tüm dosyalardaki `function`/`const` isimleri) tekrar taranıp
çakışma/eksik olmadığı doğrulandı, `node --check` her dosyada geçti. Sheet/
trigger/Telegram etkileşimli kısımlar (`/sonmesajisil`, 429 escalation,
Markdown gönderim) bu oturumda mock'lanmadı — yukarıdaki "Az-token doğrulama
rehberi" tablosuna eklenen yeni satırlarla kullanıcı tarafından gerçek
ortamda test edilmeli. **`clasp push` + AYNI deployment ID'ye `clasp deploy
-i <id>` gerekiyor.**

## Sahipsiz (orphan) trigger temizliği (2026-09-29, ikinci tur)

**Problem:** Kullanıcı prod'da sistemin kurduğu bazı trigger'ları
temizlemeyi unuttuğunu fark etti (Apps Script projesindeki Triggers
listesinde birikiyorlardı). Kod incelemesinde İKİ ayrı kök sebep bulundu:

1. **Trigger kuruldu ama hiçbir satıra bağlanamadı.**
   `yenidenDenemeKuyruguEkle_` ve `zamanlanmisTekrarDenemeyiIsle`'ın aşama-
   atlama dalı önce `zamanliTetikleyiciKur_` ile trigger kuruyor, SONRA satırı
   güncelliyor; bu ikinci adım (kilit zaman aşımı, Sheets hatası vb.)
   başarısız olursa kurulan trigger hiçbir satırın `trigger_id`'sinde
   görünmüyor — eski temizlik mantığı SADECE satırlardan yola çıktığı için bu
   sahipsiz trigger'ı asla bulamıyordu.
2. **Bir satır dıştan (elle) silinirse/değişirse.** O satıra ait trigger
   ateşlendiğinde `zamanlanmisTekrarDenemeyiIsle` sadece "vadesi gelmiş
   BEKLIYOR satırları" tarıyordu; satır artık yoksa trigger için HİÇBİR ŞEY
   yapılmıyordu — trigger listede kalıyordu (Apps Script'in tek seferlik
   trigger'ları ateşlendikten sonra kendiliğinden silinmiyor) ve bir daha da
   ateşlenmeyeceği için sonsuza dek "ölü" kalıyordu.

**Uygulanan iki parçalı çözüm:**

1. **Compensating delete (senkron, race'siz) — kök sebep (1)'i baştan
   önlüyor.** `yenidenDenemeKuyruguEkle_`'nin lock/sheet-yazma bloğu artık bir
   dış `try/catch`'e alındı; yazma BAŞARISIZ olursa YENİ KURULAN trigger
   `zamanliTetikleyiciSil_` ile hemen geri silinip hata yeniden fırlatılır
   (mevcut `doPost > catch (kuyrukHatasi)` akışı değişmeden devreye girer).
   `zamanlanmisTekrarDenemeyiIsle`'ın escalation dalında da aynı desen:
   `yeniTriggerId` dış scope'a taşındı, `satiriGuncelle_` hata verirse
   PES_EDILDI'ye düşmeden ÖNCE o trigger geri silinir.
2. **Sahipsiz-trigger taraması (sweep) — kök sebep (2)'yi temizliyor.** Yeni
   `retry/RetryCore.js > sahipsizTetikleyicileriTemizle_(sheet)`:
   `RETRY_HANDLER_FN_ADI`'na kayıtlı TÜM trigger'ları alır, sadece `BEKLIYOR`
   satırların referans verdiği `trigger_id`'leri "meşru" sayar, kalanını
   GERÇEKTEN siler (disable değil). Sadece kendi handler'ımıza ait
   trigger'lara dokunur. Yeni `bakimYap_(sheet, simdi)` bunu
   `eskiKayitlariTemizle_` (FIFO) ile birlikte çağırır; eski
   `eskiKayitlariTemizleKilitli_` → `bakimYapKilitli_` olarak yeniden
   adlandırılıp içeride `bakimYap_`'ı çağıracak şekilde güncellendi.
   `Queue.js > kuyrugaEkle_` (HER mesajda) ve `yenidenDenemeKuyruguEkle_` /
   `pesEdildiKuyruguEkleVeBildir_` / `zamanlanmisTekrarDenemeyiIsle`'daki
   (zaten kilit altında olan) doğrudan çağrılar `bakimYap_`'a güncellendi —
   yani sweep hem retry trigger'ı ateşlendiğinde hem her gelen mesajda
   çalışıyor (kullanıcı kararı: defense-in-depth, mevcut FIFO temizliğiyle
   aynı desen).

**Kabul edilen kalıntı risk (kullanıcı onayı):** Trigger kurulup satıra
YAZILMADAN önceki çok kısa pencerede, BAŞKA bir execution (örn. aynı anda
gelen farklı bir Telegram mesajı) sweep'i tam o anda çalıştırırsa, henüz
hiçbir satıra bağlanmamış bu yeni trigger'ı "sahipsiz" sanıp silebilir —
mesaj o zaman BEKLIYOR'da ölü bir `trigger_id` ile kalabilir. Kişisel/düşük
hacimli kullanım için pratikte ihmal edilebilir (iki execution'ın milisaniye
hassasiyetinde çakışması gerekir) — kullanıcı basit çözümü seçti, ek önlem
(kilit sıralamasını değiştirip tam atomik hale getirmek) alınmadı.

**Bu, `RETRY_MAX_SATIR_PER_TETIKLEME` aşımı riskinden FARKLI ve onu
ÇÖZMÜYOR** (bkz. "Bilinen varsayımlar" bölümündeki 2026-09-29 notu): o
senaryoda trigger zaten ateşlenip "tükenmiş" ama satır hâlâ o trigger_id'yi
taşıyor — sweep bunu "meşru" sayıp SİLMEZ (doğru davranış, silinirse satır
bir daha hiç denenmezdi), ama trigger da bir daha ateşlenmeyeceği için satır
yine BEKLIYOR'da takılı kalır. Bu ayrı, çözülmemiş bir kenar durum.

**Doğrulama:** `sahipsizTetikleyicileriTemizle_`'in meşru/sahipsiz ayrım
mantığı scratchpad'te izole bir Node scriptiyle 6/6 PASS doğrulandı (BEKLIYOR
satırın trigger'ı korunuyor; satır yokken/PES_EDILDI/ISLENIYOR/SILINDI/
TAMAMLANDI satırların eski trigger_id'leri asla meşru sayılmıyor; başka bir
handler'a ait trigger'a hiç dokunulmuyor). `node --check` ve fonksiyon
envanteri diff'i tüm dosyalarda tekrarlandı. Gerçek trigger silme/Sheets
etkileşimi kullanıcı tarafından gerçek ortamda test edilmeli — bkz. aşağıdaki
"Az-token doğrulama rehberi"ne eklenen satır.

## Bilinen varsayımlar / kırılgan noktalar

- `SHEET_LAYOUT` (`START_ROW=3`, `START_COL=4`/D, `NUM_COLS=6`) tamamen
  `services/SheetsGoogle.py`'deki `D3:I3` sabitinden türetildi; gerçek
  spreadsheet'te başlık satırı sayısı ya da sütun offseti farklıysa bu
  sabitler güncellenmeli.
- `findNextDataRow_` / `readTopRows_` / `sortByDateDescending_`,
  `sheet.getLastRow()` ve D sütunundaki ilk boş hücreyi baz alıyor. D:I
  dışındaki sütunlarda (A:C ya da I sonrası) veri D:I'den daha aşağıya
  taşıyorsa (örn. bir footer/not satırı) bu sezgi yanılabilir.
- `sortByDateDescending_` tüm sheet genişliğini (`getLastColumn()`) sıralama
  kapsamına alıyor — orijinal Python kodu da A sütunundan itibaren
  sıralıyordu, böylece A:C'de satıra bağlı içerik varsa (formül, not) satırla
  birlikte hareket eder. Gerçek tabloda A:C boşsa zararsızdır.
- `doPost` tek bir `CHAT_ID` allowlist kontrolü yapıyor (tek kullanıcılık bot
  varsayımı). Birden fazla kullanıcı desteklenmek istenirse bu kontrol bir
  listeye genişletilmeli.
- İkinci bir Gemini round-trip yok: fonksiyon sonuçları modele geri
  gönderilmiyor, doğrudan biçimlendirilip Telegram'a yollanıyor (kullanıcının
  orijinal spesifikasyonu buydu). Daha "insansı" özet cevaplar isteniyorsa bu
  tasarım kararı gözden geçirilebilir.
- Loglama: `Logging.js`'teki `log_(etiket, veri)` / `logHata_(etiket, err)`
  yardımcıları tüm akışı `[etiket] gövde` biçiminde basar (doPost, dedup,
  Gemini istek/yanıt/parts, fonksiyon çağrıları, Telegram yanıtı, Sheets
  hedefi/satırı). **Sır asla loglanmaz** — Gemini istek URL'i API key, Telegram
  URL'i bot token içerdiği için ikisi de bilinçli olarak basılmıyor; yeni log
  eklerken bu korunmalı.
- **Ama bu loglar varsayılan olarak GÖRÜNMÜYOR:** Apps Script, anonim
  çağıranlarca (Telegram) tetiklenen Web App execution'larının Cloud
  günlüklerini, projeye standart bir GCP projesi bağlanmadıkça sahibine
  göstermiyor. Executions listesinde `doPost` satırı görünür ama açılıp log
  okunamaz; `Execute as: Me` bunu değiştirmez. Çözüm: Project Settings → GCP
  Project. GCP bağlanmadan okunabilenler: execution sayısı, süreleri ve
  **durum sütunu** (Tamamlandı/Başarısız).
- Logları Telegram'a dökme fikri denendi ve kullanıcı tarafından **reddedildi**
  (istenen yalnızca `console.log` eklemekti) — tekrar önerilmemeli.
- `parseTarih_` fonksiyonu argüman gelmezse `new Date()` (script'in çalıştığı
  an) döner — bu sadece bir yedek/geriye dönük durumdur; asıl "bugün" mantığı
  Gemini'nin `systemInstruction`'daki ZAMAN BAĞLAMI kurallarına göre mesaj
  zamanını mutlak tarihe çevirip göndermesine dayanır.
- `retry/RetryCore.js` script başına en fazla 1 canlı trigger/aktif (BEKLIYOR) mesaj
  varsayımıyla tasarlandı (bkz. "Gemini API geçici/kalıcı hatalarına karşı
  Katman 2" bölümü) — Apps Script'in ~20 trigger kotasına tek kullanıcılık
  düşük hacimli kullanımda pratikte hiç yaklaşılmaz, ama Gemini saatlerce
  kesik kalıp kullanıcı bu süre içinde çok sayıda mesaj gönderirse teorik
  olarak yaklaşılabilir; o noktada `zamanliTetikleyiciKur_` başarısız olursa
  kod mesajı sessizce kaybetmek yerine PES_EDILDI'ye düşürüp kullanıcıyı
  bilgilendirir (veri kaybı yok, sadece otomatik retry durur).
- **(2026-09-29 teşhis notu)** `zamanlanmisTekrarDenemeyiIsle` aynı
  ateşlenişte en fazla `RETRY_MAX_SATIR_PER_TETIKLEME` (5) satırı claim eder.
  Eğer 6+ mesajın trigger'ı TAM AYNI ANDA ateşlenirse, sınırı aşan satırlar
  claim edilmez ama tetikleyen tek-seferlik trigger'ları yine de "tükenir"
  (bir daha ateşlenmez) — bu satırlar BEKLIYOR'da, artık ölü bir `trigger_id`
  ile kalıcı olarak takılı kalabilir (kod değişikliği YAPILMADI, kabul edilen
  bir kısıt). Kişisel/düşük hacimli kullanım için pratikte imkansıza yakın
  (farklı mesajların backoff'larının milisaniye hassasiyetinde çakışması
  gerekir) — `yenidenDenemeKuyruguDurumu()`'nda `bekleyen` sayısının
  `kayitliTriggerSayisi`'nden yüksek görünmesi bu duruma işaret eder.

## Geliştirme fikirleri (öneriler)

Sistem mevcut haliyle amacına hizmet ediyor (kullanıcı onayı). Aşağıdakiler
hiçbiri implement edilmedi — sadece değerlendirilmesi için not edildi,
efor/etkiye göre gruplanmış. Kullanıcı önceliklendirirse ayrıca planlanabilir.

### Kolay ve değerli (önce bunlar)

1. **Telegram komut menüsü (`setMyCommands`)** — Bot API'nin `setMyCommands`
   metoduyla (`POST https://api.telegram.org/bot<TOKEN>/setMyCommands`, body:
   `{"commands":[{"command":"son","description":"..."}]}`) kayıt yapılırsa
   Telegram istemcisinde mesaj kutusunun yanındaki "/" menüsünde açıklamalı,
   otomatik tamamlanan bir komut listesi belirir (BotFather'daki
   `/setcommands` ile aynı sonucu programatik veriyor — token BotFather'a
   gerek kalmadan buradan da ayarlanabilir). `kurulumWebhook()`'a benzer bir
   `kurulumKomutlar()` fonksiyonu eklenip önerilen komutlar kaydedilebilir:
   - `/son` — son 5 harcamayı listeler (`sonHarcamalariGetir`)
   - `/toplam` — son N harcamanın toplamı (`sonHarcamalariTopla`)
   - `/iptal` — en son eklenen harcamayı geri alır (bkz. madde 3)
   - `/yardim` — botun nasıl kullanılacağını, örnek mesaj formatlarını
     anlatan statik bir metin döner
2. **`doPost`'ta `/` ile başlayan komutları Gemini'ye göndermeden doğrudan
   işlemek** — **UYGULANDI (2026-08-31, genişletildi 2026-09-26 ve
   2026-09-29):** `Telegram.js > islemKomut_` + `doPost`'taki erken-çıkış
   dalı. Komutlar: `/son [N]`, `/toplam [N]`, `/pesedilenler`, `/pesdene`,
   `/sonmesajisil`, `/komutlar` (komut listesi); tanınmayan `/xxx` → "Komut
   bulunamadı" + aynı liste (`KOMUT_LISTESI_METNI`). `/pesedilenler` ve
   `/pesdene` (`retry/RetryCommands.js`) kullanıcının açık isteğiyle eklendi —
   sırasıyla `PES_EDILDI` (bkz. "Gemini API geçici/kalıcı hatalarına karşı
   Katman 2" bölümü) mesajları listeler ve
   hepsini topluca (Katman 1 ile, yeni trigger KURMADAN) şimdi tekrar dener;
   başarılı olanlar `TAMAMLANDI`'ya geçer, başarısız kalanlar `PES_EDILDI`'de
   kalır (silinmez). `/sonmesajisil` (`sonMesajiSil_`, bkz. "Retry sistemi
   iyileştirmeleri v2" bölümü) bir önceki mesajı iptal eder/silmeyi dener.
   **İstisna:** `/pesdene` diğer komutların aksine Gemini'ye gider (bilinçli,
   kullanıcı talebiyle tetiklenen manuel bir toplu deneme). Diğer komutlar
   sıfır Gemini API çağrısı/maliyeti — Node üzerinde mock Sheets/Apps Script
   globalleriyle doğrulandı.
3. **`/iptal` — son eklenen harcamayı geri alma** — **ASKIYA ALINDI
   (2026-08-31, kullanıcı kararı).** Orijinal fikir "son eklenen satır =
   `SHEET_LAYOUT.START_ROW`" varsayımına dayanıyordu; bu artık geçerli
   değil çünkü **taksitli harcama** özelliği (bkz. madde 12) GELECEK
   tarihli satırlar yazıyor ve tablo tarihe göre sıralandığı için bu
   satırlar en üstte görünebiliyor — yani "en üstteki satır" fiilen "en
   son eklenen" ile aynı şey değil. Bu özelliği ileride hayata geçirmek
   için önce bir işaretleme/saklama mekanizması (ör. her yazılan satırın
   `update_id`'sini veya sıra numarasını ayrı bir yerde tutmak) gerekiyor.

### Orta vadeli

4. **Fiş/fatura fotoğrafından harcama ekleme (Gemini Vision)** — Telegram bir
   fotoğraf mesajı (`message.photo`) gönderdiğinde, Telegram'ın `getFile` +
   dosya indirme URL'i ile fotoğraf çekilip base64'e çevrilip Gemini'ye
   `inlineData` (`image/jpeg`) part'ı olarak `TOOLS` ile birlikte
   gönderilebilir. Aynı ZORUNLU NETLİK KURALI mantığı (tutar/tarih/tür net
   değilse sor) fiş okumada da geçerli olur. Muhtemelen en yüksek etkili
   tekil geliştirme — kullanıcı deneyimini "yaz" seviyesinden "fotoğrafla"
   seviyesine çıkarır.
5. **Sesli mesajdan harcama ekleme** — Telegram `message.voice` alanı da
   benzer şekilde (dosya indir → base64 → Gemini'ye audio input) desteklene-
   bilir; Gemini ses girdisini native olarak anlıyor. Fotoğraf özelliğinden
   sonra değerlendirilebilir.
6. **Haftalık/aylık otomatik özet** — `ScriptApp.newTrigger(...).timeBased()`
   ile zaman tetikleyicisi kurup (örn. her Pazartesi sabahı), o haftanın/ayın
   kategoriye göre kırılımını hesaplayıp `CONFIG.chatId`'ye proaktif olarak
   gönderen bir fonksiyon. Kullanıcı hiçbir şey sormadan düzenli bir
   "harcama raporu" alır.
7. **Bütçe uyarısı** — Script Properties'e `BUTCE_<KATEGORI>` gibi aylık
   limitler tanımlanıp, `harcamaEkle` her çağrıldığında o kategorinin ay-içi
   toplamı hesaplanıp limit aşılırsa onay mesajına bir uyarı satırı
   eklenebilir.

### İleri seviye / dikkatli değerlendirilmeli

8. ~~**Aynı update'in iki kez işlenmesine karşı koruma**~~ — **UYGULANDI**,
   bkz. yukarıdaki "Tekrar teslim edilen update'ler" bölümü.
9. **Sheet içinde ayrı bir "Log" sekmesi** — şu an hatalar sadece
   `console.error` ile Stackdriver'a düşüyor (Apps Script > Executions'tan
   bakılması gerekiyor). Eski Python akışındaki `GoogleDriveLogger`'a benzer,
   basit "her önemli olay bir satır" mantığıyla ayrı bir Sheets sekmesine log
   yazmak, teknik olmayan bir kullanıcı için de görünürlük sağlar.
10. **Few-shot örnekleriyle `systemInstruction`'ı güçlendirme** — mevcut
    prompt kural-tabanlı; `Gemini.js`'teki `SYSTEM_INSTRUCTION_TEMPLATE`'e 2-3
    somut örnek (özellikle "kısmi ekleme + kısmi netleştirme" ve "çoklu
    harcama" senaryoları için input → beklenen fonksiyon çağrıları)
    eklenmesi, modelin kuralları — özellikle ZORUNLU NETLİK KURALI'nı — daha
    tutarlı uygulamasını sağlayabilir. Gerçek kullanım sonrası modelin hatalı
    davrandığı örnekler biriktirilip buraya eklenebilir.
11. **Sabit kategori kümesi + kategori ayrım (disambiguation) prompt'u**
    — kullanıcının açık isteği (2026-08-30). **UYGULANDI (2026-08-31):**
    `Config.js` (`KATEGORILER` sabiti + `TOOLS.kategori.enum`), `Gemini.js`
    (`buildKategoriTanimlariBlok_` + systemInstruction'a KATEGORİLER/
    KARIŞABİLEN KATEGORİLER/ÖRNEKLER blokları) ve `Expenses.js`
    (`harcamaEkle`'de üçüncü katman kod-seviyesi doğrulama) güncellendi.
    Mock Apps Script globalleriyle Node üzerinde doğrulandı: enum 17
    kategoriyi doğru sırayla veriyor, `buildSystemInstruction_` her iki yer
    tutucuyu da dolduruyor, kod-seviyesi doğrulama eski/geçersiz isimleri
    ("kırtasiye", "Dijital Abonelik") doğru reddediyor. Gerçek Telegram
    sohbetiyle uçtan uca smoke-test henüz yapılmadı (bkz. plan dosyasındaki
    Doğrulama Planı) — deploy öncesi TEST_MODE ile çalıştırılmalı.

    **Hedef:** kullanıcının kendi sabit kategorileri API isteğine dahil
    edilecek ve Gemini'nin döndürdüğü `kategori` **kesinlikle** o kümeden biri
    olacak. Şu an `kategori` serbest metin; zamanla "Yemek", "yemek", "Gıda"
    gibi varyasyonlar birikiyor. Eski açık soru ("kategori listesi nerede?")
    çözüldü: kanonik liste artık burada (aşağıda) sabitlendi; koda
    `Config.js`'e tek kaynak (`KATEGORILER` sabiti) olarak taşınacak.

    **Kesinleşen 17 kategori** (her biri kapsar/kapsamaz ile tanımlı —
    systemInstruction'a sadece isim değil bu tanımlar da girmeli, aksi halde
    model metindeki sinyallerden doğru kategoriyi çıkaramaz):

    1. **Ev** — Ev eşyası/mobilya/tadilat-bakım VE market/gıda alışverişi
       (kullanıcı kararı: ayrı "Market" kategorisi yok; market alışverişi
       Ev'e girer, `malzeme` alanına "Market" yazılır).
    2. **Yemek** — Dışarıda yenilen/sipariş edilen yemekler. Kapsamaz:
       kafede yenilen/içilen HER ŞEY (mekan kafeyse ürün ne olursa olsun
       kategori Cafe'dir — eski "kafede tost yedim → ?" sorusu bununla
       çözüldü).
    3. **Cafe** — Sohbet/vakit geçirme amaçlı kafe harcamaları.
    4. **Spor** — Sportif faaliyetlerin tümü (üyelik, ders, ekipman).
       Kapsamaz: spor kıyafeti/ayakkabısı (bkz. Giyim).
    5. **Elektronik** — Fiziksel elektronik cihaz satın alımı. Kapsamaz:
       yazılım/dijital hizmet (bkz. Dijital).
    6. **Araç** — Kendi aracının bakım/gideri: yakıt, bakım, sigorta,
       muayene, otopark. Kapsamaz: araç kiralama (bkz. Kiralama), araç dışı
       ulaşım (bkz. Ulaşım).
    7. **Kişisel** — Kişisel bakım/kozmetik VE kırtasiye/küçük ofis-ev
       malzemesi (kullanıcı kararı: ayrı Kırtasiye kategorisi kaldırıldı,
       buraya katıldı).
    8. **Destek** — Karşılıksız verilen paralar: düğün/davet takı-nakit,
       sadaka, zekat, karşılıksız borç. Kapsamaz: somut hediye eşyası
       (bkz. Hediye).
    9. **Giyim** — Giyim eşyası (spor kıyafeti dahil).
    10. **Eğlence** — Sinema/konser/oyun bileti gibi organize etkinlikler.
        Kapsamaz: kafede sohbet (bkz. Cafe).
    11. **Ulaşım** — Kendi aracı DIŞINDAKİ ulaşım: otobüs, metro, akbil,
        taksi/uber, uçak/tren bileti.
    12. **Hastane** — Sağlık/tıbbi harcamalar (doktor, eczane/ilaç/vitamin,
        tedavi). Kapsamaz: kozmetik ürün (bkz. Kişisel).
    13. **Hediye** — Somut hediye eşyaları. Kapsamaz: nakit/altın karşılıksız
        yardım (bkz. Destek).
    14. **Eğitim** — Eğitim, kurs, ders kitabı vb.
    15. **Kiralama** — Araç/ev/başka bir şeyin kiralanması (ev kirası dahil).
    16. **Fatura** — Elektrik/su/doğalgaz/internet/telefon HATTI faturaları
        (altyapı/hat sağlayıcısına zorunlu düzenli ödeme). Kapsamaz:
        içerik/yazılım platformu abonelikleri (bkz. Dijital).
    17. **Dijital** — Netflix/Spotify/bulut depolama/yazılım-uygulama
        abonelikleri, dijital oyun/uygulama satın alımı. Kapsamaz: fiziksel
        cihaz (bkz. Elektronik), altyapı/hat faturası (bkz. Fatura).

    **"Diğer/Çeşitli" yedek kategori YOK** (kullanıcı kararı) — hiçbiri net
    oturmayan harcamada model mevcut ZORUNLU NETLİK KURALI ile sorar,
    uydurmaz.

    **Fatura/Dijital neden iki ayrı kategori:** faturalar zorunlu/sabit
    gider, dijital abonelikler isteğe bağlı/yaşam tarzı gideri — bu ayrım
    "abonelik takibi" (kullanıcının orijinal isteği) için gerekli; ikisi
    birleştirilseydi abonelik-şişmesi (subscription creep) görünürlüğü
    kaybolurdu.

    **Karışabilen çiftler/üçlüler — öncelik kuralları:**
    - Yemek ↔ Cafe: **mekan bazlı** — mekan kafeyse ürün ne olursa olsun
      Cafe.
    - Fatura ↔ Dijital: **sağlayıcı tipi bazlı** — altyapı/hat sağlayıcısı
      → Fatura; içerik/yazılım platformu → Dijital.
    - Elektronik ↔ Dijital: **fiziksel mi dijital mi** — cihaz →
      Elektronik; hizmet/yazılım/dijital içerik → Dijital.
    - Araç ↔ Ulaşım ↔ Kiralama: **kimin aracı + mülkiyet mi kiralama mı** —
      kendi aracı bakım/gideri → Araç; kendi aracı dışı ulaşım → Ulaşım;
      araç/ev kiralama → Kiralama.
    - Destek ↔ Hediye: **nakit/altın mı eşya mı** — nakit/altın karşılıksız
      yardım → Destek; somut eşya → Hediye.
    - Kişisel ↔ Hastane ↔ Giyim ↔ Eğitim ↔ Spor: kozmetik/bakım/kırtasiye →
      Kişisel; sağlık amaçlı (vitamin dahil) → Hastane; giyilen her şey
      (spor kıyafeti dahil) → Giyim; kurs/ders kitabı → Eğitim;
      ekipman/üyelik/ders ücreti (kıyafet hariç) → Spor.

    **Üç katmanlı zorlama** (mevcut tasarım felsefesiyle uyumlu — bkz.
    `Config.js > TOOLS` yorumu: "tek başına systemInstruction'a güvenilmez"):
    - `TOOLS`'taki `kategori` parametresine JSON Schema `enum` eklemek
      (Gemini'nin OpenAPI-subset şeması `enum` destekliyor) — model şema
      seviyesinde kısıtlanır. **Ama enum TEK BAŞINA yetersiz** — sadece isim
      listesi verir, ayrım için kapsar/kapsamaz bilgisi taşımaz.
    - `systemInstruction`'a (a) yukarıdaki 17 kategori tanımı, (b)
      karışabilen çift/üçlü öncelik kuralları, (c) sınır-vaka odaklı
      few-shot örnekleri (bkz. madde 10) eklemek — kategori tanımları
      `KATEGORILER` sabitinden dinamik üretilip tek kaynak korunmalı.
    - **Üçüncü katman olarak kodda doğrulama:** `harcamaEkle`, listede
      olmayan bir `kategori` gelirse yazmayı reddedip netleştirme istemeli.
      Modelin şemaya uyacağına güvenilmemeli. Not: mevcut `harfBuyukYap_`
      normalizasyonu bu durumda yerini kanonik listeye birebir eşlemeye
      bırakmalı.
    - Model hiçbir koşulda bu 17'nin dışında bir kategori üretmemeli;
      hiçbiri güvenle oturmuyorsa **tahmin etmek yerine sormalı** (ZORUNLU
      NETLİK KURALI'nın doğal uzantısı).

    **Takas:** sabit küme, kullanıcının serbestçe yeni kategori açma
    esnekliğini kısıtlar. Yeni kategori eklemek `Config.js` düzenlemesi +
    redeploy gerektirir.

    **Kapsam dışı bırakılanlar (bilinçli):** sheet'teki mevcut eski
    serbest-metin TÜR değerlerinin ("Market", "Gıda" vb.) yeni kanonik
    listeye migrasyonu yapılmayacak (yalnızca ileriye dönük zorlama);
    `sonHarcamalariGetir`/`sonHarcamalariTopla`'ya kategori bazlı
    filtreleme/gruplama eklenmiyor (bkz. madde 6/7, ayrı ve henüz
    onaylanmamış özellikler).

    **Ek karar — Ev ↔ Yemek bağlam kuralı (2026-09-01, kullanıcıyla
    netleştirildi — yeniden tartışılmadan korunmalı):** gerçek bir kullanım
    vakasında "dün spor sonrası atıştırmalık aldım 105tl" mesajı yanlışlıkla
    `tür=Ev` olarak kaydedildi. Kök sebep: "Ev" tanımı market/gıda
    alışverişini genel olarak kapsıyordu ve `KARIŞABİLEN KATEGORİLER`
    listesinde Ev↔Yemek çifti hiç yoktu, "Spor" ise kasıtlı olarak
    ekipman/üyelik/ders ücretiyle sınırlı (gıda kapsamıyor, bu değişmedi).
    Kullanıcı **bağlam bazlı** bir kural istedi (Yemek↔Cafe'deki "mekan
    bazlı karar" desenine benzer): dışarıdayken/bir aktivite sırasında ya da
    sonrasında anlık tüketmek için alınan atıştırmalık/içecek → Yemek;
    markette toplu/stoklamak amacıyla alınan gıda → Ev (değişmedi). Bu kural
    `Config.js > KATEGORILER` (Ev'in yeni `kapsamaz`'ı, Yemek'in genişletilen
    `kapsar`/`kapsamaz`'ı) ve `Gemini.js > SYSTEM_INSTRUCTION_TEMPLATE`'e
    (KARIŞABİLEN KATEGORİLER'e yeni madde + iki yeni ÖRNEK satırı) işlendi.
12. **Taksitli harcama ayrıştırma** — kullanıcının açık isteği
    (2026-08-31). **UYGULANDI:** `Config.js > TOOLS`'a `taksitliHarcamaEkle`
    fonksiyonu eklendi (`tutar`, `tutarTipi` enum `["TOPLAM","TAKSIT_BASI"]`,
    `taksitSayisi`, `kategori`, `ilkTarih`, `firma`, `malzeme`, `aciklama`).

    **Tasarım kararı:** taksit matematiği (ay ekleme, tutar bölme, "k/N"
    numaralandırma) KASITLI olarak Gemini'ye değil KODA yaptırılıyor —
    Gemini sadece alanları TEK çağrıda çıkarır, N satırı yazma tamamen
    deterministik (`Expenses.js > taksitliHarcamaEkle`). Gerekçe: LLM'e çok
    adımlı aritmetik (N kez ay ekleme, doğru sıralama) yaptırmak hataya çok
    açık; kodda %100 doğru ve ucuz.

    **Kullanıcı kararları (yeniden tartışılmadan korunmalı):**
    - İlk taksidin referans günü = kullanıcının belirttiği satın alma günü
      (mevcut ay içinde geçmiş/gelecek bir gün belirtilse bile o gün aynen
      kullanılır) — `harcamaEkle`'nin `tarih` alanıyla AYNI ZAMAN BAĞLAMI
      çözümlemesi (`parseTarih_`), farklı bir kural yok.
    - Ay sonu çakışmasında (ör. 31 Ocak + 1 ay → Şubat'ta 31 yok) hedef ayın
      SON gününe çekilir — bkz. `Expenses.js > ayEkle_`
      (`new Date(yil, ay+1, 0)` tekniğiyle "ayın son günü" bulunur).
    - Toplam mı taksit başı mı tutar verildiği metinden net çıkarılamıyorsa
      ZORUNLU NETLİK KURALI'nın AYNISI uygulanır: fonksiyon çağrılmaz,
      kullanıcıya açıkça sorulur — asla varsayım yapılmaz.
    - Telegram'a dönen onay TEK bir mesajdır ama her taksidin tarihini tek
      tek listeler (kısa özet değil) — kullanıcı taksitli harcamayı sık
      yapmadığı için netlik tercih edildi.

    **Kod tekrarını önlemek için refactor:** `harcamaEkle`'nin satır-yazma
    mantığı (`findNextDataRow_` + `setValues` + `sortByDateDescending_`)
    ortak `Expenses.js > satirYaz_` yardımcısına çıkarıldı; tutar/kategori
    doğrulaması da `dogrulaTutar_`/`dogrulaKategori_` olarak ayrıştırılıp
    her iki fonksiyon arasında paylaşıldı.

    Node üzerinde mock Sheets ile doğrulandı: ay sonu çakışması (31 Ocak →
    28 Şubat → 31 Mart → 30 Nisan), TOPLAM/TAKSIT_BASI tutar hesaplaması,
    geçersiz `tutarTipi`/`taksitSayisi`/`kategori` reddi, ve `harcamaEkle`
    refactor sonrası regresyon kontrolü.

    **Kapsam dışı:** ilgili spreadsheet satırlarını geriye dönük bulup
    silme/güncelleme (`/iptal`, bkz. madde 3 — bu özellikle çakıştığı için
    askıya alındı); `sonHarcamalariGetir`/`sonHarcamalariTopla`'ya taksit
    bazlı özel gösterim eklenmedi (mevcut genel "son N satır" mantığı
    aynen kullanılıyor).
13. **Bot'un kendi gönderdiği (özellikle "❓ Netleştirilmesi gerekenler")
    mesajlarını otomatik temizleme** — kullanıcı isteği: eski/işi biten
    netleştirme mesajlarının sohbette birikmesini istemiyor. Telegram'ın
    `deleteMessage` metodu bunu teknik olarak destekliyor ama iki sert kısıtı
    var:
    - **48 saat sınırı**: Bot API üzerinden bir mesaj ancak gönderildikten
      sonraki 48 saat içinde silinebilir — daha eski mesajlar hiçbir kodla
      silinemez (Telegram platform kısıtı, aşılamaz). Yani "son 5 günü
      temizle" gibi bir istek literal olarak karşılanamaz; kapsam en fazla
      "son 48 saat" olabilir.
    - **Geçmişe dönük arama yok**: Telegram bot'lara "kendi gönderdiğim
      mesajları listele" diye bir API vermiyor; `sendTelegramMessage_`
      şu an gönderdiği mesajın `message_id`'sini hiç saklamıyor. Bu yüzden
      bu özellik ancak **ileriye dönük** çalışabilir: `sendTelegramMessage_`
      (Telegram.js) Telegram'ın `sendMessage` yanıtından dönen `message_id`'yi
      - gönderim zamanını + mesaj tipini (örn. "netlestirme" vs "harcama
        onayı") bir yere (Script Properties ya da gizli bir Sheets sekmesi)
        kaydetmeli; ardından bir `/temizle` komutu veya zamanlı bir tetikleyici
        bu kayıtları tarayıp 48 saatten yeni ve tipi "netlestirme" olanları
        `deleteMessage` ile silmeli. Şu ana kadar test sırasında gönderilmiş
        mesajlar için (geriye dönük, `message_id` kaydı olmadığı ve muhtemelen
        48 saati de geçmiş olduğu için) kod tarafından yapılacak bir şey yok —
        kullanıcı Telegram istemcisinde elle silebilir.

## Az-token doğrulama rehberi (başka bilgisayar / yeni agentic oturum için)

Bu proje için ağır bir Node mock-Apps-Script harness'ı geliştirme sırasında
scratchpad'te (repo dışında, kalıcı değil) yazıldı — başka bir bilgisayarda ya
da yeni bir oturumda o harness'a erişim YOK ve yeniden kurmak ciddi token
harcar. Kullanıcı elle/gözle doğrulama isterse aşağıdaki tablo, doğrudan Apps
Script editöründen (sıfır Node/mock maliyeti) hangi fonksiyonun nasıl
kontrol edileceğini özetler — bu satırın ötesine geçip yeniden büyük bir test
harness'ı kurmaya ÇALIŞILMAMALI, önce bu tablo denenmeli.

| Kontrol edilecek | Nasıl (editörden elle çalıştır / Logger'a bak) |
| --- | --- |
| Aşama gecikmeleri (`RETRY_BACKOFF_DAKIKA`) | `sonrakiGecikmeDakika_(3)` çalıştır → `RETRY_BACKOFF_DAKIKA[2]` (40) ile aynı değeri döner (dizi değişirse referans da değişir, sabit sayı değil) |
| Son aşama tespiti | `sonAsamaMi_(RETRY_BACKOFF_DAKIKA.length)` → `true`; bir eksiği → `false` |
| Hata sınıflandırması | `hataGeciciMi_({httpStatus:404})` → `false`; `hataGeciciMi_({})` → `true` |
| "Yüksek talep"/kota tespiti | `hataYuksekTalepMi_({httpBody:'{"error":{"status":"UNAVAILABLE"}}'})` → `true`; `hataYuksekTalepMi_({httpStatus:429})` → `true` |
| Temiz hata metni JSON içermiyor | `kullaniciyaGosterilecekHataMetni_({httpStatus:503, httpBody:'{"error":{"status":"UNAVAILABLE"}}'})` çalıştır → sonuçta `{`/`}` OLMAMALI |
| Süre ifadesi | `gecenSureyiIfadeEt_(9*60000)` → `"9 dakika"`; `gecenSureyiIfadeEt_(125*60000)` → `"2 saat"` |
| Alıntı escape | `telegramAlinti_("ic\`kart")` → içindeki backtick tek tırnağa döner, dışı backtick'li kalır |
| Kuyruğun canlı özeti | `yenidenDenemeKuyruguDurumu()` çalıştır, Logger'daki `bekleyen`/`pesEdilen`/`tamamlanan`/`kayitliTriggerSayisi` alanlarına bak |
| Escalation zinciri (uçtan uca, gerçek) | `CONFIG.geminiModel`'i geçici olarak geçersiz bir isimle değiştir, gerçek bir Telegram mesajı gönder; `telegram_queue`'da o satırın `durum`/`deneme_asamasi`/`sonraki_deneme_zamani` sütunlarının dakika/saatlerle ilerleyişini izle |
| FIFO temizlik | Sheet'e elle `RETRY_TEMIZLIK_ESIK_MS`'den eski bir tarih + `durum=TAMAMLANDI` satırı ekle, herhangi bir mesaj gönderip `kuyrugaEkle_`'yi tetikle, satırın silindiğini gör |
| `/pesedilenler`, `/pesdene`, `/komutlar` | Doğrudan Telegram'dan gönder, cevabı oku — listelenen mesaj metinlerinin backtick içinde göründüğünü gözle doğrula |
| `/sonmesajisil` | Bir test mesajı gönder, hemen ardından `/sonmesajisil` gönder; queue'da o satırın `durum=SILINDI` olduğunu VE (48 saat içindeyse) Telegram'daki mesajın silindiğini doğrula. `BEKLIYOR` bir mesajda denenirse `yenidenDenemeKuyruguDurumu()`'nda `kayitliTriggerSayisi`'nin de düştüğünü kontrol et |
| Sahipsiz trigger temizliği | Gemini'yi geçici olarak bozup bir mesajın `BEKLIYOR`'a düşmesini sağla (bir trigger kurulur), sonra o satırı Sheets'te ELLE sil; trigger ateşlenene kadar bekle (en kısa aşama ~10dk); `yenidenDenemeKuyruguDurumu()`'ndaki `kayitliTriggerSayisi`'nin 0'a düştüğünü ve Apps Script editörü → Triggers listesinde o trigger'ın artık GÖRÜNMEDİĞİNİ doğrula |

Kod satır numaralarına referans VERİLMEDİ (kod değiştikçe kayar) — yalnızca
fonksiyon adları, çünkü onlar kararlı.

## Sonraki oturum için açık sorular

- Gerçek spreadsheet'in başlık/sütun düzeni `SHEET_LAYOUT` varsayımıyla
  birebir uyuşuyor mu?
- Tek kullanıcı (`CHAT_ID`) yeterli mi, yoksa birden fazla kişi/chat mi
  desteklenecek?
- `gemini-3.5-flash` gerçekten kullanılabilir bir model adı mı, yoksa çalışan
  güncel bir model adıyla mı değiştirilmeli?
- **Prod'da 2026-09-26 deploy'unda (versiyon 13) bulunan 2 sorun +
  2026-09-29'da istenen 4 iyileştirme HENÜZ push/deploy edilmedi** — hepsi
  aynı sıradaki `clasp push` + AYNI deployment ID'ye (`AKfycbxf7fYiksz8ZUNR_ymZKG-k-v0cJCQE3U_eHibUUK_q9NDvXmUFJ9mGT0nqBPZqmBdmqQ`)
  `clasp deploy -i <id>` ile gönderilecek (yeni bir deployment YARATMAYIN —
  webhook'un işaret ettiği URL değişmeden kalır, yeni kod hiç çalışmaz).
  Detaylar: 2026-09-26 düzeltmeleri (FIFO toplu silme, trigger-kurulamadı
  fallback'i, hata-maskeleme düzeltmesi) yukarıdaki "Gemini API geçici/kalıcı
  hatalarına karşı Katman 2" bölümünde; 2026-09-29 iyileştirmeleri
  (`/sonmesajisil`, 429 koruması + genişletilmiş backoff, temiz hata
  metinleri, backtick alıntılama) yukarıdaki "Retry sistemi iyileştirmeleri
  v2" bölümünde. Deploy sonrası sırayla doğrulanmalı:
  1. Apps Script editöründen `webhookDurumu()` çalıştırıp `url` alanındaki
     deployment ID'nin yukarıdaki ID ile eşleştiği doğrulanmalı (`clasp
     deployments` çıktısında 2 deployment var — biri `@HEAD`, biri bu
     versiyonlu ID; hangisi webhook'a kayıtlı olduğu netleşmeli). Aynı
     çalıştırma trigger yetkisi ("script.scriptapp") için "Review
     permissions" ekranını da tetikleyip onaylatmalı (push/deploy bunu
     otomatik yapmaz).
  2. Gerçek bir 503/429 ya da geçici `CONFIG.geminiModel` bozarak (404)
     uçtan uca doğrulanmalı; `yenidenDenemeKuyruguDurumu()` çıktısı ve
     `telegram_queue`'daki satırın `durum`/aşama sütunları kontrol edilmeli.
  3. `/sonmesajisil`, backtick alıntılama ve Markdown gönderimi yukarıdaki
     "Az-token doğrulama rehberi" tablosundaki adımlarla test edilmeli.
