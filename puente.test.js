import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";

const TOKEN = "token-de-prueba-0123456789";
const APP = "https://tyoassistx.edgargm331.workers.dev";
const URL_PUENTE = "https://puente.test/";

// IA simulada: cada prueba define qué responde cada modelo.
function fakeAI(handler) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      return handler(model, input, calls.length);
    }
  };
}

function env(ai, extra = {}) {
  return { APP_ACCESS_TOKEN: TOKEN, ALLOWED_ORIGINS: APP, AI: ai, ...extra };
}

function post(body, headers = {}) {
  return new Request(URL_PUENTE, {
    method: "POST",
    headers: { Origin: APP, "Content-Type": "application/json", "X-TyO-Token": TOKEN, ...headers },
    body: JSON.stringify(body)
  });
}

// Lo mismo que hace la app en callGemini() + lectura de candidates[0].content.parts[0].text
async function comoLaApp(res) {
  assert.equal(res.status, 200, await res.clone().text());
  const data = await res.json();
  const text = data.candidates[0].content.parts[0].text;
  assert.equal(typeof text, "string");
  return text;
}

// Esquema NOM-004 como lo construye buildNom004ResponseSchema() en la app (estilo Gemini)
const ESQUEMA_NOTA = {
  type: "OBJECT",
  properties: {
    secciones: {
      type: "OBJECT",
      properties: {
        s_8_1_1: { type: "STRING", description: "Motivo. Si no existe dato escribir [NO REFERIDO]." },
        s_8_1_2: { type: "STRING", description: "Exploración. Si no existe dato escribir [NO REFERIDO]." }
      },
      required: ["s_8_1_1", "s_8_1_2"]
    },
    abreviaturas_expandidas: { type: "ARRAY", items: { type: "STRING" } }
  },
  required: ["secciones"]
};

function solicitudNota(extra = {}) {
  return {
    model: "gemini-2.5-flash", // la app lo manda; el puente lo ignora
    contents: [{ parts: [{ text: "Estructura: masculino 45 años, dolor en tobillo derecho." }] }],
    generationConfig: { temperature: 0.05, responseMimeType: "application/json", responseSchema: ESQUEMA_NOTA },
    systemInstruction: { parts: [{ text: "Eres auditor NOM-004." }] },
    ...extra
  };
}

// ---------------------------------------------------------------------------
// Conexión, token y orígenes
// ---------------------------------------------------------------------------

test("«Probar conexión»: GET con token responde lo que espera la app", async () => {
  const res = await worker.fetch(new Request(URL_PUENTE, { headers: { Origin: APP, "X-TyO-Token": TOKEN } }), env(fakeAI(() => ({}))));
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.ok, true);
  assert.equal(d.service, "tyo-assist-proxy");
  assert.equal(d.keyConfigured, true);
  assert.equal(d.tokenProtected, true);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), APP);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("sin token o con token incorrecto → 401 con mensaje en español", async () => {
  for (const headers of [{ Origin: APP }, { Origin: APP, "X-TyO-Token": "otro-token-cualquiera-123" }]) {
    const res = await worker.fetch(new Request(URL_PUENTE, { headers }), env(fakeAI(() => ({}))));
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /Token/);
  }
});

test("llamada directa sin Origin (curl) y sin token no llega a la IA", async () => {
  const ai = fakeAI(() => ({ response: "{}" }));
  const req = new Request(URL_PUENTE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(solicitudNota()) });
  const res = await worker.fetch(req, env(ai));
  assert.equal(res.status, 401);
  assert.equal(ai.calls.length, 0);
});

test("si falta configurar APP_ACCESS_TOKEN, el puente se niega (falla cerrado)", async () => {
  const ai = fakeAI(() => ({ response: "{}" }));
  const res = await worker.fetch(post(solicitudNota()), env(ai, { APP_ACCESS_TOKEN: "" }));
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /APP_ACCESS_TOKEN/);
  assert.equal(ai.calls.length, 0);
});

test("preflight del navegador acepta la cabecera X-TyO-Token", async () => {
  const req = new Request(URL_PUENTE, {
    method: "OPTIONS",
    headers: { Origin: APP, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-tyo-token" }
  });
  const res = await worker.fetch(req, env(fakeAI(() => ({}))));
  assert.equal(res.status, 204);
  assert.match(res.headers.get("Access-Control-Allow-Headers"), /X-TyO-Token/);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), APP);
});

