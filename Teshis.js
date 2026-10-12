/**
 * ============================================================================
 * Gider İşleyici — Ajan İçin SALT-OKUNUR Teşhis Fonksiyonları
 * ============================================================================
 * Bir agentic oturumun, sistemdeki sorunları kendi başına tespit edebilmesi için:
 * kuyruk mesajlarını, retry durumunu, kurulu trigger'ları ve bunlar arasındaki
 * tutarsızlıkları OKUR. Hiçbir şeyi değiştirmez.
 *
 * Çalıştırma: Apps Script editöründen ya da `clasp run-function <ad> [-p '[args]']`
 * (bkz. CLAUDE.md > "Ajan teşhis fonksiyonları"). Yalnızca adı `_` ile BİTMEYEN
 * (public) fonksiyonlar uzaktan çalıştırılabilir; iç yardımcılar `_` ile biter.
 *
 * ⚠️ DEĞİŞMEZ KURALLAR (bu dosyada ihlal edilmemeli):
 *   - Bu dosyada YALNIZCA okuma yapılır: sheet'ten değer okuma, Script Property
 *     OKUMA, trigger listesini OKUMA, Telegram `getWebhookInfo` (GET).
 *     Sheet/Property/trigger yazma-silme-ekleme API'leri, mesaj gönderme ve
 *     kilit alma BURADA KULLANILMAZ (yasak jetonlar test/teshis kontrolüyle
 *     taranır; bkz. CLAUDE.md).
 *   - Kuyruk sekmesine `getOrCreateQueueSheet_` ile DEĞİL, yalnızca
 *     `getSheetByName` ile erişilir (o fonksiyon sekmeyi oluşturup genişletebilir).
 *   - Çıktıya sır yazılmaz: bot token'ı, LLM API anahtarları ve Script Property
 *     DEĞERLERİ yok (yalnızca "tanımlı mı" bayrağı); mesaj metinleri kısaltılır.
 *   - Adı `teshis` ile başlamayan hiçbir fonksiyon ajan tarafından uzaktan
 *     çalıştırılmaz.
 *   - Loglama `console.log` ile yapılır (Logger kullanılmaz).
 */

/** Rapordaki mesaj metinlerinin üst uzunluğu (karakter). */
const TESHIS_METIN_MAX = 100;

/** `teshisMesajlar`/`teshisHarcamalar` için varsayılan ve üst satır sayısı. */
const TESHIS_VARSAYILAN_ADET = 30;
const TESHIS_MAX_ADET = 100;

// ============================================================================
// İç yardımcılar (uzaktan çalıştırılamaz)
// ============================================================================

function teshisAdet_(n) {
  var sayi = Number(n);
  if (!isFinite(sayi) || sayi < 1) {
    return TESHIS_VARSAYILAN_ADET;
  }
  return Math.min(TESHIS_MAX_ADET, Math.floor(sayi));
}

