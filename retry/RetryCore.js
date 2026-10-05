/**
 * ============================================================================
 * Gider İşleyici — LLM Geçici/Kalıcı Hatalarında Katman 2: Otomatik Tekrar
 * Deneme Motoru (Trigger Zinciri)
 * ============================================================================
 * LLM.js > llmIleTekrarDeneme_ (Katman 1) bir mesaj için art arda
 * LLM_MAX_DENEME kez denendiği halde GEÇİCİ bir hatayla (503, ağ hatası,
 * boş yanıt vb.) başarısız kalırsa, bu dosya o mesaja özel, TEK SEFERLİK bir
 * Apps Script trigger kurar (ilk kez 10 dakika sonrasına). Trigger
 * ateşlendiğinde yine Katman 1 (3 hızlı deneme) çalışır; yine geçici bir
 * hatayla başarısız olursa BİR SONRAKİ AŞAMA için yeni bir tek seferlik
 * trigger kurulur. Aşama gecikmeleri RETRY_BACKOFF_DAKIKA: 10-20-40 dakika,
 * sonra 1-1-2-2-4 saat (toplam 8 aşama, ~11 saat 10 dakika — kısa/hızlı
 * geçici blipler için ilk üç aşama dakika mertebesinde, sürdürülebilir
 * sorunlar için son aşamalar saat mertebesinde, 2026-09-29 kullanıcı kararı).
 * Son (8.) aşama da başarısız olursa sistem PES EDER — 9. bir trigger
 * KURULMAZ, satır `PES_EDILDI` durumuna işaretlenir (ASLA silinmez) ve
 * kullanıcıya hem bu mesaj için hem de kuyrukta biriken diğer pes-edilmiş
 * mesajlar için toplu bir bildirim gönderilir. Kalıcı bir HTTP hatası
 * (400/401/403/404 — LLM.js > LLM_KALICI_HTTP_KODLARI) alınırsa hiç
 * retry denenmeden aynı PES_EDILDI yoluna girilir (bkz.
 * pesEdildiKuyruguEkleVeBildir_). LLM'in "model şu an yüksek talepte"
 * (`error.status: "UNAVAILABLE"`) YA DA kota/rate-limit dolu (`httpStatus
 * === 429`) yanıtları özel olarak tanınır (LLM.js > hataYuksekTalepMi_):
 * sebep zaten bilindiği için Katman 1'in hızlı denemeleri boşuna harcanmaz,
 * doğrudan Katman 2'ye (bu dosya) geçilir — 429'da özellikle önemli, çünkü
 * zaten dolu bir kotanın üstüne hemen tekrar istek atmak durumu kötüleştirir
 * (2026-09-29, prod'da gözlemlendi).
 *
 * `/pesedilenler` ve `/pesdene` komutlarının manuel/deterministik backend'i
 * (bu motorun otomatik akışının parçası DEĞİL) `retry/RetryCommands.js`'te
 * ayrı tutulur.
 *
 * KASITLI OLARAK sürekli/periyodik bir trigger YOK — her trigger, bir mesajın
 * gerçekten başarısız kalmasının doğal bir sonucu olarak kurulur (kullanıcı
 * kararı).
 *
 * ============================================================================
 * ÖNEMLİ (2026-09-26) — AYRI BİR SEKME YOK, `telegram_queue` YENİDEN KULLANILIYOR
 * ============================================================================
 * Bu modül KENDİ sekmesini TUTMAZ. Retry bookkeeping'i (durum, deneme_asamasi,
 * sonraki_deneme_zamani, ilk_hata_zamani, son_deneme_zamani, son_hata_mesaji,
 * trigger_id) Queue.js'in zaten yönettiği, Fitness projesiyle PAYLAŞILAN
 * `telegram_queue` sekmesine E:K kolonları olarak eklendi (bkz. Queue.js >
 * QUEUE_HEADERS). Neden: kullanıcı kararı — "yeniden deneme için yeni sayfa
 * açma, mevcut kolon yapısının üzerine devam et."
 *
 * Bu, doPost'un HER metin mesajı için zaten çağırdığı `kuyrugaEkle_`'nin
 * (Queue.js) A:D'yi (update_id/chat_id/text/date) doldurduğu satırın AYNISINI
 * kullanır — LLM başarısız olduğunda `kuyrukSatiriniUpdateIdIleBul_` o
 * satırı update_id ile bulup E:K'yı doldurur (YENİ bir satır EKLEMEZ). Yani bu
 * sekmedeki satırların TÜMÜ retry-takip kaydı DEĞİLDİR: `durum` (E) boşsa o
 * mesaj normal işlendi ya da hiç LLM'e gitmedi (komut vb.); `durum`
 * BEKLIYOR/ISLENIYOR/PES_EDILDI/TAMAMLANDI'dan biriyse retry sistemine
 * girmiştir.
 *
 * **Silme kuralı (kullanıcı onayı, 2026-09-26):** Fitness günde 3 kez çalışıp
 * SADECE aynı günün mesajlarıyla ilgilendiği için RETRY_TEMIZLIK_ESIK_MS'i
 * aşan eski satırların silinmesi Fitness için sorun DEĞİL — bu yüzden
 * `eskiKayitlariTemizle_` `durum` boş (retry'a hiç girmemiş, ilk denemede
 * başarılı olmuş sıradan mesajlar) ya da `TAMAMLANDI` olan ve o eşiği aşan
 * satırları TAMAMEN SİLER (`sheet.deleteRow`). Tek istisna, HİÇBİR ZAMAN
 * silinmeyen iki durum:
 * `BEKLIYOR`/`ISLENIYOR` (hâlâ aktif iş) ve `PES_EDILDI` (kullanıcının haberdar
 * olması gereken, hiçbir yere kaydedilmemiş bir harcama) — bunlar yaşı ne
 * olursa olsun dokunulmaz, çünkü bir harcamayı sessizce unutmak/kaybetmek
 * kabul edilemez (kullanıcı kararı, Fitness'ten bağımsız).
 *
 * Temizlik (`bakimYap_` = FIFO temizlik + sahipsiz-trigger taraması, bkz.
 * aşağıdaki "2026-09-29 sahipsiz trigger temizliği" notu),
 * `zamanlanmisTekrarDenemeyiIsle`/`yenidenDenemeKuyruguEkle_`/
 * `pesEdildiKuyruguEkleVeBildir_`'e EK OLARAK `Queue.js > kuyrugaEkle_`'den
 * de (kilitli sarmalayıcı `bakimYapKilitli_` ile) çağrılır — bu fonksiyon HER
 * metin mesajında (LLM başarılı olsun olmasın) çalıştığı için, LLM hiç
 * hata vermese bile bakım düzenli fırsat bulur (sürekli bir trigger kurmadan,
 * 2026-09-26 kullanıcı kararı — aksi halde ilk temizlik ancak ilk LLM
 * hatasında tetiklenirdi).
 *
 * İlgili diğer dosyalar:
 *   - Queue.js: QUEUE_HEADERS/getOrCreateQueueSheet_/kuyrugaEkle_ (paylaşılan
 *     sekme ve A:D kontratı burada yönetilir)
 *   - LLM.js: llmIleTekrarDeneme_ / hataGeciciMi_ / mesajiIsleVeYanitla_
 *   - Telegram.js: sendTelegramMessage_
 *   - Main.js: doPost (geçici hatada yenidenDenemeKuyruguEkle_'yi, kalıcı
 *     hatada pesEdildiKuyruguEkleVeBildir_'i çağırır)
 *   - Expenses.js: getTargetSpreadsheet_ (Queue.js üzerinden dolaylı kullanılır)
 *   - retry/RetryCommands.js: `/pesedilenler`/`/pesdene` komut backend'i (bu
 *     dosyadaki sabit/yardımcıları kullanır)
 */

