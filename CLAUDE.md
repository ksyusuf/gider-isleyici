# gider-isleyici — Proje Notları (Claude için)

## Genel bakış
Repo iki paralel akış barındırıyor:

1. **Eski/mevcut**: Python/Flask (`index.py`, `services/*.py`) — Google
   Docs'a serbest-biçimli-ama-kurallı metinle (`#f`, `#t`, `#m`, `#a`, `*tutar`
   gibi belirteçlerle) girilen harcamaları ayrıştırıp (`services/DocsGoogle.py`)
   Sheets REST API v4 + service-account credential ile Google Sheets'e yazıyor
   (`services/SheetsGoogle.py`), Docs'a log tutuyor (`services/GoogleDriveLogger.py`),
   basit bir web arayüzü sunuyor (`templates/`, `static/`).
2. **Yeni**: `apps-script/` — Telegram + Google Gemini function calling
   tabanlı Google Apps Script Web App; Docs adımını tamamen atlayıp doğrudan
   Telegram'dan Sheets'e yazıyor. Detaylar ve açık sorular için
   `apps-script/CLAUDE.md`.

İkisi de AYNI Google Sheets veri sözleşmesini hedefliyor (D:I sütunları:
`TARİH, TUTAR, FİRMA, TÜR, MALZEME, AÇIKLAMA`); `apps-script` bu sözleşmeyi
`services/SheetsGoogle.py`'den tespit edip birebir koruyacak şekilde
tasarlandı.

## Makro seviye olası problemler / gözlemler
- **`requirements.txt` bozuk görünüyor**: her karakter arasında fazladan
  boşluk var (örn. `F l a s k = = 3 . 0 . 2`). Muhtemelen UTF-16 kodlamalı bir
  dosyanın yanlış encoding ile kaydedilmesinden kaynaklanıyor.
  `pip install -r requirements.txt` bu haliyle muhtemelen başarısız olur;
  dosya doğru encoding ile yeniden oluşturulmalı (`pip freeze > requirements.txt`,
  UTF-8/ASCII).
- **`services/DocsGoogle.py` içinde `eval(harcama[1:])` kullanılıyor**
  (~satır 245) — orijinal yazar da bunu koda "güvenlik açığı !!!" diye not
  düşmüş. Docs'a yazabilen herkes keyfi Python ifadesi çalıştırabilir. Flask
  akışı hâlâ kullanılıyorsa bu risk hâlâ geçerli. Yeni `apps-script` akışına
  bu mantık taşınmadı — Gemini `tutar`'ı doğrudan `NUMBER` tipinde parse
  ediyor, `eval` yok; bu bir güvenlik iyileştirmesi.
- **Kimlik doğrulama modelleri tamamen farklı**: eski akış `.env` + bir
  service-account JSON dosya yolu (`JSON` env var, `keys/` klasörü zaten
  `.gitignore`'da) kullanıyor. Yeni `apps-script` akışı `PropertiesService`
  kullanıyor ve service-account JSON'a hiç ihtiyaç duymuyor (kullanıcının
  Apps Script projesine doğal yetkisiyle çalışıyor). İkisi karıştırılmamalı.
- **Aynı spreadsheet'e eşzamanlı yazma riski**: iki akış da aynı üretim
  spreadsheet'ine yazacaksa, ikisinin de aynı anda aktif olması "ilk boş
  satır"a yazma + sıralama mantığında çakışmaya yol açabilir. Geçiş
  sürecinde (Docs'tan Telegram'a taşınırken) ikisi birlikte kullanılıyorsa
  buna dikkat edilmeli.

## Geliştirme fikirleri (gelecekte değerlendirilebilir, şu an istenmedi)
- `apps-script` tarafında fonksiyon sonuçlarını Gemini'ye geri gönderen ikinci
  bir round-trip eklenip daha doğal/insansı özet cevaplar üretilebilir (şu an
  bilinçli olarak tek round-trip — kullanıcının orijinal spesifikasyonu
  buydu).
- `CHAT_ID` tek kullanıcı yerine bir liste/allowlist'e genişletilip çoklu
  kullanıcı desteklenebilir.
- Flask/Docs akışı tamamen kaldırılıp proje `apps-script`'e taşınabilir ya da
  iki "giriş kaynağı" (Docs vs Telegram) bilinçli şekilde birlikte
  tutulabilir — bu bir ürün kararı, kod kısıtı değil.
- `apps-script` tarafında otomatik test yok (Apps Script'te yaygın bir yerel
  unit test altyapısı yok); en azından `harcamaEkle` / `sonHarcamalariGetir`
  / `sonHarcamalariTopla` için `TEST_MODE` + bir test spreadsheet üzerinde
  manuel smoke-test rutini bir kontrol listesi olarak README'ye eklenebilir.

## Referanslar
- Yeni Telegram/Gemini botu: `apps-script/Config.js` + `apps-script/Expenses.js`
  + `apps-script/Main.js` (+ `apps-script/README.md`, açık sorular ve
  varsayımlar için `apps-script/CLAUDE.md`).
- Eski Sheets yazma mantığı (yeni akışın veri sözleşmesinin kaynağı):
  `services/SheetsGoogle.py`.
- Eski doğal-dil-benzeri ayrıştırma mantığı (artık `apps-script`'te Gemini'ye
  devredildi): `services/DocsGoogle.py`.
