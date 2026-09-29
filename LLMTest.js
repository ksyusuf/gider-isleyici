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
    parts: parts,
    normalizeHata: normalizeHata,
  };
}

/**
 * Örnek harcama mesajını gönderip sonucu okunaklı bir blok olarak Logger'a yazar.
 */
function llmTest() {
  var r = llmTestIstegi_(LLM_TEST_MESAJI);
  var satirlar = [
    "",
    "════════ LLM TESTİ ════════",
    "Sağlayıcı: " + CONFIG.llm.test.provider,
    "Model    : " + CONFIG.llm.test.model,
    "Mesaj    : " + LLM_TEST_MESAJI,
    "Sonuç    : HTTP " + r.http + " (" + r.sureMs + " ms)",
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