// ============================================================================
// Sabitler
// ============================================================================

const RETRY_DURUM = {
  BEKLIYOR: "BEKLIYOR", // bir trigger'ı var, vakti geldiğinde işlenecek
  ISLENIYOR: "ISLENIYOR", // şu an bir trigger tarafından işleniyor (çok kısa ömürlü ara durum)
  PES_EDILDI: "PES_EDILDI", // tüm aşamalar (ya da kalıcı hata) tükendi, retry durduruldu — ASLA SİLİNMEZ/TEMİZLENMEZ
  TAMAMLANDI: "TAMAMLANDI", // gecikmeli de olsa başarıyla işlendi — SADECE bu durumun E:K kolonları FIFO ile temizlenebilir
  SILINDI: "SILINDI", // kullanıcı /sonmesajisil ile elle iptal etti (2026-09-29) — TAMAMLANDI gibi FIFO ile temizlenebilir
};

/**
 * Aşama gecikmeleri (dakika). Aşama 1→10dk, 2→20dk, 3→40dk, 4→1sa, 5→1sa,
 * 6→2sa, 7→2sa, 8→4sa (2026-09-29: ilk üç aşama kısa/hızlı geçici blipleri
 * hızlıca çözmek için eklendi, kullanıcı kararı — "1-1-2-2-4" dizisinin
 * BAŞINA 10-20-40 dakika eklendi). 8. aşamanın (4 saatlik beklemenin)
 * sonundaki deneme de başarısız olursa PES EDİLİR — 9. bir eleman/aşama YOK
 * (bkz. sonAsamaMi_).
 */
const RETRY_BACKOFF_DAKIKA = [10, 20, 40, 60, 60, 120, 120, 240];

/** Trigger'ların çağıracağı, Apps Script'e kayıtlı giriş noktası fonksiyon adı. */
const RETRY_HANDLER_FN_ADI = "zamanlanmisTekrarDenemeyiIsle";

/** Oku/claim-et ve satır güncelleme kritik bölümleri için kilit bekleme süresi (ms). */
const RETRY_LOCK_TIMEOUT_MS = 10000;

/** Aynı anda birden fazla mesajın vadesi gelirse tek bir trigger ateşlenişinde işlenecek üst sınır. */
const RETRY_MAX_SATIR_PER_TETIKLEME = 5;

/**
 * Trigger'ın "yaklaşık" ateşlenme sapması ve `sonraki_deneme_zamani`'nın trigger
 * kurulduktan SONRA hesaplanması (birkaç saniye) yüzünden, trigger vadeden biraz
 * ÖNCE ateşlenirse satır "henüz vadesi gelmedi" sayılıp tek seferlik trigger boşa
 * harcanmasın diye vade kontrolüne eklenen tolerans (2026-10-05). En kısa aşama
 * 10 dk olduğundan erken işleme riski yok.
 */
const RETRY_VADE_TOLERANSI_MS = 90 * 1000;

/**
 * `sonraki_deneme_zamani` bu süreden fazla geçmiş ama hâlâ BEKLIYOR olan satır
 * "takılı" sayılır (trigger kaybolmuş/boşa harcanmış) ve PES_EDILDI'ye düşürülür
 * — böylece `/pesedilenler` ile görünür olur (2026-10-05, bkz. CLAUDE.md).
 */
const RETRY_TAKILI_ESIK_MS = 15 * 60 * 1000;

/** FIFO temizlik eşiği: `date`'ten itibaren bu süreyi aşan durum=""/TAMAMLANDI satırlar silinir. */
const RETRY_TEMIZLIK_ESIK_MS = 10 * 24 * 60 * 60 * 1000; // 10 gün

/**
 * Script kilidini bırakmadan ÖNCE bekleyen sheet yazımlarını commit eder
 * (`SpreadsheetApp.flush()`). Apps Script dokümantasyonu bunu açıkça gerektirir:
 * flush edilmezse kilidi hemen ardından alan başka bir execution (örn. sweep,
 * `sahipsizTetikleyicileriTemizle_`) satırdaki yeni `trigger_id`/`durum`
 * değerini henüz göremeyip eski veriyle karar verebilir (2026-10-05).
 * Tüm `releaseLock()` çağrıları bu yardımcı üzerinden yapılmalı.
 * @param {GoogleAppsScript.Lock.Lock} lock
 */
