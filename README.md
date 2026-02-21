# Gider İşleyici

Basit bir kişisel proje: Google Docs üzerinden girilen gider kalemlerini
web arayüzünde görüntüleyip onayladıktan sonra Google Sheets'e düzenli
şekilde aktaran hafif bir iş akışı sağlar.

## Öne Çıkan Özellikler

- Google Docs üzerinde oluşturulan gider girdilerini okuma
- Web arayüzü üzerinden giderleri görüntüleme ve teyit etme
- Onaylanan girdileri tarih sıralı olarak Google Sheets'e kaydetme
- Sheet içinde analiz edilebilecek şekilde veri düzenleme

## Çalışma Mantığı

1. Gider kalemleri Google Docs'a girilir.
2. Uygulama Docs içeriğini web arayüzünde listeler.
3. Kullanıcı görüntüleyip giderleri teyit eder.
4. Onaylanan veriler Google Sheets'e aktarılır ve tarih sıralamasına göre düzenlenir.

Hatalı formatlı girdiler otomatik olarak işlenmez; bu tür veriler
görüntüleme/kaydetme aşamalarında beklemede kalabilir ve kullanıcı müdahalesi
gerektirebilir.

## Kurulum

1. Depoyu klonlayın.
2. Sanal ortam oluşturup aktif edin (önerilir).
3. Gerekli paketleri yükleyin:

```
pip install -r requirements.txt
```

4. Google API kimlik bilgilerinizi ayarlayın. Projede `keys/` dizini örnek
kimlik dosyaları içerir; isterseniz `.env` dosyası içinde veya doğrudan
uygulama ayarlarında bu yolları belirtin.

Örnek çevresel değişkenler:

- `GOOGLE_CREDENTIALS_PATH` : Google API yetki dosyası yolu
- `FLASK_ENV` veya benzeri uygulama konfigürasyonları (varsa)

## Kullanım

1. Sanal ortamı aktifleştirin.
2. Uygulamayı çalıştırın (örnek):

```
python index.py
```

3. Tarayıcıdan arayüze gidip Google Docs verilerini görüntüleyin,
   gerekli onayları verip verileri Sheets'e aktarın.

Not: Projede birden fazla potansiyel giriş noktası olabilir (`index.py`,
`services/main.py` vb.). Kendi kurulumunuza göre uygun olan dosyayı çalıştırın.

## Dikkat Edilmesi Gerekenler

- Proje kişisel amaçlıdır; üretim hazırlığı, güvenlik ve hata yakalama
  mekanizmaları eklenmemiş olabilir.
- Hatalı formatlı veriler elle düzeltilmeden otomatik işleme alınmayabilir.

## Katkıda Bulunma

Küçük iyileştirmeler ve hata düzeltmeleri memnuniyetle kabul edilir. Lütfen
önce bir issue açıp değişikliklerinizi açıklayın.

## Lisans

Bu proje kişisel kullanım içindir — açık kaynak bir lisans eklemek istiyorsanız
lütfen uygun lisansı belirtin.

## Test & Debug — Çekirdek Sınıfları Lokal Olarak Çalıştırma

Projede çekirdek sınıflar (`GoogleDocs`, `GoogleSheets`, `Kaydedici`) doğrudan
ilgili modüller çalıştırılarak test edilebilir. Her modül kendi başına
debug/run desteği içermektedir ve çalışma sırasında proje kökündeki `.env`
dosyası yüklenir (varsa).

Gereken temel çevresel değişkenler (örnek isimler proje içinde kullanılıyor):

- `JSON` : Service account JSON anahtar dosyasının yolu
- `DOCUMENT_ID` : Google Docs doküman ID'si
- `log_docs_id` : Log kaydı için Docs ID (index.py içinde `LOG_DOCS_ID` olarak okunur)
- `spreadsheet_id` : Google Sheets ID'si
- `sheet_id` : Sheet içindeki sayfa ID'si (sayısal)
- `DEBUG` : `True`/`False` — Flask debug modu
- `PORT` : Uygulama portu (ör. `2000`)

Örnek `.env` (proje kökünde `.env` olarak kaydedin):

```
JSON=keys/yourkey.json
DOCUMENT_ID=1aBcDeFgHiJkLmNoPqRs
log_docs_id=1XxXxXxXxXxXx
spreadsheet_id=1YyYyYyYyYyYy
sheet_id=0
DEBUG=True
PORT=2000
```

Örnek çalıştırma komutları

- Flask uygulamasını başlatmak (tam özellikli web arayüzü):

```powershell
venv\Scripts\Activate.ps1
python index.py
```

- `GoogleDocs` servisini tek başına test etmek:

```powershell
venv\Scripts\Activate.ps1
python services\DocsGoogle.py
```

- `GoogleSheets` servisini tek başına test etmek (örnek veri yükler):

```powershell
venv\Scripts\Activate.ps1
python services\SheetsGoogle.py
```

- Koordinatör `Kaydedici` sınıfını modül olarak çalıştırmak (bilgilendirici çıktı verir):

```powershell
venv\Scripts\Activate.ps1
python services\main.py
```

Notlar

- Modüllerin doğrudan çalıştırılması (`python services\DocsGoogle.py` vb.)
  debug amaçlıdır ve önce `.env` içindeki gerekli değişkenlerin ayarlanmasını
  bekler. Eksik bir değişken varsa ilgili modül bilgilendirici bir uyarı
  yazdırır.
- `index.py` uygulama başlatıcısıdır; burada servis örnekleri oluşturulur ve
  Flask route'lar bağlanır. Lokal testlerde genelde `index.py` kullanmak yeterli
  olacaktır.

