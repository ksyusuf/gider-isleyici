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
   işlemek** — `text.startsWith("/")` ise ilgili fonksiyonu doğrudan
   tetiklemek hem daha hızlı hem daha ucuzdur (Gemini API çağrısı harcanmaz)
   hem de daha güvenilirdir (deterministik komutlar için modele güvenmeye
   gerek yok). `/son 10` gibi parametreli komutlar boşluktan bölünüp basitçe
   parse edilebilir.
3. **`/iptal` — son eklenen harcamayı geri alma** — tablo TARİH'e göre azalan
   sıralı olduğundan "son eklenen" her zaman `SHEET_LAYOUT.START_ROW`'daki
   satırdır. `sheet.deleteRow(SHEET_LAYOUT.START_ROW)` ile silinebilir.
   Yanlışlıkla eklenen bir harcamayı düzeltmek için kullanıcı deneyimini
   büyük ölçüde iyileştirir — şu an tek yol tabloyu elle açıp satırı silmek.

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
    — kullanıcının açık isteği (2026-08-30). Bu madde bilinçli olarak
    IMPLEMENTE EDİLMEDİ; amacı, bir sonraki agentic oturumda prompt şablonunun
    ne kadar geliştirilebileceğini anlatmak.

    **Hedef:** kullanıcının kendi sabit kategorileri API isteğine dahil
    edilecek ve Gemini'nin döndürdüğü `kategori` **kesinlikle** o kümeden biri
    olacak. Şu an `kategori` serbest metin; zamanla "Yemek", "yemek", "Gıda"
    gibi varyasyonlar birikiyor.

    **⚠️ Önce çözülmesi gereken açık soru — kategori listesi nerede?**
    Kullanıcı listenin `services/` altındaki Sheets sınıfında olduğunu
    söyledi, ancak kod tarandı ve **sabit bir kategori listesi bulunamadı**:
    - `services/SheetsGoogle.py` yalnızca sütun sözleşmesini (`TÜR` = 4.
      sütun) ve `__main__` demo verisinde tek bir örnek değeri (`'Kişisel'`)
      içeriyor.
    - `services/DocsGoogle.py` kategoriyi serbest metin olarak alıyor
      (`#t <tür>`); tek istisna `*` belirteci için otomatik `"Yemek"`
      ataması (~satır 311).

    Yani kanonik liste **kodda değil, gerçek spreadsheet'in TÜR sütununda**
    yaşıyor. İlk iş: listeyi kullanıcıdan almak ya da tablodan okuyup
    `Config.js`'e tek kaynak (`KATEGORILER` sabiti) olarak yazmak. Bu
    netleşmeden prompt yazılmamalı.

    **İki katmanlı zorlama (mevcut tasarım felsefesiyle uyumlu — bkz.
    `Config.js > TOOLS` yorumu: "tek başına systemInstruction'a güvenilmez"):**
    - `TOOLS`'taki `kategori` parametresine JSON Schema `enum` eklemek
      (Gemini'nin OpenAPI-subset şeması `enum` destekliyor) — model şema
      seviyesinde kısıtlanır.
    - `systemInstruction`'a kategori tanımları + ayrım kuralları eklemek.
    - **Üçüncü katman olarak kodda doğrulama:** `harcamaEkle`, listede
      olmayan bir `kategori` gelirse yazmayı reddedip netleştirme istemeli.
      Modelin şemaya uyacağına güvenilmemeli. Not: mevcut `harfBuyukYap_`
      normalizasyonu bu durumda yerini kanonik listeye birebir eşlemeye
      bırakmalı.

    **Asıl mesele — prompt ne kadar gelişmiş olabilir:** kategori listesini
    prompt'a düz bir liste olarak yapıştırmak yetmez. Kullanıcının verdiği
    kanonik örnek: *"bugün cups clouds'da 180 tl ice americano içtim"* —
    bunun bir **Kafe** harcaması olduğu insan için bellidir ama model doğal
    olarak **Yemek**'e yazabilir. Şablonun taşıması gereken katmanlar:

    1. **Kategori tanımları, sadece isimler değil.** Her kategori için kapsam
       sınırı yazılmalı: neyi KAPSAR, neyi KAPSAMAZ. ("Kafe: kahve/çay/atıştırma
       amaçlı oturma mekânlarındaki harcamalar. Öğün niteliğindeki restoran
       harcamalarını kapsamaz.")
    2. **Kategori sinyallerinin ayıklanması.** Model, metindeki kategoriye
       işaret eden ifadeleri açıkça tespit etmeli: ürün adı ("ice americano",
       "latte"), mekân adı ("cups clouds"), fiil ("içtim" vs "yedim"),
       miktar/bağlam. Kullanıcının vurguladığı nokta tam olarak bu:
       kategori kelimesi metinde geçmese bile ona **benzer/ima eden**
       ifadeler ayıklanmalı.
    3. **Karışabilen çiftler için açık öncelik kuralları.** Sadece
       Kafe↔Yemek değil; her karışabilen çift için kural yazılmalı
       (Market↔Yemek, Ulaşım↔Kişisel, Fatura↔Kişisel vb.). Sinyaller
       çeliştiğinde hangisinin kazandığı belirtilmeli — ör. ürün sinyali mi
       mekân sinyali mi baskın? Bu bir ürün kararı, kullanıcıya sorulmalı.
    4. **Karışabilen çiftlere odaklı few-shot örnekleri** (bkz. madde 10).
       Genel örnekler değil, tam olarak modelin yanıldığı sınır vakaları:
       "ice americano içtim" → Kafe, "kafede tost yedim" → ?, "markette
       hazır kahve aldım" → Market.
    5. **Liste dışına çıkma yasağı + uydurma yasağı.** Model hiçbir koşulda
       listede olmayan bir kategori üretmemeli; hiçbiri güvenle oturmuyorsa
       **tahmin etmek yerine sormalı**. Bu, mevcut ZORUNLU NETLİK KURALI'nın
       doğal uzantısıdır ve onunla aynı dille yazılmalı.
    6. **Gerçek hatalardan beslenme.** Kullanımda modelin yanlış kategorilediği
       vakalar biriktirilip few-shot örneklerine eklenmeli — prompt tek seferde
       değil, gözlemle olgunlaşır.

    **Takas:** sabit küme, kullanıcının serbestçe yeni kategori açma
    esnekliğini kısıtlar. Yeni kategori eklemek `Config.js` düzenlemesi +
    redeploy gerektirir.
12. **Bot'un kendi gönderdiği (özellikle "❓ Netleştirilmesi gerekenler")
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