function kilidiBirak_(lock) {
  try {
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

// ============================================================================
// Kuyruk (telegram_queue, Queue.js) satır okuma/yazma yardımcıları
// ============================================================================

/**
 * Ham bir sheet satırını (QUEUE_HEADERS sırasıyla) okunabilir bir nesneye
 * çevirir. `satirNo` 1-indeksli gerçek sheet satır numarasıdır.
 * @param {number} satirNo
 * @param {Array<*>} row
 * @return {Object}
 */
function kuyrukSatirNesnesiOlustur_(satirNo, row) {
  return {
    satirNo: satirNo,
    updateId: row[0],
    chatId: row[1],
    text: row[2],
    mesajTarihi: row[3],
    durum: row[4],
    denemeAsamasi: row[5],
    sonrakiDenemeZamani: row[6],
    ilkHataZamani: row[7],
    sonDenemeZamani: row[8],
    sonHataMesaji: row[9],
    triggerId: row[10],
    messageId: row[11],
  };
}

/**
 * 2. satırdan itibaren tüm veri satırlarını okur. DİKKAT: bu, `telegram_queue`
 * PAYLAŞILAN sekmesindeki TÜM mesajları döndürür (retry-takipli olsun ya da
 * olmasın) — çağıranlar `durum` alanına göre filtrelemelidir.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {Array<Object>}
 */
function kuyrukTumSatirlariOku_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }
  var degerler = sheet.getRange(2, 1, lastRow - 1, QUEUE_HEADERS.length).getValues();
  return degerler.map(function (row, i) {
    return kuyrukSatirNesnesiOlustur_(i + 2, row);
  });
}

/**
 * `update_id`'ye sahip satırı bulur (en son eklenenden geriye doğru arar —
 * pratikte aranan satır genelde kuyrugaEkle_'nin AZ ÖNCE eklediği en son
 * satırdır). Bulunamazsa null döner (savunma amaçlı — normalde HER metin
 * mesajı için doPost bu satırı LLM'den ÖNCE zaten ekler).
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} updateId
 * @return {Object|null}
 */
function kuyrukSatiriniUpdateIdIleBul_(sheet, updateId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return null;
  }
  var idKolonu = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = idKolonu.length - 1; i >= 0; i--) {
    if (Number(idKolonu[i][0]) === Number(updateId)) {
      var satirNo = i + 2;
      var row = sheet.getRange(satirNo, 1, 1, QUEUE_HEADERS.length).getValues()[0];
      return kuyrukSatirNesnesiOlustur_(satirNo, row);
    }
  }
  return null;
}

/**
 * `row` nesnesini (kuyrukTumSatirlariOku_/kuyrukSatiriniUpdateIdIleBul_'dan)
 * `alanlar` ile birleştirip TEK bir setValues çağrısıyla ilgili satırı
 * günceller — sadece değişen alanları belirtmek yeterli, diğerleri `row`'daki
 * mevcut değerleriyle korunur (A:D dahil, yani Fitness'in verisi asla
 * bozulmaz çünkü zaten hep `row`'dan aynen geri yazılır).
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Object} row
 * @param {Object} alanlar Güncellenecek alanlar (kısmi, sadece E:K'dan olmalı).
 */
function satiriGuncelle_(sheet, row, alanlar) {
  var guncel = Object.assign({}, row, alanlar);
  sheet
    .getRange(row.satirNo, 1, 1, QUEUE_HEADERS.length)
    .setValues([
      [
        guncel.updateId,
        guncel.chatId,
        guncel.text,
        guncel.mesajTarihi,
        guncel.durum,
        guncel.denemeAsamasi,
        guncel.sonrakiDenemeZamani,
        guncel.ilkHataZamani,
        guncel.sonDenemeZamani,
        guncel.sonHataMesaji,
        guncel.triggerId,
        guncel.messageId,
      ],
    ]);
}

/**
 * Bir satırı PES_EDILDI durumuna işaretler (E:K'daki durum/hata alanları
 * güncellenir, trigger_id temizlenir — artık kurulu bir trigger'ı yok). Satır
 * ASLA silinmez/A:D'ye dokunulmaz.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Object} row
 * @param {string} hataMesaji
 * @param {Date} simdi
 */
function satiriPesEdildiOlarakIsaretle_(sheet, row, hataMesaji, simdi) {
  satiriGuncelle_(sheet, row, {
    durum: RETRY_DURUM.PES_EDILDI,
    sonHataMesaji: hataMesaji,
    sonDenemeZamani: simdi,
    triggerId: "",
  });
}

/**
 * `date` (mesajTarihi) sütunundan itibaren RETRY_TEMIZLIK_ESIK_MS'i aşan
 * satırları SİLER — hem `durum` boş (retry'a hiç girmemiş, ilk denemede
 * başarılı olmuş sıradan mesajlar) hem `TAMAMLANDI` (gecikmeli de olsa
 * başarıyla işlenmiş) satırlar bu kapsamdadır. Fitness günde 3 kez çalışıp
 * sadece aynı günün mesajlarıyla ilgilendiği için bu eşiği aşan geçmişi hiç
 * kullanmıyor — bu yüzden gerçek satır silme Fitness için güvenli (kullanıcı
 * onayı, 2026-09-26).
 *
 * `BEKLIYOR`/`ISLENIYOR` (hâlâ aktif iş) ve `PES_EDILDI` (kullanıcının
 * haberdar olması gereken, hiçbir yere kaydedilmemiş bir harcama) yaşı ne
 * olursa olsun ASLA silinmez — bir harcamayı sessizce unutmak/kaybetmek kabul
 * edilemez (kullanıcı kararı, bu iki durum için Fitness'ten bağımsız).
 *
 * Ayrı bir periyodik trigger YOK (kullanıcı kararı); bu fonksiyon `bakimYap_`
 * üzerinden retry'a özel üç giriş noktasının (yenidenDenemeKuyruguEkle_,
 * pesEdildiKuyruguEkleVeBildir_, zamanlanmisTekrarDenemeyiIsle) başında ucuz
 * bir ilk-adım olarak çağrılır VE (kilitli sarmalayıcısı `bakimYapKilitli_`
 * üzerinden) `Queue.js > kuyrugaEkle_`'den HER mesajda çağrılır — böylece
 * LLM hiç hata vermese bile temizlik düzenli fırsat bulur.
 *
 * Silme İŞLEMİ TOPLU yapılır (kullanıcı kararı, 2026-09-26): tek tek
 * `deleteRow` çağırmak yerine, silinecek satır numaraları ardışık aralıklara
 * gruplanıp her aralık için TEK bir `deleteRows(start, sayi)` çağrılır — FIFO
 * doğası nedeniyle eski satırlar tipik olarak sheet'in üst kısmında bitişik
 * durduğundan bu genelde N çağrı yerine 1-2 çağrıya iner (aktif/pes edilmiş
 * satırlar araya girip bitişikliği bölmediği sürece). Aralıklar EN ALTTAKİNDEN
 * (satır no'su en büyük) başlanarak silinir — aksi halde bir aralığı silmek,
 * henüz silinmemiş daha ÜSTTEKİ aralıkların satır numaralarını kaydırırdı.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Date} simdi
 */