test("origen ajeno → 403; sin ALLOWED_ORIGINS se acepta cualquier origen con token", async () => {
  const ajeno = new Request(URL_PUENTE, { headers: { Origin: "https://sitio-ajeno.example", "X-TyO-Token": TOKEN } });
  assert.equal((await worker.fetch(ajeno, env(fakeAI(() => ({}))))).status, 403);
  const ajeno2 = new Request(URL_PUENTE, { headers: { Origin: "https://usuario.github.io", "X-TyO-Token": TOKEN } });
  const res = await worker.fetch(ajeno2, env(fakeAI(() => ({})), { ALLOWED_ORIGINS: "" }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).originsRestricted, false);
});

test("sin el enlace de Workers AI → 503 explicativo", async () => {
  const res = await worker.fetch(post(solicitudNota()), env(undefined));
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /Workers AI/);
});

// ---------------------------------------------------------------------------
// Notas (JSON con esquema)
// ---------------------------------------------------------------------------

test("nota NOM-004: convierte el esquema, usa el modelo del puente y responde como Gemini", async () => {
  const ai = fakeAI(() => ({ response: JSON.stringify({ secciones: { s_8_1_1: "Dolor en tobillo derecho", s_8_1_2: "[NO REFERIDO]" }, abreviaturas_expandidas: [] }) }));
  const text = await comoLaApp(await worker.fetch(post(solicitudNota()), env(ai)));
  const obj = JSON.parse(text);
  assert.equal(obj.secciones.s_8_1_1, "Dolor en tobillo derecho");
  assert.equal(ai.calls.length, 1);
  const { model, input } = ai.calls[0];
  assert.equal(model, "@cf/google/gemma-4-26b-a4b-it", "ignora el modelo que manda la app");
  assert.equal(input.response_format.type, "json_schema");
  assert.equal(input.response_format.json_schema.type, "object");
  assert.equal(input.response_format.json_schema.properties.secciones.properties.s_8_1_1.type, "string");
  assert.equal(input.temperature, 0.05);
  assert.equal(input.max_completion_tokens, 4096);
  assert.match(input.messages[0].content, /auditor NOM-004/);
  assert.match(input.messages[0].content, /No inventes/);
});

test("respuesta con bloque ```json y claves faltantes → se repara sin inventar datos", async () => {
  const ai = fakeAI(() => ({ response: "Aquí está:\n```json\n{\"secciones\":{\"s_8_1_1\":\"Caída\"}}\n```" }));
  const obj = JSON.parse(await comoLaApp(await worker.fetch(post(solicitudNota()), env(ai))));
  assert.equal(obj.secciones.s_8_1_1, "Caída");
  assert.equal(obj.secciones.s_8_1_2, "", "la clave faltante queda vacía; la app la muestra como [NO REFERIDO]");
});

test("si el modelo omite la envoltura «secciones», se vuelve a envolver", async () => {
  const ai = fakeAI(() => ({ response: JSON.stringify({ s_8_1_1: "Caída", s_8_1_2: "Edema" }) }));
  const obj = JSON.parse(await comoLaApp(await worker.fetch(post(solicitudNota()), env(ai))));
  assert.deepEqual(obj.secciones, { s_8_1_1: "Caída", s_8_1_2: "Edema" });
});

test("formato OpenAI (choices) y texto de razonamiento <think> también se leen", async () => {
  const ai = fakeAI(() => ({ choices: [{ message: { content: "<think>pensando…</think>{\"secciones\":{\"s_8_1_1\":\"A\",\"s_8_1_2\":\"B\"}}" }, finish_reason: "stop" }] }));
  const obj = JSON.parse(await comoLaApp(await worker.fetch(post(solicitudNota()), env(ai))));
  assert.equal(obj.secciones.s_8_1_2, "B");
});

test("si el modo JSON no se puede cumplir, reintenta el mismo modelo sin modo JSON", async () => {
  const ai = fakeAI((model, input) => {
    if (input.response_format) throw new Error("JSON Mode couldn't be met");
    return { response: "{\"secciones\":{\"s_8_1_1\":\"X\",\"s_8_1_2\":\"Y\"}}" };
  });
  const obj = JSON.parse(await comoLaApp(await worker.fetch(post(solicitudNota()), env(ai))));
  assert.equal(obj.secciones.s_8_1_1, "X");
  assert.equal(ai.calls.length, 2);
  assert.equal(ai.calls[1].model, ai.calls[0].model);
  assert.equal(ai.calls[1].input.response_format, undefined);
  assert.match(ai.calls[1].input.messages[0].content, /"s_8_1_1"/, "el esquema va en las instrucciones");
});

