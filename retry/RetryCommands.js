/**
 * ============================================================================
 * Gider İşleyici — Katman 2 Manuel Komut Yüzeyi (`/pesedilenler`, `/pesdene`)
 * + Teşhis
 * ============================================================================
 * `retry/RetryCore.js`'teki otomatik motorun (trigger'lar tarafından
 * tetiklenen) AKSİNE, bu dosyadaki fonksiyonlar Telegram komutlarıyla (bkz.
 * Telegram.js > islemKomut_) ya da Apps Script editöründen elle çağrılır.
 * Retry motorunun sabitlerini/yardımcılarını (RETRY_DURUM,
 * kuyrukTumSatirlariOku_, satiriGuncelle_, getOrCreateQueueSheet_ vb.)
 * RetryCore.js'ten aynen kullanır — kendi bookkeeping mantığını tekrarlamaz.
 *
 * İlgili diğer dosyalar:
 *   - retry/RetryCore.js: RETRY_DURUM, kuyrukTumSatirlariOku_, satiriGuncelle_, RETRY_HANDLER_FN_ADI
 *   - Queue.js: getOrCreateQueueSheet_
 *   - Gemini.js: mesajiIsleVeYanitla_ (SADECE pesEdilenleriTekrarDene_ tarafından çağrılır)
 *   - Telegram.js: islemKomut_ (`/pesedilenler`/`/pesdene` komutlarını bu dosyadaki
 *     fonksiyonlara yönlendirir)
 */

/**
 * `/pesedilenler` komutunun çıktısı: kuyruktaki TÜM `PES_EDILDI` satırlarını
 * (otomatik tekrar denemesi tükenmiş/kalıcı hatayla başarısız kalmış mesajlar)
 * okunabilir bir listeye çevirir. Gemini'ye hiç gitmez, tamamen deterministik.
 * @return {string}
 */
function pesEdilenleriListele_() {
  var sheet = getOrCreateQueueSheet_();
  var simdi = new Date();
  var pesEdilenler = kuyrukTumSatirlariOku_(sheet).filter(function (row) {
    return row.durum === RETRY_DURUM.PES_EDILDI;
  });

  if (pesEdilenler.length === 0) {
    return "Pes edilmiş mesaj yok. 🎉";
  }

  var satirlar = pesEdilenler.map(function (row, i) {
    var ilkHataMs =
      row.ilkHataZamani instanceof Date
        ? row.ilkHataZamani.getTime()
        : new Date(row.ilkHataZamani).getTime();
    var saatOnce = Math.max(
      1,
      Math.round((simdi.getTime() - ilkHataMs) / 3600000),
    );
    return (
      i +
      1 +
      ". (" +
      saatOnce +
      " saat önce) " +
      row.text +
      "\n   Hata: " +
      row.sonHataMesaji
    );
  });

  return (
    "❌ " +
    pesEdilenler.length +
    " pes edilmiş mesaj var — /pesdene ile topluca tekrar deneyebilirsin:\n\n" +
    satirlar.join("\n\n")
  );
}

/**
 * `/pesdene` komutunun çıktısı: kuyruktaki TÜM `PES_EDILDI` satırlarını, her
 * biri için Katman 1'i (Gemini.js > callGeminiIleTekrarDeneme_, en fazla
 * GEMINI_MAX_DENEME hızlı deneme) kullanarak ŞİMDİ topluca tekrar dener.
 * Katman 2'ye (yeni trigger kurma) HİÇ girmez — bu SADECE anlık, manuel bir
 * deneme; hâlâ başarısız kalanlar PES_EDILDI'de kalır (silinmez), sadece
 * `son_hata_mesaji`/`son_deneme_zamani` güncellenir. Başarılı olanlar
 * otomatik akışla simetrik şekilde TAMAMLANDI'ya geçer (burada silinmez,
 * FIFO temizliğine bırakılır) — bkz. RetryCore.js > eskiKayitlariTemizle_.
 * @return {string} Kullanıcıya gösterilecek özet.
 */
