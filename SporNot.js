/**
 * ============================================================================
 * Gider İşleyici — Spor Notu Bekleme Modu
 * ============================================================================
 * Çıplak `/spornotu` gönderilince bot hemen "bir sonraki mesajın spor notu
 * olarak kaydedilecek" der ve bu dosyadaki BEKLEME durumuna girer. Beklemedeyken
 * gelen sonraki düz mesaj (komut aranmadan) `/spornotu <metin>` olarak Fitness
 * kuyruğuna yazılır (bkz. Main.js > doPost); Fitness bunu günde 3 çalışmasında
 * AI ile gün tespit edip o günün notuna kaydeder (Fitness/sporKomutlari.js).
 * Durum burada tutulur çünkü anlık cevap verebilen tek taraf bu projedir.
 *
 * Bekleme şu üç yoldan biriyle biter: not gelmesi, `/sporiptal`, ya da
 * SPOR_NOT_BEKLEME_ZAMAN_ASIMI_MS dolması (bot "süre doldu" bildirimi yollar).
 *
 * ⚠️ TRIGGER GÜVENLİĞİ: süre dolma bildirimi tek seferlik bir `after()` trigger'ı
 * ile yapılır (periyodik trigger yok — projenin genel kararı). Apps Script tek
 * seferlik trigger'ları ateşlendikten sonra KENDİLİĞİNDEN silmez; sızıntı ve
 * 20-trigger kotası riskine karşı:
 *   - Trigger id'si SAKLANMAZ; temizlik handler adına göre TÜM trigger'ları
 *     siler (sahipsiz trigger kalamaz, en fazla 1 canlı).
 *   - Handler ilk iş olarak kendi trigger'ını siler (hata alsa da sızmaz).
 *   - Trigger kurulamazsa bekleme yine başlar; bildirim bir sonraki mesajda
 *     tembel (lazy) yoldan gelir. Süre kontrolü HER ZAMAN zaman damgasıyla
 *     yapılır, trigger'ın ateşlenmesine güvenilmez.
 *   - "Süresi doldu mu → temizle" işlemi kilit altında atomiktir; trigger ve
 *     tembel yol aynı anda çalışsa bile bildirim bir kez gider.
 * Retry sisteminin sahipsiz-trigger taraması yalnız RETRY_HANDLER_FN_ADI'ye
 * baktığı için bu trigger'a dokunmaz.
 */

const SPOR_NOT_BEKLEME_KEY = "SPOR_NOT_BEKLEME";
const SPOR_NOT_BEKLEME_ZAMAN_ASIMI_MS = 10 * 60 * 1000;
const SPOR_NOT_BEKLEME_HANDLER_FN_ADI = "sporNotBeklemeSuresiDoldu";
// Trigger'ın zamanından biraz önce ateşlenmesi durumuna tolerans.
const SPOR_NOT_BEKLEME_TETIKLEYICI_TOLERANS_MS = 60 * 1000;
const SPOR_NOT_LOCK_TIMEOUT_MS = 10000;

const SPOR_NOT_BEKLEME_BASLADI_METNI =
  "📝 Bir sonraki mesajın spor notu olarak kaydedilecek.\n" +
  "İptal etmek için: /sporiptal\n" +
  "(10 dakika içinde not gelmezse bekleme kendiliğinden biter.)";
const SPOR_NOT_ALINDI_METNI =
  "📝 Spor notu alındı. Bir sonraki spor değerlendirmesinde işlenecek.";
const SPOR_NOT_BEKLEME_IPTAL_METNI =
  "❎ Spor notu bekleme iptal edildi, normal moda dönüldü.";
const SPOR_NOT_BEKLEME_YOK_METNI = "Bekleyen bir spor notu yok.";
const SPOR_NOT_BEKLEME_SURE_DOLDU_METNI =
  "⏱️ Spor notu bekleme süresi doldu, normal moda dönüldü.";

/** Bekleme kaydını döner ({baslangicMs, chatId}) ya da yoksa/bozuksa null. */
function sporNotBeklemeDurumu_() {
  var ham = PropertiesService.getScriptProperties().getProperty(
    SPOR_NOT_BEKLEME_KEY,
  );
  if (!ham) return null;
  try {
    var durum = JSON.parse(ham);
    return durum && isFinite(durum.baslangicMs) ? durum : null;
  } catch (err) {
    return null;
  }
}