function eskiKayitlariTemizle_(sheet, simdi) {
  var satirlar = kuyrukTumSatirlariOku_(sheet);
  var silinecekSatirNolari = satirlar
    .filter(function (row) {
      if (
        row.durum === RETRY_DURUM.BEKLIYOR ||
        row.durum === RETRY_DURUM.ISLENIYOR ||
        row.durum === RETRY_DURUM.PES_EDILDI
      ) {
        return false;
      }
      var mesajMs =
        row.mesajTarihi instanceof Date
          ? row.mesajTarihi.getTime()
          : new Date(row.mesajTarihi).getTime();
      return simdi.getTime() - mesajMs > RETRY_TEMIZLIK_ESIK_MS;
    })
    .map(function (row) {
      return row.satirNo;
    })
    .sort(function (a, b) {
      return a - b;
    });

  if (silinecekSatirNolari.length === 0) {
    return;
  }

  var araliklar = [];
  var baslangic = silinecekSatirNolari[0];
  var bitis = silinecekSatirNolari[0];
  for (var i = 1; i < silinecekSatirNolari.length; i++) {
    if (silinecekSatirNolari[i] === bitis + 1) {
      bitis = silinecekSatirNolari[i];
    } else {
      araliklar.push([baslangic, bitis]);
      baslangic = bitis = silinecekSatirNolari[i];
    }
  }
  araliklar.push([baslangic, bitis]);

  for (var j = araliklar.length - 1; j >= 0; j--) {
    var start = araliklar[j][0];
    var sayi = araliklar[j][1] - araliklar[j][0] + 1;
    log_("yenidenDeneme.fifo-temizlik", { baslangicSatir: start, satirSayisi: sayi });
    sheet.deleteRows(start, sayi);
  }
}

/**
 * `RETRY_HANDLER_FN_ADI`'na kayıtlı, ama HİÇBİR `BEKLIYOR` satırın
 * `trigger_id`'si tarafından referans verilmeyen (yani "sahipsiz") trigger'ları
 * bulup GERÇEKTEN siler (disable değil — bkz. dosya başı "2026-09-29 sahipsiz
 * trigger temizliği" notu). İki farklı kök sebebe karşı bir güvenlik ağıdır:
 *   (a) bir trigger kuruldu ama hemen ardından satıra yazılamadı (kilit zaman
 *       aşımı, Sheets hatası vb.) — bu durum artık `yenidenDenemeKuyruguEkle_`
 *       ve `zamanlanmisTekrarDenemeyiIsle`'daki compensating-delete ile ayrıca
 *       ÖNLENİYOR, ama bu sweep yine de ikinci bir güvenlik katmanı.
 *   (b) bir satır DIŞTAN (örn. Sheets'te elle) silindi/değiştirildi — o satıra
 *       ait trigger ateşlendiğinde artık hiçbir satır onu işaret etmiyor;
 *       eski davranışta bu trigger sonsuza dek listede "ölü" kalıyordu, bu
 *       fonksiyon onu bulup temizliyor.
 * Sadece kendi handler'ımıza (`RETRY_HANDLER_FN_ADI`) ait trigger'lara
 * dokunulur — projede başka bir fonksiyona ait trigger varsa hiç etkilenmez.
 *
 * Kabul edilen kalıntı risk (kullanıcı onayı, 2026-09-29): trigger kurulup
 * satıra YAZILMADAN önceki çok kısa pencerede BAŞKA bir execution bu sweep'i
 * çalıştırırsa, henüz hiçbir satıra bağlanmamış YENİ trigger'ı yanlışlıkla
 * "sahipsiz" sayıp silebilir. Kişisel/düşük hacimli kullanım için pratikte
 * ihmal edilebilir (iki execution'ın milisaniye hassasiyetinde çakışması
 * gerekir) — ek önlem alınmadı, kod sadeliği tercih edildi.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function sahipsizTetikleyicileriTemizle_(sheet) {
  var mesruIdler = kuyrukTumSatirlariOku_(sheet)
    .filter(function (row) {
      return row.durum === RETRY_DURUM.BEKLIYOR && row.triggerId;
    })
    .map(function (row) {
      return row.triggerId;
    });

  ScriptApp.getProjectTriggers()
    .filter(function (t) {
      return t.getHandlerFunction() === RETRY_HANDLER_FN_ADI;
    })
    .forEach(function (t) {
      var id = t.getUniqueId();
      if (mesruIdler.indexOf(id) === -1) {
        log_("yenidenDeneme.sahipsiz-trigger-temizlendi", { triggerId: id });
        ScriptApp.deleteTrigger(t);
      }
    });
}

/**
 * Fırsat buldukça yapılan bakım işlerinin tek giriş noktası:
 * `eskiKayitlariTemizle_` (FIFO) + `sahipsizTetikleyicileriTemizle_` (orphan
 * trigger sweep). İkisi de aynı mantıkla (ucuz, her fırsatta çalışan bir
 * ilk-adım) tasarlandığı için birlikte çağrılır.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Date} simdi
 */
function bakimYap_(sheet, simdi) {
  eskiKayitlariTemizle_(sheet, simdi);
  sahipsizTetikleyicileriTemizle_(sheet);
}

