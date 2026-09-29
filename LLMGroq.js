/**
 * ============================================================================
 * Gider İşleyici — Groq Adaptörü (llmSaglayici_("groq"))
 * ============================================================================
 * Groq, OpenAI uyumlu bir API sunar (Bearer auth, /chat/completions). Bu
 * dosya yalnızca Groq'a özgü istek/yanıt biçimini bilir; yanıtı LLM.js'in
 * ortak `parts` biçimine normalize eder ([{functionCall:{name,args}} | {text}]).
 * Kayıt: LLM.js > llmSaglayici_.
 */

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/** TOOLS şeması tip adlarını büyük harfle yazar ("OBJECT"); OpenAI/Groq küçük ister. */
function groqKucukTip_(node) {
  if (Array.isArray(node)) return node.map(groqKucukTip_);
  if (node && typeof node === "object") {
    var out = {};
    Object.keys(node).forEach(function (k) {
      out[k] =
        k === "type" && typeof node[k] === "string"
          ? node[k].toLowerCase()
          : groqKucukTip_(node[k]);
    });
    return out;
  }
  return node;
}

/** `null` değerli alanları atar (model `aciklama: null` üretebiliyor). */
function groqNullTemizle_(args) {
  var out = {};
  Object.keys(args || {}).forEach(function (k) {
    if (args[k] !== null) out[k] = args[k];
  });
  return out;
}

/**
 * Groq'a tek bir chat/completions isteği atar.
 * @param {{apiKey:string, model:string}} profil
 * @param {string} systemMetni
 * @param {string} userText

 * @return {Array<Object>} Ortak `parts` dizisi.
 */
function groqIstekGonder_(profil, systemMetni, userText) {
  var ham = groqIstekGonderHam_(profil, systemMetni, userText, true);
  if (ham.http !== 200) {
    var httpHata = new Error("Groq API hatası (HTTP " + ham.http + "): " + ham.govde);
    httpHata.httpStatus = ham.http; // hataGeciciMi_ / hataYuksekTalepMi_ için
    httpHata.httpBody = ham.govde;
    // Modelin tool adını/argümanını bozması (örn. "haracamaEkle") kalıcı değil:
    // yeniden örneklemede düzelebilir → Katman 1 tekrar denesin.
    if (ham.http === 400 && ham.govde.indexOf("tool_use_failed") !== -1) {
      httpHata.tekrarDenenebilir = true;
    }
    throw httpHata;
  }
  return groqPartsNormalize_(ham.govde);
}

/**
 * Ham HTTP çağrısı — fırlatmaz, {http, sureMs, govde} döndürür. LLMTest.js de
 * kullanır (hata gövdesini olduğu gibi göstermek için).
 */
function groqIstekGonderHam_(profil, systemMetni, userText, toolsDahil) {
  var requestBody = {
    model: profil.model,
    messages: [
      { role: "system", content: systemMetni },
      { role: "user", content: userText },
    ],
  };
  if (toolsDahil) {
    requestBody.tools = TOOLS.map(function (t) {
      return { type: "function", function: groqKucukTip_(t) };
    });
    requestBody.tool_choice = "auto";
  }

  var t0 = Date.now();
  // NOT: Authorization başlığı API key içeriyor — asla loglanmaz.
  var response = UrlFetchApp.fetch(GROQ_BASE_URL + "/chat/completions", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + profil.apiKey },
    payload: JSON.stringify(requestBody),
    muteHttpExceptions: true,
  });
  var sonuc = {
    http: response.getResponseCode(),
    sureMs: Date.now() - t0,
    govde: response.getContentText(),
  };
  log_("llm.yanit", sonuc);
  return sonuc;
}

/**
 * Groq 200 gövdesini ortak `parts` dizisine çevirir. Boş yanıtta (ne metin ne
 * tool çağrısı) httpStatus'suz Error fırlatır — hataGeciciMi_ bunu geçici sayar.
 * @param {string} govde
 * @return {Array<Object>}
 */
function groqPartsNormalize_(govde) {
  var json = JSON.parse(govde);
  var mesaj = json.choices && json.choices[0] && json.choices[0].message;
  if (!mesaj) {
    log_("llm.bos-yanit", json);
    throw new Error("Yapay zeka servisi beklenmeyen bir yanıt döndürdü.");
  }
  var parts = [];
  if (mesaj.content && mesaj.content.trim()) {
    parts.push({ text: mesaj.content });
  }
  (mesaj.tool_calls || []).forEach(function (c) {
    var args;
    try {
      args = JSON.parse(c.function.arguments || "{}");
    } catch (e) {
      // Bozuk argüman JSON'u: geçici model hatası → Katman 1 tekrar denesin.
      var err = new Error("Yapay zeka servisi geçersiz fonksiyon argümanı döndürdü.");
      err.tekrarDenenebilir = true;
      throw err;
    }
    parts.push({
      functionCall: { name: c.function.name, args: groqNullTemizle_(args) },
    });
  });
  if (!parts.length) {
    log_("llm.bos-yanit", json);
    throw new Error("Yapay zeka servisi boş yanıt döndürdü.");
  }
  return parts;
}

/**
 * Hesabın erişebildiği model id'leri (GET /models). Hata halinde fırlatır.
 * @param {{apiKey:string}} profil
 * @return {Array<string>}
 */
function groqModelleriListele_(profil) {
  var response = UrlFetchApp.fetch(GROQ_BASE_URL + "/models", {
    headers: { Authorization: "Bearer " + profil.apiKey },
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) {
    throw new Error(
      "HTTP " + response.getResponseCode() + ": " + response.getContentText(),
    );
  }
  return JSON.parse(response.getContentText()).data.map(function (m) {
    return m.id;
  });
}
