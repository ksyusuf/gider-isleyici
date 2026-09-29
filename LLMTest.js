/**
 * ============================================================================
 * Gider İşleyici — LLM API Test Fonksiyonları (TEST profili)
 * ============================================================================
 * Apps Script editöründen elle çalıştırılır. CONFIG.llm.test (Script
 * Properties: LLM_TEST_PROVIDER / LLM_TEST_API_KEY / LLM_TEST_MODEL) kullanılır;
 * prod profiline (doPost) dokunmaz. YAN ETKİSİ YOKTUR: Sheets'e yazmaz,
 * trigger kurmaz, Telegram'a mesaj göndermez, dönen fonksiyon çağrılarını
 * ÇALIŞTIRMAZ (calistirFonksiyon_ çağrılmaz) — yalnızca istek/yanıtı gösterir.
 */

/** llmTest() için örnek harcama mesajı (gerçek systemInstruction + TOOLS ile gönderilir). */
const LLM_TEST_MESAJI = "dün teknosadan telefon aldım 50000 tl";

/**
 * Test profiliyle tek istek atar; ham sonuç + (200 ise) normalize `parts` döner.
 * Fırlatmaz (profil eksikse hariç).
 * @param {string} userText
 * @return {{http:number, sureMs:number, govde:string, parts:?Array<Object>, normalizeHata:?string}}
 */
function llmTestIstegi_(userText) {
  var profil = CONFIG.llm.test;
  if (profil.provider !== "groq") {
    throw new Error(
      "Test için yalnızca 'groq' sağlayıcısı destekleniyor: " + profil.provider,
    );
  }
  if (!profil.apiKey || !profil.model) {
    throw new Error(
      "LLM_TEST_API_KEY ve LLM_TEST_MODEL Script Property'leri tanımlı olmalı.",
    );
  }
  var sistem = buildSystemInstruction_(new Date());
  var ham = groqIstekGonderHam_(profil, sistem, userText, true);
  var parts = null;
  var normalizeHata = null;
  if (ham.http === 200) {
    try {
      parts = groqPartsNormalize_(ham.govde);
    } catch (e) {
      normalizeHata = e.message;
    }
  }
  return {
    http: ham.http,
    sureMs: ham.sureMs,
    govde: ham.govde,
    usage: ham.usage,
    parts: parts,
    normalizeHata: normalizeHata,
  };
}

/**
 * Verilen mesajı (varsayılan: LLM_TEST_MESAJI) gönderip sonucu okunaklı bir blok
 * olarak Logger'a yazar. Aşağıdaki llmTest_* fonksiyonları bunu sabit örneklerle
 * çağırır — editörden her harcama tipini AYRI AYRI çalıştırmak için.
 */
function llmTest(mesaj) {
  mesaj = mesaj || LLM_TEST_MESAJI;
  var r = llmTestIstegi_(mesaj);
  var satirlar = [
    "",
    "════════ LLM TESTİ ════════",
    "Sağlayıcı: " + CONFIG.llm.test.provider,
    "Model    : " + CONFIG.llm.test.model,
    "Mesaj    : " + mesaj,
    "Sonuç    : HTTP " + r.http + " (" + r.sureMs + " ms)",
    "Token    : " +
      (r.usage
        ? "girdi " + r.usage.prompt_tokens + ", çıktı " + r.usage.completion_tokens
        : "-"),
    "",
  ];

  if (r.http === 200) {
    if (r.normalizeHata) {
      satirlar.push("── NORMALİZE HATASI: " + r.normalizeHata);
    } else {
      r.parts.forEach(function (p, i) {
        if (p.functionCall) {
          satirlar.push(
            "── Fonksiyon çağrısı " + (i + 1) + ": " + p.functionCall.name,
          );
          Object.keys(p.functionCall.args).forEach(function (k) {
            satirlar.push(
              "     " + k + ": " + JSON.stringify(p.functionCall.args[k]),
            );
          });
        } else {
          satirlar.push("── Düz metin cevap:", "     " + p.text);
        }
      });
    }
  } else {
    var hata = {};
    try {
      hata = JSON.parse(r.govde).error || {};
    } catch (e) {
      hata = { message: r.govde };
    }
    satirlar.push("── HATA: " + (hata.code || "?"), "     " + hata.message);
    if (hata.failed_generation) {
      // Model geçersiz bir tool çağrısı üretmişse ne ürettiğini göster.
      var fg = hata.failed_generation;
      try {
        fg = JSON.stringify(JSON.parse(fg), null, 2);
      } catch (e) {}
      satirlar.push("── Modelin ürettiği (geçersiz) çağrı:");
      fg.split("\n").forEach(function (l) {
        satirlar.push("     " + l);
      });
    }
  }
  satirlar.push("═══════════════════════════");
  Logger.log(satirlar.join("\n"));
}

