# apps-script/ — Notlar (Claude için)

Bu klasör, `gider-isleyici` projesindeki eski Docs-tabanlı akışın yerine geçecek
yeni bir bot olarak eklendi: kullanıcı Telegram'a Türkçe doğal dille yazıyor,
Google Gemini function calling ile ayrıştırılıyor, sonuç doğrudan aynı Google
Sheets veri sözleşmesine (D:I sütunları) yazılıyor. Detaylı kurulum için
`apps-script/README.md`'ye bakın.

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
    entegrasyonu ve `doPost` webhook giriş noktası, geliştirici yardımcı
    fonksiyonları (`kurulumWebhook`, `webhookSil`).
- Sheets sütun sözleşmesi repo kökündeki `services/SheetsGoogle.py`'den
  (eski Python/Flask akışı) tespit edildi: `D=TARİH, E=TUTAR, F=FİRMA, G=TÜR,
  H=MALZEME, I=AÇIKLAMA`, veri `D3`'ten başlıyor, her eklemede TARİH'e göre
  azalan sıralanıyor. `SHEET_LAYOUT` sabiti (`Config.js` başında) bu
  varsayımı tek yerde topluyor.
- `appsscript.json`, `README.md` eklendi. Repo kökündeki `.gitignore`'a
  `.clasp.json` eklendi (scriptId ortam-özel); `appsscript.json` bilinçli
  olarak repoda tutuldu (sır içermiyor, `clasp push` için gerekli).

## Doğrulanmadı / uçtan uca test edilmedi (önemli)
Bu kod hiç çalıştırılmadı — gerçek bir Google Sheets tablosuna, gerçek bir
Telegram bot token'ına ya da gerçek bir Gemini API key'ine erişim yoktu.
`clasp push`, deploy, `kurulumWebhook()` ve gerçek Telegram mesajlarıyla test
mutlaka bir sonraki oturumda/kullanıcı tarafından yapılmalı. Plandaki
"Doğrulama" senaryoları (çoklu harcama + göreceli tarih, belirsizlik reddi,
karma senaryo, yetkisiz chat.id, hatalı payload) hâlâ manuel olarak koşulmayı
bekliyor.

- `CONFIG.geminiModel = "gemini-3.5-flash"` kullanıcının verdiği isimle birebir
  kullanıldı; bu model adının Gemini API'de gerçekten var olup olmadığı
  doğrulanamadı (yazım tarihimden sonra yayınlanmış olabilir). İlk testte
  404/"model not found" hatası alınırsa `CONFIG.geminiModel`'i güncel bir
  model adıyla değiştirin.

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
- Hata/log çıktıları `console.error` ile Stackdriver'a düşüyor; log izlemek
  için Apps Script editöründe **Executions** sekmesine bakılmalı.
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

8. **Aynı update'in iki kez işlenmesine karşı koruma** — Telegram, webhook
   zamanında yanıt alamazsa isteği tekrar gönderebilir; `doPost` yavaş
   çalışırsa (Gemini yanıtı gecikirse) aynı harcama iki kez eklenebilir.
   `update.update_id`'yi `CacheService.getScriptCache()` içinde kısa süreliğine
   (örn. 5 dk) saklayıp tekrarlanan `update_id`'leri sessizce yok saymak bu
   riski ortadan kaldırır.
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
11. **Kategori listesini sabitleme/normalize etme** — şu an `kategori`
    serbest metin; zamanla "Yemek", "yemek", "Gıda" gibi varyasyonlar
    birikebilir. Sabit bir kategori listesi `TOOLS`'taki `kategori`
    parametresine JSON Schema `enum` olarak eklenirse (Gemini'nin
    OpenAPI-subset şeması `enum` destekliyor) tutarlılık artar — ama bu,
    kullanıcının serbestçe yeni kategori açma esnekliğini kısıtlar, bir ürün
    kararı gerektirir.
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
      + gönderim zamanını + mesaj tipini (örn. "netlestirme" vs "harcama
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