/** Date/metin/boş değeri ISO metne çevirir (JSON'a güvenli). */
function teshisTarih_(v) {
  if (v === "" || v === null || v === undefined) {
    return "";
  }
  var d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function teshisMs_(v) {
  if (v === "" || v === null || v === undefined) {
    return NaN;
  }
  return (v instanceof Date ? v : new Date(v)).getTime();
}

function teshisKisalt_(metin) {
  var s = String(metin === null || metin === undefined ? "" : metin);
  return s.length > TESHIS_METIN_MAX ? s.slice(0, TESHIS_METIN_MAX) + "…" : s;
}

function teshisSayfaIsmi_(spreadsheet) {
  return spreadsheet.getSheets().map(function (s) {
    return s.getName();
  });
}

/**
 * Kuyruk sekmesini SADECE okuma amaçlı döndürür; yoksa null (oluşturmaz).
 * @return {GoogleAppsScript.Spreadsheet.Sheet|null}
 */
function teshisKuyrukSheet_() {
  return getTargetSpreadsheet_().getSheetByName(QUEUE_SHEET_NAME);
}

/** Bir kuyruk satırı nesnesini rapor için özetler. */
function teshisSatirOzeti_(row, tam) {
  var o = {
    satirNo: row.satirNo,
    updateId: row.updateId,
    tarih: teshisTarih_(row.mesajTarihi),
    metin: teshisKisalt_(row.text),
    durum: row.durum || "",
  };
  if (tam || row.durum) {
    o.asama = row.denemeAsamasi === "" ? "" : Number(row.denemeAsamasi);
    o.sonrakiDeneme = teshisTarih_(row.sonrakiDenemeZamani);
    o.ilkHata = teshisTarih_(row.ilkHataZamani);
    o.sonDeneme = teshisTarih_(row.sonDenemeZamani);
    o.hata = teshisKisalt_(row.sonHataMesaji);
    o.triggerId = row.triggerId || "";
  }
  return o;
}

/** Projedeki tüm trigger'ların özet listesi (yalnızca okuma). */
function teshisTriggerListesi_() {
  return ScriptApp.getProjectTriggers().map(function (t) {
    return {
      handler: t.getHandlerFunction(),
      uid: t.getUniqueId(),
      tip: String(t.getEventType()),
      kaynak: String(t.getTriggerSource()),
    };
  });
}

/** Kuyruktaki tüm satırları okur; sekme yoksa null. */
function teshisTumSatirlar_() {
  var sheet = teshisKuyrukSheet_();
  return sheet ? { sheet: sheet, satirlar: kuyrukTumSatirlariOku_(sheet) } : null;
}

/**
 * Çapraz tutarlılık kontrolleri. Her bulgu: {seviye, kod, aciklama, ilgili}.
 * @return {Array<Object>}
 */
function teshisBulgulariUret_(kuyruk, triggerlar, simdiMs) {
  var bulgular = [];
  var ekle = function (seviye, kod, aciklama, ilgili) {
    bulgular.push({ seviye: seviye, kod: kod, aciklama: aciklama, ilgili: ilgili || [] });
  };

  if (!kuyruk) {
    ekle("HATA", "T-00", "'" + QUEUE_SHEET_NAME + "' sekmesi bulunamadı.");
    return bulgular;
  }

  var satirlar = kuyruk.satirlar;
  var retryTriggerlari = triggerlar.filter(function (t) {
    return t.handler === RETRY_HANDLER_FN_ADI;
  });
  var canliIdler = retryTriggerlari.map(function (t) {
    return t.uid;
  });

  var bekleyenler = satirlar.filter(function (r) {
    return r.durum === RETRY_DURUM.BEKLIYOR;
  });
  var isleniyorlar = satirlar.filter(function (r) {
    return r.durum === RETRY_DURUM.ISLENIYOR;
  });
  var pesEdilenler = satirlar.filter(function (r) {
    return r.durum === RETRY_DURUM.PES_EDILDI;
  });

  // T-01: BEKLIYOR ama trigger_id canlı trigger'larda yok (ölü trigger).
  var oluTrigger = bekleyenler.filter(function (r) {
    return !r.triggerId || canliIdler.indexOf(r.triggerId) === -1;
  });
  if (oluTrigger.length > 0) {
    ekle(
      "HATA",
      "T-01",
      "BEKLIYOR durumundaki satırın trigger'ı yok/silinmiş (ölü trigger): mesaj hiç yeniden denenmeyecek.",
      oluTrigger.map(function (r) {
        return teshisSatirOzeti_(r, true);
      }),
    );
  }

  // T-02: hiçbir BEKLIYOR satırın göstermediği retry trigger'ı (sahipsiz).
  var mesruIdler = bekleyenler.map(function (r) {
    return r.triggerId;
  });
  var sahipsiz = retryTriggerlari.filter(function (t) {
    return mesruIdler.indexOf(t.uid) === -1;
  });
  if (sahipsiz.length > 0) {
    ekle(
      "UYARI",
      "T-02",
      "Hiçbir BEKLIYOR satırın göstermediği retry trigger'ı var (sahipsiz; bakım adımı temizler).",
      sahipsiz,
    );
  }

  // T-03: vadesi eşikten fazla geçmiş BEKLIYOR (takılı).
  var takili = bekleyenler.filter(function (r) {
    var ms = teshisMs_(r.sonrakiDenemeZamani);
    return !isNaN(ms) && ms + RETRY_TAKILI_ESIK_MS < simdiMs;
  });
  if (takili.length > 0) {
    ekle(
      "HATA",
      "T-03",
      "Vadesi 15 dk'dan fazla geçmiş BEKLIYOR satır var (takılı); bir sonraki mesajda ya da /pesedilenler ile PES_EDILDI'ye düşer.",
      takili.map(function (r) {
        return teshisSatirOzeti_(r, true);
      }),
    );
  }

  // T-04: uzun süredir ISLENIYOR (takılı).
  var takiliIsleniyor = isleniyorlar.filter(function (r) {
    var ms = teshisMs_(r.sonDenemeZamani);
    return !isNaN(ms) && ms + RETRY_TAKILI_ESIK_MS < simdiMs;
  });
  if (takiliIsleniyor.length > 0) {
    ekle(
      "HATA",
      "T-04",
      "15 dk'dan uzun süredir ISLENIYOR olan satır var (execution yarıda kalmış olabilir).",
      takiliIsleniyor.map(function (r) {
        return teshisSatirOzeti_(r, true);
      }),
    );
  }

  // T-05: PES_EDILDI adedi + en eskisinin yaşı.
  if (pesEdilenler.length > 0) {
    var enEski = pesEdilenler.reduce(function (acc, r) {
      var ms = teshisMs_(r.ilkHataZamani);
      return isNaN(ms) ? acc : acc === null || ms < acc ? ms : acc;
    }, null);
    ekle(
      "UYARI",
      "T-05",
      pesEdilenler.length +
        " PES_EDILDI mesaj var" +
        (enEski === null
          ? "."
          : " (en eskisi " + Math.round((simdiMs - enEski) / 3600000) + " saat önce)."),
      pesEdilenler.map(function (r) {
        return teshisSatirOzeti_(r, true);
      }),
    );
  }

  // T-06: aynı update_id birden çok satırda (kopya / yanlış satıra yazma izi).
  var sayac = {};
  satirlar.forEach(function (r) {
    sayac[r.updateId] = (sayac[r.updateId] || 0) + 1;
  });
  var kopyalar = Object.keys(sayac).filter(function (k) {
    return k !== "" && sayac[k] > 1;
  });
  if (kopyalar.length > 0) {
    ekle("HATA", "T-06", "Aynı update_id birden çok satırda: " + kopyalar.join(", "));
  }

  // T-07: spor notu bekleme modu (SporNot.js) tutarlılığı.
  var sporTriggerSayisi = triggerlar.filter(function (t) {
    return t.handler === SPOR_NOT_BEKLEME_HANDLER_FN_ADI;
  }).length;
  var sporBekleme = sporNotBeklemeDurumu_();
  if (sporTriggerSayisi > 1) {
    ekle("HATA", "T-07", "Birden fazla spor-notu süre trigger'ı var (sızıntı): " + sporTriggerSayisi);
  }
  if (sporBekleme && simdiMs - sporBekleme.baslangicMs >= SPOR_NOT_BEKLEME_ZAMAN_ASIMI_MS) {
    ekle("UYARI", "T-07", "Süresi dolmuş spor notu bekleme kaydı duruyor (bir sonraki mesajda temizlenir).");
  }
  if (!sporBekleme && sporTriggerSayisi > 0) {
    ekle("UYARI", "T-07", "Bekleme kaydı yok ama spor-notu süre trigger'ı duruyor.");
  }

  // T-08: trigger kotası (≈20) yaklaşımı.
  if (triggerlar.length >= 15) {
    ekle("UYARI", "T-08", "Toplam trigger sayısı " + triggerlar.length + " (kota ≈ 20).");
  }

  // T-09: başlık kolon sayısı.
  var kolonSayisi = kuyruk.sheet.getLastColumn();
  if (kolonSayisi !== QUEUE_HEADERS.length) {
    ekle(
      "HATA",
      "T-09",
      "Kuyruk sekmesi kolon sayısı " + kolonSayisi + ", beklenen " + QUEUE_HEADERS.length + ".",
    );
  }

  // T-10 (bilgi): işlenen son update_id ile kuyruktaki en büyük update_id.
  var sonIsaret = Number(
    PropertiesService.getScriptProperties().getProperty(SON_UPDATE_ID_KEY),
  );
  var enBuyuk = satirlar.reduce(function (acc, r) {
    var id = Number(r.updateId);
    return isFinite(id) && id > acc ? id : acc;
  }, 0);
  ekle(
    "BILGI",
    "T-10",
    "SON_UPDATE_ID=" + (isFinite(sonIsaret) ? sonIsaret : "yok") + ", kuyruktaki en büyük update_id=" + enBuyuk + ".",
  );

  // Özet bilgi: bekleyen sayısı ile retry trigger sayısı.
  if (bekleyenler.length !== retryTriggerlari.length) {
    ekle(
      "BILGI",
      "T-11",
      "BEKLIYOR satır sayısı (" + bekleyenler.length + ") retry trigger sayısından (" + retryTriggerlari.length + ") farklı.",
    );
  }
  return bulgular;
}

// ============================================================================
// Public teşhis fonksiyonları (clasp run-function ile çalıştırılabilir)
// ============================================================================

/**
 * Projedeki tüm trigger'lar.
 * @return {{zaman:string, adet:number, triggerlar:Array<Object>}}
 */
function teshisTriggerlar() {
  var triggerlar = teshisTriggerListesi_();
  var sonuc = { zaman: new Date().toISOString(), adet: triggerlar.length, triggerlar: triggerlar };
  console.log("[teshisTriggerlar] " + JSON.stringify(sonuc));
  return sonuc;
}

/**
 * Kuyruğun son N mesajı (en yeni sonda). Metinler kısaltılır.
 * @param {number} [n] varsayılan 30, üst sınır 100
 */
function teshisMesajlar(n) {
  var adet = teshisAdet_(n);
  var kuyruk = teshisTumSatirlar_();
  var sonuc;
  if (!kuyruk) {
    sonuc = { zaman: new Date().toISOString(), hata: "'" + QUEUE_SHEET_NAME + "' sekmesi bulunamadı." };
  } else {
    var son = kuyruk.satirlar.slice(-adet);
    sonuc = {
      zaman: new Date().toISOString(),
      toplamSatir: kuyruk.satirlar.length,
      istenen: adet,
      mesajlar: son.map(function (r) {
        return teshisSatirOzeti_(r, false);
      }),
    };
  }
  console.log("[teshisMesajlar] " + JSON.stringify(sonuc));
  return sonuc;
}

/**
 * Retry takipli (durum dolu) tüm satırlar + durum sayaçları.
 */
function teshisRetry() {
  var kuyruk = teshisTumSatirlar_();
  var sonuc;
  if (!kuyruk) {
    sonuc = { zaman: new Date().toISOString(), hata: "'" + QUEUE_SHEET_NAME + "' sekmesi bulunamadı." };
  } else {
    var takipli = kuyruk.satirlar.filter(function (r) {
      return r.durum;
    });
    var sayac = {};
    takipli.forEach(function (r) {
      sayac[r.durum] = (sayac[r.durum] || 0) + 1;
    });
    sonuc = {
      zaman: new Date().toISOString(),
      sayac: sayac,
      satirlar: takipli.map(function (r) {
        return teshisSatirOzeti_(r, true);
      }),
    };
  }
  console.log("[teshisRetry] " + JSON.stringify(sonuc));
  return sonuc;
}

/**
 * Çapraz tutarlılık bulguları (T-01 … T-11, bkz. teshisBulgulariUret_).
 * @return {{zaman:string, bulgular:Array<Object>, ozet:Object}}
 */
function teshisTutarlilik() {
  var simdi = new Date();
  var bulgular = teshisBulgulariUret_(
    teshisTumSatirlar_(),
    teshisTriggerListesi_(),
    simdi.getTime(),
  );
  var ozet = { HATA: 0, UYARI: 0, BILGI: 0 };
  bulgular.forEach(function (b) {
    ozet[b.seviye] = (ozet[b.seviye] || 0) + 1;
  });
  var sonuc = { zaman: simdi.toISOString(), ozet: ozet, bulgular: bulgular };
  console.log("[teshisTutarlilik] " + JSON.stringify(sonuc));
  return sonuc;
}

/**
 * Telegram webhook durumu (getWebhookInfo, GET). Token ve tam URL basılmaz.
 */
function teshisWebhook() {
  var sonuc = { zaman: new Date().toISOString() };
  try {
    var yanit = UrlFetchApp.fetch(
      "https://api.telegram.org/bot" + CONFIG.telegramToken + "/getWebhookInfo",
      { method: "get", muteHttpExceptions: true },
    );
    var bilgi = JSON.parse(yanit.getContentText()).result || {};
    var url = String(bilgi.url || "");
    var configUrl = String(CONFIG.webAppUrl || "");
    sonuc.http = yanit.getResponseCode();
    sonuc.urlSon8 = url ? url.slice(-8) : "";
    sonuc.configUrlEslesiyor = !!url && url === configUrl;
    sonuc.bekleyenUpdate = bilgi.pending_update_count;
    sonuc.sonHataTarihi = bilgi.last_error_date
      ? new Date(bilgi.last_error_date * 1000).toISOString()
      : "";
    sonuc.sonHataMesaji = teshisKisalt_(bilgi.last_error_message);
    sonuc.izinliUpdateler = bilgi.allowed_updates || [];
  } catch (err) {
    sonuc.hata = teshisKisalt_(err && err.message);
  }
  console.log("[teshisWebhook] " + JSON.stringify(sonuc));
  return sonuc;
}

/**
 * Harcama tablosunun son N satırı (D:I) + muhtemel mükerrerler (bilgi amaçlı).
 * @param {number} [n] varsayılan 30, üst sınır 100
 */
function teshisHarcamalar(n) {
  var adet = teshisAdet_(n);
  var sonuc = { zaman: new Date().toISOString() };
  try {
    var sheet = getTargetSheet_(getTargetSpreadsheet_());
    var satirlar = readTopRows_(sheet, adet);
    var kayitlar = satirlar.map(function (row) {
      return {
        tarih: teshisTarih_(row[0]),
        tutar: row[1],
        firma: teshisKisalt_(row[2]),
        tur: row[3],
        malzeme: teshisKisalt_(row[4]),
        aciklama: teshisKisalt_(row[5]),
      };
    });
    var sayac = {};
    kayitlar.forEach(function (k) {
      var anahtar = [k.tarih.slice(0, 10), k.tutar, k.firma, k.malzeme].join("|");
      sayac[anahtar] = (sayac[anahtar] || 0) + 1;
    });
    sonuc.istenen = adet;
    sonuc.kayitlar = kayitlar;
    sonuc.mukerrerAdaylari = Object.keys(sayac).filter(function (k) {
      return sayac[k] > 1;
    });
  } catch (err) {
    sonuc.hata = teshisKisalt_(err && err.message);
  }
  console.log("[teshisHarcamalar] " + JSON.stringify(sonuc));
  return sonuc;
}

/**
 * Ana rapor: tek çağrıda genel durum. Ajan önce bunu çalıştırıp `tutarlilik`
 * bulgularına bakmalı; ayrıntı için diğer teshis* fonksiyonlarına geçmeli.
 */
function teshisRapor() {
  var simdi = new Date();
  var triggerlar = teshisTriggerListesi_();
  var kuyruk = teshisTumSatirlar_();
  var bulgular = teshisBulgulariUret_(kuyruk, triggerlar, simdi.getTime());

  var sayac = {};
  var son = [];
  if (kuyruk) {
    kuyruk.satirlar.forEach(function (r) {
      var anahtar = r.durum || "(retry yok)";
      sayac[anahtar] = (sayac[anahtar] || 0) + 1;
    });
    son = kuyruk.satirlar.slice(-10).map(function (r) {
      return teshisSatirOzeti_(r, false);
    });
  }
  var props = PropertiesService.getScriptProperties();
  var sporBekleme = sporNotBeklemeDurumu_();

  var sonuc = {
    zaman: simdi.toISOString(),
    kuyruk: kuyruk
      ? { toplamSatir: kuyruk.satirlar.length, durumSayaci: sayac, sonMesajlar: son }
      : { hata: "'" + QUEUE_SHEET_NAME + "' sekmesi bulunamadı." },
    triggerlar: triggerlar,
    bulgular: bulgular,
    sporNotBekleme: sporBekleme
      ? {
          bekliyor: true,
          gecenSn: Math.round((simdi.getTime() - sporBekleme.baslangicMs) / 1000),
        }
      : { bekliyor: false },
    ayarlar: {
      testMode: !!CONFIG.testMode,
      telegramTokenVar: !!CONFIG.telegramToken,
      chatIdVar: !!CONFIG.chatId,
      webAppUrlVar: !!CONFIG.webAppUrl,
      sonUpdateIdVar: props.getProperty(SON_UPDATE_ID_KEY) !== null,
    },
  };
  console.log("[teshisRapor] " + JSON.stringify(sonuc));
  return sonuc;
}