/**
 * `bakimYap_`'ı LockService ile korunan kısa bir kritik bölümde çalıştırır —
 * diğer giriş noktalarıyla (yenidenDenemeKuyruguEkle_,
 * pesEdildiKuyruguEkleVeBildir_, zamanlanmisTekrarDenemeyiIsle) AYNI kilidi
 * kullanır, böylece aynı anda iki bakımın çakışıp satır numaralarını/trigger
 * durumunu bozması önlenir. `Queue.js > kuyrugaEkle_` tarafından HER mesajda
 * çağrılır (LLM başarılı olsun olmasın) — LLM hiç hata vermese bile
 * hem FIFO temizliği hem sahipsiz-trigger taraması düzenli fırsat bulur,
 * sürekli bir trigger kurmadan (2026-09-26/2026-09-29 kullanıcı kararları).
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function bakimYapKilitli_(sheet) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(RETRY_LOCK_TIMEOUT_MS);
  } catch (err) {
    logHata_("yenidenDeneme.bakim-kilit-alinamadi", err);
    return;
  }
  var simdi = new Date();
  var takililar = [];
  try {
    bakimYap_(sheet, simdi);
    takililar = takiliBekleyenleriPesEt_(sheet, simdi);
  } finally {
    kilidiBirak_(lock);
  }
  // Bildirim (ağ çağrısı) kilit DIŞINDA.
  takiliBekleyenleriBildir_(sheet, takililar);
}

/**
 * Vadesi `RETRY_TAKILI_ESIK_MS`'den fazla geçmiş ama hâlâ BEKLIYOR olan
 * ("takılı": trigger'ı silinmiş/boşa harcanmış, hiç tetiklenmeyecek) satırları
 * PES_EDILDI'ye düşürür ve varsa ölü trigger'larını siler. Harcamanın sessizce
 * unutulmaması içindir: PES_EDILDI satırlar `/pesedilenler` ile görünür,
 * `/pesdene` ile tekrar denenebilir ve ASLA otomatik silinmez (2026-10-05).
 * Ağ çağrısı YAPMAZ — çağıran kilidi tutmalı, bildirimi kilit dışında yollamalı
 * (bkz. takiliBekleyenleriBildir_). Yeni trigger KURMAZ.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Date} simdi
 * @return {Array<Object>} PES_EDILDI'ye düşürülen satırlar.
 */
function takiliBekleyenleriPesEt_(sheet, simdi) {
  var donusenler = [];
  kuyrukTumSatirlariOku_(sheet).forEach(function (row) {
    if (row.durum !== RETRY_DURUM.BEKLIYOR) {
      return;
    }
    var sonrakiMs =
      row.sonrakiDenemeZamani instanceof Date
        ? row.sonrakiDenemeZamani.getTime()
        : new Date(row.sonrakiDenemeZamani).getTime();
    if (isNaN(sonrakiMs) || sonrakiMs + RETRY_TAKILI_ESIK_MS >= simdi.getTime()) {
      return;
    }
    try {
      zamanliTetikleyiciSil_(row.triggerId);
    } catch (err) {
      logHata_("yenidenDeneme.takili-trigger-silinemedi", err);
    }
    var hata = "Otomatik tekrar deneme zamanında tetiklenmedi.";
    satiriPesEdildiOlarakIsaretle_(sheet, row, hata, simdi);
    log_("yenidenDeneme.takili-pes-edildi", {
      updateId: row.updateId,
      asama: row.denemeAsamasi,
    });
    donusenler.push(Object.assign({}, row, { sonHataMesaji: hata }));
  });
  return donusenler;
}

/**
 * `takiliBekleyenleriPesEt_`'in döndürdüğü her satır için kullanıcıya mevcut
 * PES_EDILDI bildirimini gönderir. Hata ana akışı bozmaz (sadece loglanır).
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Array<Object>} satirlar
 */
function takiliBekleyenleriBildir_(sheet, satirlar) {
  satirlar.forEach(function (row) {
    try {
      pesEdildiBildirimGonder_(sheet, row.chatId, row.text, row.sonHataMesaji, row.satirNo);
    } catch (err) {
      logHata_("yenidenDeneme.takili-bildirim-HATA", err);
    }
  });
}

/**
 * Komutlardan (`/pesedilenler`, `/pesdene`) çağrılan kilitli sarmalayıcı:
 * takılı BEKLIYOR satırları PES_EDILDI'ye düşürür (bildirim göndermez —
 * komutun kendi çıktısı zaten listeler). Kilit alınamazsa sessizce atlanır.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function takiliBekleyenleriKilitliPesEt_(sheet) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(RETRY_LOCK_TIMEOUT_MS);
  } catch (err) {
    logHata_("yenidenDeneme.takili-kilit-alinamadi", err);
    return;
  }
  try {
    takiliBekleyenleriPesEt_(sheet, new Date());
  } finally {
    kilidiBirak_(lock);
  }
}

// ============================================================================
// Aşama/backoff hesaplama (saf fonksiyonlar)
// ============================================================================

/**
 * `asamaNo`ya (1-indeksli) karşılık gelen bekleme süresini (dakika) döndürür.
 * @param {number} asamaNo
 * @return {number}
 */
function sonrakiGecikmeDakika_(asamaNo) {
  var index = Math.min(asamaNo, RETRY_BACKOFF_DAKIKA.length) - 1;
  return RETRY_BACKOFF_DAKIKA[index];
}

/**
 * `asamaNo` son aşama (RETRY_BACKOFF_DAKIKA'nın son elemanı, 240dk/4sa) mı?
 * True ise bu aşamanın başarısızlığı bir sonraki trigger'ı DEĞİL, PES
 * ETMEyi tetikler.
 * @param {number} asamaNo
 * @return {boolean}
 */
function sonAsamaMi_(asamaNo) {
  return asamaNo >= RETRY_BACKOFF_DAKIKA.length;
}

/**
 * Bir süreyi (ms) okunabilir Türkçe metne çevirir — 60 dakikadan azsa
 * dakika, değilse saat cinsinden (2026-09-29: RETRY_BACKOFF_DAKIKA artık
 * dakika mertebesinde aşamalar da içerdiği için, her yerde "saat"e
 * yuvarlamak yanıltıcı olurdu, örn. 10 dakika sonra çözülen bir mesaj
 * yanlışlıkla "1 saat önce" gösterilmemeli).
 * @param {number} ms
 * @return {string} Örn. "10 dakika" ya da "2 saat".
 */
function gecenSureyiIfadeEt_(ms) {
  var dakika = Math.max(1, Math.round(ms / 60000));
  if (dakika < 60) {
    return dakika + " dakika";
  }
  return Math.round(dakika / 60) + " saat";
}

// ============================================================================
// Trigger yönetimi
// ============================================================================