test("modelo principal saturado → espera, reintenta y luego usa el de respaldo", async () => {
  const ai = fakeAI((model) => {
    if (model.includes("gemma")) throw new Error("3040: Capacity temporarily exceeded, please try again");
    return { response: "{\"secciones\":{\"s_8_1_1\":\"R\",\"s_8_1_2\":\"S\"}}" };
  });
  const res = await worker.fetch(post(solicitudNota()), env(ai));
  const obj = JSON.parse(await comoLaApp(res));
  assert.equal(obj.secciones.s_8_1_1, "R");
  assert.deepEqual(ai.calls.map((c) => c.model.split("/").pop()), ["gemma-4-26b-a4b-it", "gemma-4-26b-a4b-it", "llama-4-scout-17b-16e-instruct"]);
  assert.equal(ai.calls[2].input.max_tokens, 4096, "Llama usa max_tokens");
});

test("respuesta cortada (límite de tokens) no se entrega como completa: pasa al respaldo", async () => {
  const ai = fakeAI((model) => model.includes("gemma")
    ? { choices: [{ message: { content: "{\"secciones\":{\"s_8_1_1\":\"Paciente de 45 a" }, finish_reason: "length" }] }
    : { response: "{\"secciones\":{\"s_8_1_1\":\"Completa\",\"s_8_1_2\":\"Sí\"}}" });
  const obj = JSON.parse(await comoLaApp(await worker.fetch(post(solicitudNota()), env(ai))));
  assert.equal(obj.secciones.s_8_1_1, "Completa");
});

test("si ambos modelos fallan → 502 con mensaje claro (nunca texto a medias)", async () => {
  const ai = fakeAI(() => ({ response: "esto no es JSON" }));
  const res = await worker.fetch(post(solicitudNota()), env(ai));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /IA gratuita no pudo completar/);
});

test("cuota diaria agotada → 429 con hora de renovación y sin probar el respaldo", async () => {
  const ai = fakeAI(() => { throw new Error("4006: you have used up your daily free allocation of 10,000 neurons"); });
  const res = await worker.fetch(post(solicitudNota()), env(ai));
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /18:00/);
  assert.equal(ai.calls.length, 1);
});

test("los modelos se cambian con variables, sin tocar el código", async () => {
  const ai = fakeAI(() => ({ response: "{\"secciones\":{}}" }));
  await worker.fetch(post(solicitudNota()), env(ai, { MODEL_TEXT: "@cf/openai/gpt-oss-120b" }));
  assert.equal(ai.calls[0].model, "@cf/openai/gpt-oss-120b");
});

