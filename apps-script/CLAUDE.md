# apps-script/ — Notlar (Claude için)

Bu klasör, `gider-isleyici` projesindeki eski Docs-tabanlı akışın yerine geçecek
yeni bir bot olarak eklendi: kullanıcı Telegram'a Türkçe doğal dille yazıyor,
Google Gemini function calling ile ayrıştırılıyor, sonuç doğrudan aynı Google
Sheets veri sözleşmesine (D:I sütunları) yazılıyor. Detaylı kurulum için
`apps-script/README.md`'ye bakın.

## Önemli Kurallar

Asla clasp komutlarını çalıştırma.
Asla git push komutunu çalıştırma.
git komutları konusunda yöneticinin açık istekleri olmadan işlem yapma.

## Ne yapıldı

- Kod, sorumluluklarına göre 3 dosyaya bölündü (Apps Script'te tüm dosyalar
  aynı global scope'u paylaştığı için fonksiyon adları dosyalar arası
  sorunsuz erişilebilir — fonksiyon bildirimleri proje genelinde hoisted
  olur):
  - `Config.js`: `CONFIG`, `TIME_ZONE`, `SHEET_LAYOUT`, `TOOLS` (Gemini
    function declarations şeması).
  - `Expenses.js`: Sheets D:I yazma/okuma/sıralama yardımcıları +
    `harcamaEkle` / `sonHarcamalariGetir` / `sonHarcamalariTopla`.
  - `Main.js`: `FUNCTION_MAP`, Gemini REST entegrasyonu (v1beta
    `generateContent`, function calling, her istekte mesajın Telegram'a
    gönderildiği ana göre dinamik kurulan bir `systemInstruction`), Telegram
    entegrasyonu, `update_id` bazlı dedup (`isYeniUpdate_`) ve `doPost`
    webhook giriş noktası, geliştirici yardımcı fonksiyonları
    (`kurulumWebhook`, `webhookDurumu`, `webhookSil`).
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
- Loglama: `Main.js`'teki `log_(etiket, veri)` / `logHata_(etiket, err)`
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
   işlemek** — **UYGULANDI (2026-08-31):** `Main.js > islemKomut_` +
   `doPost`'taki erken-çıkış dalı. Komutlar: `/son [N]`, `/toplam [N]`,
   `/komutlar` (komut listesi); tanınmayan `/xxx` → "Komut bulunamadı" +
   aynı liste (`KOMUT_LISTESI_METNI`). Sıfır Gemini API çağrısı/maliyeti —
   Node üzerinde mock Sheets ile doğrulandı.
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
    prompt kural-tabanlı; `Main.js`'teki `SYSTEM_INSTRUCTION_TEMPLATE`'e 2-3
    somut örnek (özellikle "kısmi ekleme + kısmi netleştirme" ve "çoklu
    harcama" senaryoları için input → beklenen fonksiyon çağrıları)
    eklenmesi, modelin kuralları — özellikle ZORUNLU NETLİK KURALI'nı — daha
    tutarlı uygulamasını sağlayabilir. Gerçek kullanım sonrası modelin hatalı
    davrandığı örnekler biriktirilip buraya eklenebilir.
11. **Sabit kategori kümesi + kategori ayrım (disambiguation) prompt'u**
    — kullanıcının açık isteği (2026-08-30). **UYGULANDI (2026-08-31):**
    `Config.js` (`KATEGORILER` sabiti + `TOOLS.kategori.enum`), `Main.js`
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
      (Main.js) Telegram'ın `sendMessage` yanıtından dönen `message_id`'yi
      - gönderim zamanını + mesaj tipini (örn. "netlestirme" vs "harcama
        onayı") bir yere (Script Properties ya da gizli bir Sheets sekmesi)
        kaydetmeli; ardından bir `/temizle` komutu veya zamanlı bir tetikleyici
        bu kayıtları tarayıp 48 saatten yeni ve tipi "netlestirme" olanları
        `deleteMessage` ile silmeli. Şu ana kadar test sırasında gönderilmiş
        mesajlar için (geriye dönük, `message_id` kaydı olmadığı ve muhtemelen
        48 saati de geçmiş olduğu için) kod tarafından yapılacak bir şey yok —
        kullanıcı Telegram istemcisinde elle silebilir.

## Sonraki oturum için açık sorular

- Gerçek spreadsheet'in başlık/sütun düzeni `SHEET_LAYOUT` varsayımıyla
  birebir uyuşuyor mu?
- Tek kullanıcı (`CHAT_ID`) yeterli mi, yoksa birden fazla kişi/chat mi
  desteklenecek?
- `gemini-3.5-flash` gerçekten kullanılabilir bir model adı mı, yoksa çalışan
  güncel bir model adıyla mı değiştirilmeli?