/**
 * `gecikmeDakika` dakika sonrasına tek seferlik bir Apps Script trigger kurar.
 * ⚠️ Tek seferlik (`after`) trigger'lar ateşlendikten sonra KENDİLİĞİNDEN
 * SİLİNMEZ — kurulumdan sonraki her aşama geçişinde eskisi mutlaka
 * zamanliTetikleyiciSil_ ile temizlenmeli, aksi halde proje trigger kotası
 * (~20) sessizce tükenir.
 * @param {number} gecikmeDakika
 * @return {string} Yeni trigger'ın uniqueId'si.
 */
function zamanliTetikleyiciKur_(gecikmeDakika) {
  var trigger = ScriptApp.newTrigger(RETRY_HANDLER_FN_ADI)
    .timeBased()
    .after(gecikmeDakika * 60 * 1000)
    .create();
  return trigger.getUniqueId();
}

/**
 * `triggerId`ye sahip trigger'ı bulup siler. Bulunamazsa (zaten silinmiş/hiç
 * kurulmamış) sessizce no-op.
 * @param {string} triggerId
 */
function zamanliTetikleyiciSil_(triggerId) {
  if (!triggerId) {
    return;
  }
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getUniqueId() === triggerId) {
      ScriptApp.deleteTrigger(triggers[i]);
      return;
    }
  }
  log_("yenidenDeneme.trigger-bulunamadi", triggerId);
}

// ============================================================================
// Giriş noktaları (Main.js > doPost tarafından çağrılır)
// ============================================================================

/**
 * Katman 1 (llmIleTekrarDeneme_) GEÇİCİ bir hatayla tükendiğinde
 * `doPost` tarafından çağrılır. `kuyrugaEkle_`'nin (Queue.js) bu `update_id`
 * için AZ ÖNCE (aynı doPost execution'ında, LLM çağrısından ÖNCE) eklediği
 * satırı bulup E:K kolonlarını doldurur — YENİ bir satır EKLEMEZ. O satır
 * (savunma amaçlı, normalde olmaması gereken bir durumda) bulunamazsa mesajı
 * kaybetmemek için tam bir satır olarak eklenir. 10 dakika sonrasına ilk
 * trigger'ı kurar.
 *
 * Trigger kurulumu (ScriptApp.newTrigger) BİLEREK kilit/sheet işlemlerinden
 * ÖNCE ve ayrı denenir: başarısız olursa (örn. bu proje ilk kez trigger
 * oluşturmayı deniyorsa gereken `script.scriptapp` yetkisi henüz Web App
 * deployment'ının yetkilendirme onayına dahil edilmemiş olabilir — kod
 * push/deploy etmek bu onayı YENİLEMEZ, sahibinin editörden herhangi bir
 * fonksiyonu bir kez elle çalıştırıp izin ekranını onaylaması gerekir) mesaj
 * asla sessizce kaybolmaz: `zamanlanmisTekrarDenemeyiIsle`'daki AYNI "trigger
 * kurulamadı → PES ET" deseniyle doğrudan `pesEdildiKuyruguEkleVeBildir_`'e
 * devredilir (kullanıcı bildirim alır, satır PES_EDILDI'ye yazılır).
 * @param {number} updateId
 * @param {number|string} chatId
 * @param {string} text
 * @param {number} mesajTarihiSaniye Telegram update.message.date (Unix saniye).
 * @param {string} hataMesaji Kullanıcıya gösterilecek, temizlenmiş metin
 *   (bkz. LLM.js > kullaniciyaGosterilecekHataMetni_) — çağıran taraf
 *   (Main.js > doPost) ham hatayı buraya ASLA geçirmemeli.
 * @param {number} [messageId] Telegram update.message.message_id — savunma
 *   amaçlı fallback satırının L kolonuna yazılması için.
 */
function yenidenDenemeKuyruguEkle_(
  updateId,
  chatId,
  text,
  mesajTarihiSaniye,
  hataMesaji,
  messageId,
) {
  var ilkAsama = 1;
  var gecikmeDakika = sonrakiGecikmeDakika_(ilkAsama);
  var triggerId;
  try {
    triggerId = zamanliTetikleyiciKur_(gecikmeDakika);
  } catch (triggerErr) {
    logHata_("yenidenDeneme.trigger-kurulamadi-ILK-DENEME", triggerErr);
    pesEdildiKuyruguEkleVeBildir_(
      updateId,
      chatId,
      text,
      mesajTarihiSaniye,
      "Trigger kurulamadı: " + triggerErr.message,
      messageId,
    );
    return;
  }

  try {
    var lock = LockService.getScriptLock();
    lock.waitLock(RETRY_LOCK_TIMEOUT_MS);
    try {
      var sheet = getOrCreateQueueSheet_();
      var simdi = new Date();
      bakimYap_(sheet, simdi);

      var sonrakiDenemeZamani = new Date(simdi.getTime() + gecikmeDakika * 60 * 1000);

      var alanlar = {
        durum: RETRY_DURUM.BEKLIYOR,
        denemeAsamasi: ilkAsama,
        sonrakiDenemeZamani: sonrakiDenemeZamani,
        ilkHataZamani: simdi,
        sonDenemeZamani: simdi,
        sonHataMesaji: hataMesaji,
        triggerId: triggerId,
      };

      var mevcutSatir = kuyrukSatiriniUpdateIdIleBul_(sheet, updateId);
      if (mevcutSatir) {
        satiriGuncelle_(sheet, mevcutSatir, alanlar);
      } else {
        logHata_(
          "yenidenDeneme.kuyruk-satiri-bulunamadi",
          "update_id=" + updateId + " için kuyrugaEkle_ satırı yok, yeni satır ekleniyor.",
        );
        sheet.appendRow([
          updateId,
          chatId,
          text,
          new Date(mesajTarihiSaniye * 1000),
          alanlar.durum,
          alanlar.denemeAsamasi,
          alanlar.sonrakiDenemeZamani,
          alanlar.ilkHataZamani,
          alanlar.sonDenemeZamani,
          alanlar.sonHataMesaji,
          alanlar.triggerId,
          messageId,
        ]);
      }
      log_("yenidenDeneme.kuyruklandi", {
        updateId: updateId,
        triggerId: triggerId,
        sonrakiDenemeZamani: sonrakiDenemeZamani,
      });
    } finally {
      kilidiBirak_(lock);
    }
  } catch (yaziHatasi) {
    // Trigger BAŞARIYLA kuruldu ama satıra yazılamadı (kilit zaman aşımı,
    // Sheets hatası vb.) — bu trigger artık hiçbir satırın trigger_id'siyle
    // eşleşmeyecek, yani sahipsizTetikleyicileriTemizle_ dahi onu asla
    // "meşru" saymayacak. Bunu kotayı sessizce tüketen bir sahipsiz trigger'a
    // dönüştürmemek için burada HEMEN geri siliyoruz (compensating delete,
    // 2026-09-29) — sonra hata olduğu gibi doPost'un kuyruklama-hatası
    // fallback'ine yükseliyor.
    logHata_("yenidenDeneme.satir-yazilamadi-trigger-geri-alindi", yaziHatasi);
    zamanliTetikleyiciSil_(triggerId);
    throw yaziHatasi;
  }
}