/**
 * Test profilinin hesabında erişilebilen model id'lerini listeler. "Model
 * bulunamadı (404)" hatasında doğru adı bulmak için; bulunan adı LLM_TEST_MODEL
 * (ya da LLM_PROD_MODEL) Script Property'sine yaz.
 */
function llmModelleriListele() {
  var profil = CONFIG.llm.test;
  var saglayici = llmSaglayici_(profil.provider);
  if (!saglayici) {
    throw new Error("Bilinmeyen LLM sağlayıcısı: " + profil.provider);
  }
  var idler = saglayici.modelleriListele(profil);
  Logger.log("%s model:\n%s", idler.length, idler.join("\n"));
}

// ============================================================================
// Harcama tipi başına tek-istek test fonksiyonları (editörden birer birer çalıştır)
// ============================================================================
// Her biri tek bir API isteği atar (429'a takılmamak için ard arda değil, aralıklı
// çalıştır). Amaç: farklı harcama tiplerinde modelin döndürdüğü yanıt biçimini/
// tutarlılığını görmek. Yan etkisi yok (fonksiyon çalıştırılmaz).

/** Tek harcama, firma eki + göreceli tarih. */
function llmTest_tek() {
  llmTest("dün teknosadan telefon aldım 50000 tl");
}

/** ÇOKLU harcama: iki bağımsız kalem → tek add_expenses çağrısında 2 elemanlı liste beklenir. */
function llmTest_coklu() {
  llmTest("markette 200 tl alışveriş yaptım, otobüse 15 lira verdim");
}

/** ÇOKLU harcama, üç kalem ve farklı tarihler. */
function llmTest_coklu3() {
  llmTest("dün kafede 120 tl kahve içtim, bugün taksiye 250 tl verdim, akşam da eczaneden 90 tl vitamin aldım");
}

/** Taksitli, taksit başı tutar net. */
function llmTest_taksit() {
  llmTest("iphone'u 6 taksitle aldım, taksit başı 5000 tl");
}

/** Taksitli, toplam mı taksit başı mı belirsiz → çağrı yok, Türkçe soru beklenir. */
function llmTest_taksitBelirsiz() {
  llmTest("5 taksitle ayakkabı aldım 5000 tl");
}

/** Belirsiz tutar → çağrı yok, Türkçe soru beklenir. */
function llmTest_belirsizTutar() {
  llmTest("bugün biraz para harcadım");
}

/** Kısmi: bir kalem net, biri belirsiz → 1 çağrı + Türkçe soru beklenir. */
function llmTest_kismi() {
  llmTest("dün 150 tl bir şeye harcadım, bugün de 40 tl otobüs");
}

/** Kategori sınırı: atıştırmalık (Yemek). */
function llmTest_kategoriYemek() {
  llmTest("spor sonrası atıştırmalık aldım 105tl");
}

/** Kategori sınırı: dijital abonelik. */
function llmTest_kategoriDijital() {
  llmTest("netflix aboneliğim yenilendi 229 tl");
}

/** Selamlaşma → çağrı yok, kısa Türkçe metin beklenir. */
function llmTest_selam() {
  llmTest("merhaba");
}

/** Serbest deneme: aşağıdaki mesajı istediğin gibi değiştirip çalıştır. */
function llmTest_ozel() {
  llmTest("BURAYA_KENDI_MESAJINI_YAZ");
}