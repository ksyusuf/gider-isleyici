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
 *   - retry/RetryCore.js: RETRY_DURUM, kuyrukTumSatirlariOku_, satiriGuncelle_,
 *     zamanliTetikleyiciSil_, gecenSureyiIfadeEt_, RETRY_HANDLER_FN_ADI
 *   - Queue.js: getOrCreateQueueSheet_
 *   - LLM.js: mesajiIsleVeYanitla_ (SADECE pesEdilenleriTekrarDene_ tarafından
 *     çağrılır) / kullaniciyaGosterilecekHataMetni_
 *   - Telegram.js: islemKomut_ (`/pesedilenler`/`/pesdene`/`/sonmesajisil`
 *     komutlarını bu dosyadaki fonksiyonlara yönlendirir) / telegramAlinti_ /
 *     telegramMesajiSil_
 */

/**
 * `/pesedilenler` komutunun çıktısı: kuyruktaki TÜM `PES_EDILDI` satırlarını
 * (otomatik tekrar denemesi tükenmiş/kalıcı hatayla başarısız kalmış mesajlar)
 * okunabilir bir listeye çevirir. LLM'e hiç gitmez, tamamen deterministik.
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
    var neKadarOnce = gecenSureyiIfadeEt_(simdi.getTime() - ilkHataMs);
    return (
      i +
      1 +
      ". (" +
      neKadarOnce +
      " önce) " +
      telegramAlinti_(row.text) +
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
 * biri için Katman 1'i (LLM.js > llmIleTekrarDeneme_, en fazla
 * LLM_MAX_DENEME hızlı deneme) kullanarak ŞİMDİ topluca tekrar dener.
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
      var temizHataMetni = kullaniciyaGosterilecekHataMetni_(err);
      satiriGuncelle_(sheet, row, {
        sonHataMesaji: temizHataMetni,
        sonDenemeZamani: simdi,
      });
      basarisiz.push({ text: row.text, hata: temizHataMetni });
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
            return i + 1 + ". " + telegramAlinti_(b.text) + "\n   " + b.cevap;
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
            return i + 1 + ". " + telegramAlinti_(b.text) + "\n   Hata: " + b.hata;
          })
          .join("\n\n"),
    );
  }
  return bloklar.join("\n\n");
}

/**
 * `/sonmesajisil` komutunun çıktısı: bu chat'e ait, komutun KENDİ satırı
 * (`buKomutunUpdateId` — komut mesajı da `kuyrugaEkle_` tarafından ondan
 * ÖNCE eklenmiş olacağı için "son satır" aramasının komutu yakalamaması
 * gerekir) HARİÇ en son satırı bulur:
 *   - `BEKLIYOR`/`ISLENIYOR` ise kurulu trigger'ı (varsa) iptal eder.
 *   - Durumu `SILINDI` yapar (TAMAMLANDI gibi FIFO ile temizlenebilir hale
 *     gelir, ASLA "unutulmuş harcama" sayılmaz çünkü kullanıcı BİLEREK iptal
 *     etti).
 *   - Telegram'daki mesajı silmeyi DENER (best-effort — sadece son 48 saat
 *     içindeki mesajlar için çalışır, bkz. Telegram.js > telegramMesajiSil_).
 *
 * KAPSAM DIŞI (bilinçli): Expenses (D:I) harcama tablosuna DOKUNMAZ — eğer
 * mesaj zaten başarıyla işlenip harcama tabloya yazıldıysa (durum=TAMAMLANDI/
 * boş), o harcama satırı silinmez. Taksitli harcama nedeniyle "hangi satır
 * en son yazıldı" güvenilir şekilde bilinemiyor (bkz. Geliştirme fikirleri
 * madde 3, `/iptal` fikri aynı sebeple askıya alınmıştı) — bu risk burada da
 * kapsam dışı tutuldu.
 * @param {number|string} chatId
 * @param {number} buKomutunUpdateId
 * @return {string}
 */
function sonMesajiSil_(chatId, buKomutunUpdateId) {
  var sheet = getOrCreateQueueSheet_();
  var adaylar = kuyrukTumSatirlariOku_(sheet)
    .filter(function (row) {
      return (
        String(row.chatId) === String(chatId) &&
        Number(row.updateId) !== Number(buKomutunUpdateId)
      );
    })
    .sort(function (a, b) {
      return b.satirNo - a.satirNo;
    });

  if (adaylar.length === 0) {
    return "Silinecek önceki bir mesaj bulunamadı.";
  }

  var hedef = adaylar[0];

  if (
    hedef.durum === RETRY_DURUM.BEKLIYOR ||
    hedef.durum === RETRY_DURUM.ISLENIYOR
  ) {
    zamanliTetikleyiciSil_(hedef.triggerId);
  }

  satiriGuncelle_(sheet, hedef, {
    durum: RETRY_DURUM.SILINDI,
    triggerId: "",
  });

  var telegramdanSilindiMi = hedef.messageId
    ? telegramMesajiSil_(chatId, hedef.messageId)
    : false;

  var alinti = telegramAlinti_(hedef.text);
  if (telegramdanSilindiMi) {
    return (
      "🗑️ Mesaj silindi: " +
      alinti +
      "\nOtomatik tekrar deneme (varsa) iptal edildi."
    );
  }
  return (
    "🗑️ Telegram'daki mesajı silemedim (48 saatten eski olabilir ya da zaten silinmiş): " +
    alinti +
    "\nAma otomatik tekrar deneme (varsa) iptal edildi."
  );
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