/**
 * Katman 1 KALICI bir hatayla (400/401/403/404) başarısız olduğunda `doPost`
 * tarafından çağrılır: hiç retry denenmeden, `kuyrugaEkle_`'nin az önce
 * eklediği AYNI satır doğrudan PES_EDILDI olarak işaretlenir (bulunamazsa
 * savunma amaçlı yeni satır eklenir) ve kullanıcıya bildirim gönderilir.
 * @param {number} updateId
 * @param {number|string} chatId
 * @param {string} text
 * @param {number} mesajTarihiSaniye
 * @param {string} hataMesaji Kullanıcıya gösterilecek, temizlenmiş metin
 *   (bkz. LLM.js > kullaniciyaGosterilecekHataMetni_).
 * @param {number} [messageId] Telegram update.message.message_id — savunma
 *   amaçlı fallback satırının L kolonuna yazılması için.
 */
function pesEdildiKuyruguEkleVeBildir_(
  updateId,
  chatId,
  text,
  mesajTarihiSaniye,
  hataMesaji,
  messageId,
) {
  var lock = LockService.getScriptLock();
  lock.waitLock(RETRY_LOCK_TIMEOUT_MS);
  var sheet, satirNo;
  try {
    sheet = getOrCreateQueueSheet_();
    var simdi = new Date();
    bakimYap_(sheet, simdi);

    var alanlar = {
      durum: RETRY_DURUM.PES_EDILDI,
      denemeAsamasi: 0,
      sonrakiDenemeZamani: "",
      ilkHataZamani: simdi,
      sonDenemeZamani: simdi,
      sonHataMesaji: hataMesaji,
      triggerId: "",
    };

    var mevcutSatir = kuyrukSatiriniUpdateIdIleBul_(sheet, updateId);
    if (mevcutSatir) {
      satiriGuncelle_(sheet, mevcutSatir, alanlar);
      satirNo = mevcutSatir.satirNo;
    } else {
      logHata_(
        "yenidenDeneme.kuyruk-satiri-bulunamadi",
        "update_id=" + updateId + " için kuyrugaEkle_ satırı yok, yeni satır ekleniyor.",
      );
      sheet.appendRow([
        updateId,
        chatId,
        text,
        new Date(mesajTarihiSaniye * 1000),
        alanlar.durum,
        alanlar.denemeAsamasi,
        alanlar.sonrakiDenemeZamani,
        alanlar.ilkHataZamani,
        alanlar.sonDenemeZamani,
        alanlar.sonHataMesaji,
        alanlar.triggerId,
        messageId,
      ]);
      satirNo = sheet.getLastRow();
    }
    log_("yenidenDeneme.kalici-hata-kuyruklandi", { updateId: updateId, satirNo: satirNo });
  } finally {
    kilidiBirak_(lock);
  }

  // Telegram gönderimi kilit DIŞINDA yapılır (ağ çağrısı kilit altında tutulmaz).
  pesEdildiBildirimGonder_(sheet, chatId, text, hataMesaji, satirNo);
}

/**
 * Bir mesaj PES_EDILDI olduğunda kullanıcıya (a) o mesaja özel bir bildirim,
 * (b) kuyrukta biriken DİĞER PES_EDILDI satırlarının toplu bir özetini
 * (varsa) gönderir. `buSatirNo`, "diğer" filtresinde bu satırı dışlamak için
 * kullanılır (metin eşleşmesi yerine satır numarası — daha güvenilir).
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number|string} chatId
 * @param {string} text
 * @param {string} hataMesaji
 * @param {number} buSatirNo
 */
function pesEdildiBildirimGonder_(sheet, chatId, text, hataMesaji, buSatirNo) {
  sendTelegramMessage_(
    chatId,
    "❌ Bu mesaj işlenemedi, otomatik tekrar deneme durduruldu: " +
      hataMesaji +
      "\n\nOrijinal mesajınız: " +
      telegramAlinti_(text),
    "Markdown",
  );

  var digerPesEdilenler = kuyrukTumSatirlariOku_(sheet).filter(function (row) {
    return row.durum === RETRY_DURUM.PES_EDILDI && row.satirNo !== buSatirNo;
  });

  if (digerPesEdilenler.length > 0) {
    var liste = digerPesEdilenler
      .map(function (row, i) {
        return i + 1 + ". " + telegramAlinti_(row.text);
      })
      .join("\n");
    sendTelegramMessage_(
      chatId,
      "📋 Ayrıca hâlâ işlenmemiş " +
        digerPesEdilenler.length +
        " eski mesaj var:\n" +
        liste,
      "Markdown",
    );
  }
}

// ============================================================================
// Trigger giriş noktası (Apps Script tarafından çağrılır — doPost gibi, isimde alt çizgi yok)
// ============================================================================

/**
 * Bir mesajın kendi aşamasına özel tek seferlik trigger'ı ateşlendiğinde Apps
 * Script tarafından çağrılır. Vadesi gelmiş (durum=BEKLIYOR ve
 * sonraki_deneme_zamani geçmiş) satırları bulup işler:
 *   - Başarılı → "gecikmeli işlendi" notuyla Telegram'a gönderilir, satır
 *     SİLİNMEZ, durum=TAMAMLANDI'ya geçer.
 *   - Geçici hata + son aşama DEĞİLSE → bir sonraki aşama için yeni trigger kurulur.
 *   - Geçici hata + SON aşama (RETRY_BACKOFF_DAKIKA'nın sonu, 240dk/4sa) ise
 *     → PES EDİLİR, 9. trigger KURULMAZ.
 *   - Kalıcı hata (nadiren, savunma amaçlı) → doğrudan PES EDİLİR.
 *   - Yeni trigger kurulamazsa (örn. kota doldu) → sessizce kaybetmek yerine PES EDİLİR.
 */