/** Bekleme var VE süresi dolmamış mı? (Yan etkisiz.) */
function sporNotBeklemeAktifMi_() {
  var durum = sporNotBeklemeDurumu_();
  return (
    !!durum && Date.now() - durum.baslangicMs < SPOR_NOT_BEKLEME_ZAMAN_ASIMI_MS
  );
}

/**
 * Handler adı SPOR_NOT_BEKLEME_HANDLER_FN_ADI olan trigger'ları siler.
 * @param {string} [sadeceUid] Verilirse yalnız bu trigger silinir.
 */
function sporNotBeklemeTetikleyicileriniSil_(sadeceUid) {
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() !== SPOR_NOT_BEKLEME_HANDLER_FN_ADI) return;
      if (sadeceUid && t.getUniqueId() !== sadeceUid) return;
      ScriptApp.deleteTrigger(t);
    });
  } catch (err) {
    logHata_("sporNot.trigger-silme", err);
  }
}

/** Bekleme modunu başlatır (eski bekleme/trigger varsa önce temizlenir). */
function sporNotBeklemeBaslat_(chatId) {
  sporNotBeklemeTetikleyicileriniSil_();
  PropertiesService.getScriptProperties().setProperty(
    SPOR_NOT_BEKLEME_KEY,
    JSON.stringify({ baslangicMs: Date.now(), chatId: chatId }),
  );
  try {
    ScriptApp.newTrigger(SPOR_NOT_BEKLEME_HANDLER_FN_ADI)
      .timeBased()
      .after(SPOR_NOT_BEKLEME_ZAMAN_ASIMI_MS)
      .create();
  } catch (err) {
    // Bekleme yine çalışır; süre dolma bildirimi tembel yola (sonraki mesaj) düşer.
    logHata_("sporNot.trigger-kurulamadi", err);
  }
}

/** Beklemeyi ve trigger'ını siler (not geldi / iptal). */
function sporNotBeklemeTemizle_() {
  PropertiesService.getScriptProperties().deleteProperty(SPOR_NOT_BEKLEME_KEY);
  sporNotBeklemeTetikleyicileriniSil_();
}

/**
 * Bekleme var ve SÜRESİ DOLMUŞSA kilit altında temizler ve eski kaydı döner;
 * aksi halde null. Yalnız non-null alan taraf "süre doldu" bildirimini yollar
 * (trigger ve tembel yol yarışsa bile bildirim bir kez gider).
 * @param {number} [toleransMs] Erken ateşlenen trigger için süre toleransı.
 */
function sporNotBeklemeSuresiniDoldur_(toleransMs) {
  // Her mesajda çağrıldığı için kilit almadan önce ucuz ön kontrol: bekleme
  // yoksa (çoğu mesaj) kilit maliyeti ödenmez.
  if (!sporNotBeklemeDurumu_()) return null;

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(SPOR_NOT_LOCK_TIMEOUT_MS);
  } catch (err) {
    logHata_("sporNot.kilit-alinamadi", err);
    return null;
  }
  try {
    var durum = sporNotBeklemeDurumu_();
    if (!durum) return null;
    var esik = SPOR_NOT_BEKLEME_ZAMAN_ASIMI_MS - (toleransMs || 0);
    if (Date.now() - durum.baslangicMs < esik) return null;
    PropertiesService.getScriptProperties().deleteProperty(
      SPOR_NOT_BEKLEME_KEY,
    );
    return durum;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Süre dolma trigger'ının handler'ı. İlk iş kendi trigger'ını siler, sonra
 * (hâlâ süresi dolmuş bir bekleme varsa) bildirimi yollar.
 * @param {GoogleAppsScript.Events.TimeDriven} e
 */
function sporNotBeklemeSuresiDoldu(e) {
  sporNotBeklemeTetikleyicileriniSil_(e && e.triggerUid);
  try {
    var durum = sporNotBeklemeSuresiniDoldur_(
      SPOR_NOT_BEKLEME_TETIKLEYICI_TOLERANS_MS,
    );
    var chatId = durum && (durum.chatId || CONFIG.chatId);
    if (chatId) {
      sendTelegramMessage_(chatId, SPOR_NOT_BEKLEME_SURE_DOLDU_METNI);
    }
  } catch (err) {
    logHata_("sporNot.sure-doldu-handler", err);
  }
}