// ---------------------------------------------------------------------------
// Fotos
// ---------------------------------------------------------------------------

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("foto de laboratorio: se envía como image_url con data URI junto con el texto", async () => {
  const ai = fakeAI(() => ({ response: "{\"estudios\":[]}" }));
  const body = {
    contents: [{ parts: [{ text: "Extrae los valores." }, { inline_data: { mime_type: "image/png", data: PNG_1PX } }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: { type: "OBJECT", properties: { estudios: { type: "ARRAY", items: { type: "STRING" } } }, required: ["estudios"] } },
    systemInstruction: { parts: [{ text: "Extractor de laboratorio." }] }
  };
  await comoLaApp(await worker.fetch(post(body), env(ai)));
  const content = ai.calls[0].input.messages[1].content;
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "image_url");
  assert.equal(content[1].image_url.url, "data:image/png;base64," + PNG_1PX);
});

test("foto HEIC o archivo raro → 415 con mensaje útil, sin gastar cuota", async () => {
  const ai = fakeAI(() => ({ response: "{}" }));
  const body = { contents: [{ parts: [{ text: "x" }, { inline_data: { mime_type: "image/heic", data: PNG_1PX } }] }] };
  const res = await worker.fetch(post(body), env(ai));
  assert.equal(res.status, 415);
  assert.match((await res.json()).error, /JPG, PNG o WebP/);
  assert.equal(ai.calls.length, 0);
});

test("archivo de más de 8 MB → 413", async () => {
  const big = "A".repeat(8 * 1024 * 1024 + 10);
  const body = { contents: [{ parts: [{ inline_data: { mime_type: "image/jpeg", data: big } }] }] };
  const res = await worker.fetch(post(body), env(fakeAI(() => ({}))));
  assert.equal(res.status, 413);
});

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

const ESQUEMA_AUDIO = {
  type: "OBJECT",
  properties: {
    transcripcion: { type: "STRING" },
    segmentos_inaudibles: { type: "ARRAY", items: { type: "STRING" } },
    alerta_pii_en_audio: { type: "BOOLEAN" }
  },
  required: ["transcripcion", "segmentos_inaudibles", "alerta_pii_en_audio"]
};

function solicitudAudio() {
  return {
    contents: [{ parts: [{ text: "Transcribe fielmente este dictado." }, { inline_data: { mime_type: "audio/mp4", data: "AAAAGGZ0eXBtcDQy" } }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: ESQUEMA_AUDIO },
    systemInstruction: { parts: [{ text: "REGLAS ESTRICTAS: Reconoce terminología: RAFI, RCFI, LCP, PFNA, DHS, NVD, SCA. Privacidad LFPDPPP: CURP." }] }
  };
}

test("dictado: Whisper en español con las abreviaturas de la app; devuelve la transcripción literal", async () => {
  const ai = fakeAI((model) => {
    if (model.includes("whisper")) return { text: " Masculino de 45 años, fractura Weber B, plan RAFI. " };
    throw new Error("no debería llamar a un modelo de texto");
  });
  const obj = JSON.parse(await comoLaApp(await worker.fetch(post(solicitudAudio()), env(ai))));
  assert.deepEqual(obj, { transcripcion: "Masculino de 45 años, fractura Weber B, plan RAFI.", segmentos_inaudibles: [], alerta_pii_en_audio: false });
  assert.equal(ai.calls.length, 1);
  const { model, input } = ai.calls[0];
  assert.equal(model, "@cf/openai/whisper-large-v3-turbo");
  assert.equal(input.language, "es");
  assert.equal(input.audio, "AAAAGGZ0eXBtcDQy", "se pasa el base64 sin decodificar");
  assert.match(input.initial_prompt, /RAFI/);
  assert.doesNotMatch(input.initial_prompt, /REGLAS|LFPDPPP|CURP/);
});

test("audio sin voz → transcripción vacía (la app muestra «No se detectó voz legible»)", async () => {
  const ai = fakeAI(() => ({ text: "" }));
  const obj = JSON.parse(await comoLaApp(await worker.fetch(post(solicitudAudio()), env(ai))));
  assert.equal(obj.transcripcion, "");
});

test("si Whisper turbo falla, usa Whisper de respaldo con bytes", async () => {
  const ai = fakeAI((model) => {
    if (model.includes("turbo")) throw new Error("5006: invalid audio");
    return { text: "Texto del respaldo" };
  });
  const obj = JSON.parse(await comoLaApp(await worker.fetch(post(solicitudAudio()), env(ai))));
  assert.equal(obj.transcripcion, "Texto del respaldo");
  assert.equal(ai.calls[1].model, "@cf/openai/whisper");
  assert.ok(Array.isArray(ai.calls[1].input.audio));
});

test("si ningún modelo de audio funciona → 502 sugiriendo el dictado del teléfono", async () => {
  const ai = fakeAI(() => { throw new Error("5006: invalid audio"); });
  const res = await worker.fetch(post(solicitudAudio()), env(ai));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /dictado del teléfono/);
});

// ---------------------------------------------------------------------------
// Piezas internas
// ---------------------------------------------------------------------------

test("el esquema convertido conserva descripciones y requeridos (son las instrucciones de la app)", async () => {
  const ai = fakeAI(() => ({ response: "{\"secciones\":{}}" }));
  await worker.fetch(post(solicitudNota()), env(ai));
  const s = ai.calls[0].input.response_format.json_schema;
  assert.equal(s.properties.secciones.required.length, 2);
  assert.match(s.properties.secciones.properties.s_8_1_1.description, /NO REFERIDO/);
  assert.equal(s.properties.abreviaturas_expandidas.items.type, "string");
});

test("booleanos solo son true si el modelo lo dijo explícitamente", async () => {
  const esquema = { type: "OBJECT", properties: { alerta: { type: "BOOLEAN" }, otra: { type: "BOOLEAN" } }, required: ["alerta", "otra"] };
  const ai = fakeAI(() => ({ response: "{\"alerta\":\"quizá\",\"otra\":\"true\"}" }));
  const body = { contents: [{ parts: [{ text: "x" }] }], generationConfig: { responseMimeType: "application/json", responseSchema: esquema } };
  const obj = JSON.parse(await comoLaApp(await worker.fetch(post(body), env(ai))));
  assert.deepEqual(obj, { alerta: false, otra: true });
});

test("el puente no modifica nada si la app pide texto libre (sin JSON)", async () => {
  const ai = fakeAI(() => ({ response: "  Texto pulido.  " }));
  const body = { contents: [{ parts: [{ text: "pulir esto" }] }], generationConfig: { temperature: 0.2 } };
  assert.equal(await comoLaApp(await worker.fetch(post(body), env(ai))), "Texto pulido.");
  assert.equal(ai.calls[0].input.response_format, undefined);
});