function zamanlanmisTekrarDenemeyiIsle() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(RETRY_LOCK_TIMEOUT_MS);
  } catch (err) {
    logHata_("yenidenDeneme.kilit-alinamadi", err);
    return;
  }

  var sheet, vadesiGelenler, takililar;
  try {
    sheet = getOrCreateQueueSheet_();
    var simdiClaim = new Date();
    bakimYap_(sheet, simdiClaim);
    takililar = takiliBekleyenleriPesEt_(sheet, simdiClaim);

    var tumSatirlar = kuyrukTumSatirlariOku_(sheet);
    vadesiGelenler = tumSatirlar
      .filter(function (row) {
        if (row.durum !== RETRY_DURUM.BEKLIYOR) {
          return false;
        }
        var sonrakiMs =
          row.sonrakiDenemeZamani instanceof Date
            ? row.sonrakiDenemeZamani.getTime()
            : new Date(row.sonrakiDenemeZamani).getTime();
        return sonrakiMs <= simdiClaim.getTime() + RETRY_VADE_TOLERANSI_MS;
      })
      .slice(0, RETRY_MAX_SATIR_PER_TETIKLEME)
      .sort(function (a, b) {
        return b.satirNo - a.satirNo; // azalan sırayla işle: sonradan silme index kaydırmaz
      });

    // Claim: bu satırları tetikleyen (artık ateşlenmiş) trigger'ları temizle,
    // durumu ISLENIYOR yap — LLM çağrısı kilit DIŞINDA yapılacak.
    vadesiGelenler.forEach(function (row) {
      zamanliTetikleyiciSil_(row.triggerId);
      satiriGuncelle_(sheet, row, {
        durum: RETRY_DURUM.ISLENIYOR,
        sonDenemeZamani: simdiClaim,
      });
      row.durum = RETRY_DURUM.ISLENIYOR;
    });

    log_("yenidenDeneme.tarama", { vadesiGelen: vadesiGelenler.length });
  } finally {
    kilidiBirak_(lock);
  }

  takiliBekleyenleriBildir_(sheet, takililar);

  vadesiGelenler.forEach(function (row) {
    var simdi = new Date();
    try {
      var mesajZamaniSaniye = Math.floor(row.mesajTarihi.getTime() / 1000);
      var cevapMetni = mesajiIsleVeYanitla_(row.text, mesajZamaniSaniye);
      var neKadarOnce = gecenSureyiIfadeEt_(
        simdi.getTime() - row.mesajTarihi.getTime(),
      );
      sendTelegramMessage_(
        row.chatId,
        "⏳ Gecikmeli işlendi (" +
          neKadarOnce +
          " önce gönderilmişti):\n\n" +
          cevapMetni,
      );
      // Satır burada SİLİNMEZ — TAMAMLANDI olarak işaretlenir, ancak FIFO
      // temizliği (eskiKayitlariTemizle_, eşik: RETRY_TEMIZLIK_ESIK_MS) bu
      // durumdaki satırı süresi dolunca tamamen siler.
      satiriGuncelle_(sheet, row, {
        durum: RETRY_DURUM.TAMAMLANDI,
        sonHataMesaji: "",
        sonDenemeZamani: simdi,
        triggerId: "",
      });
      log_("yenidenDeneme.basarili", {
        updateId: row.updateId,
        asama: row.denemeAsamasi,
      });
      return;
    } catch (err) {
      // Sınıflandırılmamış/beklenmeyen bir hata da (hataGeciciMi_ default: geçici)
      // "reschedule ya da açıkça pes et" yoluna düşer — asla sessizce silinmez.
      var temizHataMetni = kullaniciyaGosterilecekHataMetni_(err);
      if (!hataGeciciMi_(err)) {
        satiriPesEdildiOlarakIsaretle_(sheet, row, temizHataMetni, simdi);
        pesEdildiBildirimGonder_(
          sheet,
          row.chatId,
          row.text,
          temizHataMetni,
          row.satirNo,
        );
        return;
      }

      if (sonAsamaMi_(row.denemeAsamasi)) {
        satiriPesEdildiOlarakIsaretle_(sheet, row, temizHataMetni, simdi);
        pesEdildiBildirimGonder_(
          sheet,
          row.chatId,
          row.text,
          temizHataMetni,
          row.satirNo,
        );
        return;
      }

      var yeniAsama = row.denemeAsamasi + 1;
      var yeniTriggerId;
      try {
        var gecikmeDakika = sonrakiGecikmeDakika_(yeniAsama);
        yeniTriggerId = zamanliTetikleyiciKur_(gecikmeDakika);
        var yeniSonrakiZaman = new Date(
          simdi.getTime() + gecikmeDakika * 60 * 1000,
        );
        satiriGuncelle_(sheet, row, {
          durum: RETRY_DURUM.BEKLIYOR,
          denemeAsamasi: yeniAsama,
          sonrakiDenemeZamani: yeniSonrakiZaman,
          sonHataMesaji: temizHataMetni,
          sonDenemeZamani: simdi,
          triggerId: yeniTriggerId,
        });
        log_("yenidenDeneme.sonraki-asama", {
          updateId: row.updateId,
          asama: yeniAsama,
          gecikmeDakika: gecikmeDakika,
        });
      } catch (triggerErr) {
        if (yeniTriggerId) {
          // Trigger BAŞARIYLA kuruldu ama satır güncellenemedi — bu trigger
          // artık hiçbir satırın trigger_id'siyle eşleşmeyecek (satır PES_EDILDI'ye
          // düşecek, trigger_id'si boşaltılacak). Sahipsiz kalmasın diye
          // hemen geri siliyoruz (compensating delete, 2026-09-29).
          zamanliTetikleyiciSil_(yeniTriggerId);
        }
        logHata_("yenidenDeneme.trigger-kurulamadi-KRITIK", triggerErr);
        var triggerHataMesaji = "Trigger kurulamadı: " + triggerErr.message;
        satiriPesEdildiOlarakIsaretle_(sheet, row, triggerHataMesaji, simdi);
        pesEdildiBildirimGonder_(
          sheet,
          row.chatId,
          row.text,
          triggerHataMesaji,
          row.satirNo,
        );
      }
    }
  });
}