function pesEdilenleriTekrarDene_() {
  var sheet = getOrCreateQueueSheet_();
  var pesEdilenler = kuyrukTumSatirlariOku_(sheet)
    .filter(function (row) {
      return row.durum === RETRY_DURUM.PES_EDILDI;
    })
    .sort(function (a, b) {
      return b.satirNo - a.satirNo; // azalan sırayla işle, index kaymasına karşı savunma
    });

  if (pesEdilenler.length === 0) {
    return "Pes edilmiş mesaj yok, tekrar denenecek bir şey bulunamadı.";
  }

  var basarili = [];
  var basarisiz = [];

  pesEdilenler.forEach(function (row) {
    var simdi = new Date();
    try {
      var mesajZamaniSaniye = Math.floor(row.mesajTarihi.getTime() / 1000);
      var cevapMetni = mesajiIsleVeYanitla_(row.text, mesajZamaniSaniye);
      satiriGuncelle_(sheet, row, {
        durum: RETRY_DURUM.TAMAMLANDI,
        sonHataMesaji: "",
        sonDenemeZamani: simdi,
      });
      basarili.push({ text: row.text, cevap: cevapMetni });
    } catch (err) {
      satiriGuncelle_(sheet, row, {
        sonHataMesaji: err.message,
        sonDenemeZamani: simdi,
      });
      basarisiz.push({ text: row.text, hata: err.message });
    }
  });

  var bloklar = [];
  if (basarili.length > 0) {
    bloklar.push(
      "✅ " +
        basarili.length +
        " mesaj başarıyla işlendi:\n" +
        basarili
          .map(function (b, i) {
            return i + 1 + ". " + b.text + "\n   " + b.cevap;
          })
          .join("\n\n"),
    );
  }
  if (basarisiz.length > 0) {
    bloklar.push(
      "❌ " +
        basarisiz.length +
        " mesaj hâlâ başarısız, PES_EDILDI'de kaldı:\n" +
        basarisiz
          .map(function (b, i) {
            return i + 1 + ". " + b.text + "\n   Hata: " + b.hata;
          })
          .join("\n\n"),
    );
  }
  return bloklar.join("\n\n");
}

// ============================================================================
// Geliştirici yardımcı fonksiyonu (webhookDurumu() deseniyle tutarlı, elle çalıştırılır)
// ============================================================================

/**
 * Kuyruğun anlık retry durumunu özetler: kaç satır BEKLIYOR/ISLENIYOR/
 * PES_EDILDI/TAMAMLANDI (toplam mesaj sayısı DEĞİL, sadece durum dolu olan
 * retry-takipli satırlar), en eski `ilk_hata_zamani` kaç saat önce, kaç
 * trigger kayıtlı. `pesEdilen` satırlar ASLA otomatik temizlenmez (bkz.
 * RetryCore.js > eskiKayitlariTemizle_) — bu sayı > 0 ise kullanıcının
 * Sheets'te elle kaydetmesi gereken, sistemin işleyemediği harcama(lar)
 * olduğu anlamına gelir. `isleniyor` sayısının bir tarama sürmüyorken > 0
 * görünmesi, önceki bir execution'ın ortasında kesintiye uğrayıp satırın
 * ISLENIYOR'da takılı kaldığına işaret edebilir (periyodik bir self-heal
 * YOK, bkz. RetryCore.js dosya başı yorum) — bu durumda satır elle
 * BEKLIYOR'a çekilip trigger yeniden kurulmalıdır (silinmemeli).
 * @return {Object}
 */
function yenidenDenemeKuyruguDurumu() {
  var sheet = getOrCreateQueueSheet_();
  var simdi = new Date();
  var satirlar = kuyrukTumSatirlariOku_(sheet).filter(function (r) {
    return r.durum; // sadece retry-takipli (durum dolu) satırlar
  });

  var bekleyen = satirlar.filter(function (r) {
    return r.durum === RETRY_DURUM.BEKLIYOR;
  });
  var isleniyor = satirlar.filter(function (r) {
    return r.durum === RETRY_DURUM.ISLENIYOR;
  });
  var pesEdilen = satirlar.filter(function (r) {
    return r.durum === RETRY_DURUM.PES_EDILDI;
  });
  var tamamlanan = satirlar.filter(function (r) {
    return r.durum === RETRY_DURUM.TAMAMLANDI;
  });

  var enEskiMs = satirlar.reduce(function (acc, r) {
    var t =
      r.ilkHataZamani instanceof Date
        ? r.ilkHataZamani.getTime()
        : new Date(r.ilkHataZamani).getTime();
    return acc === null || t < acc ? t : acc;
  }, null);

  var kayitliTriggerSayisi = ScriptApp.getProjectTriggers().filter(
    function (t) {
      return t.getHandlerFunction() === RETRY_HANDLER_FN_ADI;
    },
  ).length;

  var ozet = {
    retryTakipliSatir: satirlar.length,
    bekleyen: bekleyen.length,
    isleniyor: isleniyor.length,
    pesEdilen: pesEdilen.length,
    tamamlanan: tamamlanan.length,
    enEskiIlkHataSaatOnce:
      enEskiMs === null
        ? null
        : Math.round((simdi.getTime() - enEskiMs) / 3600000),
    kayitliTriggerSayisi: kayitliTriggerSayisi,
  };
  Logger.log(JSON.stringify(ozet));
  return ozet;
}
