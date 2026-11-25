/**
 * TyO Assist — Puente de IA v29
 * Proveedor: Cloudflare Workers AI (plan gratuito: 10,000 neuronas al día, sin tarjeta).
 *
 * - Un solo archivo y sin dependencias: se puede pegar tal cual en el editor del panel de Cloudflare.
 * - Habla el mismo formato que ya usa la app (estilo Gemini: contents / generationConfig /
 *   systemInstruction → candidates). La app NO necesita cambios: solo URL y token en ⚙️ Ajustes.
 * - El modelo lo decide este puente (variables MODEL_*), no la app.
 * - No guarda ni registra el contenido clínico.
 */

const VERSION = "29.1";
const SERVICE = "tyo-assist-proxy"; // nombre que espera el botón «Probar conexión» de la app

const DEFAULTS = {
  MODEL_TEXT: "@cf/google/gemma-4-26b-a4b-it",
  MODEL_TEXT_BACKUP: "@cf/meta/llama-4-scout-17b-16e-instruct",
  // Fotos: primero Llama 4 Scout (multimodal, responde sin «pensar»), luego Gemma 4.
  MODEL_VISION: "@cf/meta/llama-4-scout-17b-16e-instruct",
  MODEL_VISION_BACKUP: "@cf/google/gemma-4-26b-a4b-it",
  MODEL_AUDIO: "@cf/openai/whisper-large-v3-turbo",
  MODEL_AUDIO_BACKUP: "@cf/openai/whisper",
  MAX_OUTPUT_TOKENS: 4096
};

const BODY_LIMIT_BYTES = 8 * 1024 * 1024; // 8 MB (foto comprimida o audio de varios minutos)
const DEFAULT_TIME_BUDGET_MS = 40_000;    // la app corta a los 45 s
const BACKUP_SHARE = 0.4;                 // parte del tiempo que siempre queda para el modelo de respaldo
const VISION_MAX_TOKENS = 2048;           // las fotos devuelven JSON corto
const MIN_TOKEN_LENGTH = 16;
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const LOCAL_ORIGINS = [
  "http://localhost:8787", "http://127.0.0.1:8787",
  "http://localhost:8000", "http://127.0.0.1:8000",
  "http://localhost:3000", "http://127.0.0.1:3000"
];

const GUARD = [
  "Eres un asistente de redacción clínica para médicos en México.",
  "No inventes datos, cifras, dosis, hallazgos, lateralidad ni diagnósticos que no estén en la entrada.",
  "Si falta información, indícalo tal como pidan las instrucciones; nunca la completes por tu cuenta.",
  "Responde en español de México."
].join(" ");

const QUOTA_MESSAGE = "Se agotó la cuota gratuita de IA de hoy (10,000 neuronas). Se renueva a las 18:00, hora del centro de México. Todo lo que funciona sin internet sigue disponible.";

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

class PuenteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class Reintentable extends Error {} // falla de un modelo: se intenta el de respaldo

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }
  });
}

function config(env) {
  const pick = (k) => String((env && env[k]) || "").trim() || DEFAULTS[k];
  const max = Number.parseInt(env && env.MAX_OUTPUT_TOKENS, 10);
  const budget = Number.parseInt(env && env.TIME_BUDGET_MS, 10); // solo para pruebas automáticas
  return {
    textModels: unique([pick("MODEL_TEXT"), pick("MODEL_TEXT_BACKUP")]),
    visionModels: unique([pick("MODEL_VISION"), pick("MODEL_VISION_BACKUP")]),
    audioModels: unique([pick("MODEL_AUDIO"), pick("MODEL_AUDIO_BACKUP")]),
    maxTokens: Number.isFinite(max) ? Math.min(Math.max(max, 512), 8192) : DEFAULTS.MAX_OUTPUT_TOKENS,
    budget: Number.isFinite(budget) ? Math.min(Math.max(budget, 1000), 44_000) : DEFAULT_TIME_BUDGET_MS
  };
}

// Tiempo para un modelo: si hay respaldo después, se le reserva su parte para que siempre alcance a intentar.
function attemptDeadline(start, cfg, isLast) {
  const rem = cfg.budget - (Date.now() - start);
  const min = minAttemptMs(cfg);
  if (rem < min) return 0;
  const cap = isLast ? rem : Math.max(min, rem - Math.round(cfg.budget * BACKUP_SHARE));
  return Date.now() + cap;
}

function minAttemptMs(cfg) {
  return Math.min(2500, Math.round(cfg.budget * 0.1));
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function configuredOrigins(env) {
  const raw = [env && env.ALLOWED_ORIGINS, env && env.APP_ORIGIN].filter(Boolean).join(",");
  return raw.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
}

function originCheck(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return { origin: null, allowed: true };
  const list = configuredOrigins(env);
  // Sin lista configurada se acepta cualquier origen: el token sigue siendo obligatorio.
  if (!list.length) return { origin, allowed: true };
  return { origin, allowed: list.includes(origin) || LOCAL_ORIGINS.includes(origin) };
}

function corsHeaders(origin) {
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-TyO-Token",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (origin) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Reintentable("tiempo agotado")), ms); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function errorText(e) {
  return String((e && (e.message || e.toString())) || "");
}

function isQuotaError(e) {
  return /4006|daily free allocation|neurons? (limit|allocation)|used up your daily/i.test(errorText(e));
}

function isCapacityError(e) {
  return /3040|capacity|temporarily|overloaded|try again/i.test(errorText(e));
}

function isFormatError(e) {
  return /json|schema|response_format|guided|format|additional propert|invalid input|unexpected/i.test(errorText(e));
}

function left(deadline) {
  return deadline - Date.now();
}

// ---------------------------------------------------------------------------
// Esquemas: la app manda el estilo Gemini (type: "STRING", "OBJECT"...)
// ---------------------------------------------------------------------------

function toJsonSchema(s, depth = 0) {
  if (!s || typeof s !== "object" || depth > 12) return {};
  const out = {};
  if (s.type) out.type = String(s.type).toLowerCase();
  if (s.description) out.description = String(s.description);
  if (Array.isArray(s.enum)) out.enum = s.enum.slice();
  if (s.properties && typeof s.properties === "object") {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties)) out.properties[k] = toJsonSchema(v, depth + 1);
    if (!out.type) out.type = "object";
  }
  if (Array.isArray(s.required)) out.required = s.required.filter((k) => typeof k === "string");
  if (s.items) out.items = toJsonSchema(s.items, depth + 1);
  return out;
}

function emptyFor(s) {
  switch (s && s.type) {
    case "object": return repair({}, s);
    case "array": return [];
    case "boolean": return false;
    case "number":
    case "integer": return null;
    default: return "";
  }
}

// Ajusta la respuesta al esquema: completa claves requeridas faltantes con valores vacíos
// (nunca con datos inventados) y corrige tipos simples.
function repair(v, s) {
  const t = s && s.type;
  if (t === "object") {
    const obj = v && typeof v === "object" && !Array.isArray(v) ? { ...v } : {};
    const props = s.properties || {};
    for (const [k, ps] of Object.entries(props)) if (k in obj) obj[k] = repair(obj[k], ps);
    for (const k of s.required || []) {
      if (obj[k] === undefined || obj[k] === null) obj[k] = emptyFor(props[k]);
    }
    return obj;
  }
  if (t === "array") {
    const arr = Array.isArray(v) ? v : (v === undefined || v === null || v === "" ? [] : [v]);
    return s.items ? arr.map((x) => repair(x, s.items)) : arr;
  }
  if (t === "string") {
    if (v === undefined || v === null) return "";
    return typeof v === "string" ? v : (typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  if (t === "boolean") return v === true || v === "true" || v === 1;
  if (t === "number" || t === "integer") {
    const n = Number(v);
    return v === null || v === "" || !Number.isFinite(n) ? null : n;
  }
  return v;
}

// Si el modelo devolvió el contenido interno sin la envoltura (p. ej. las secciones sin "secciones"),
// lo envuelve en la clave requerida correspondiente.
function rewrapTopLevel(obj, schema) {
  if (!schema || schema.type !== "object" || !obj || typeof obj !== "object") return obj;
  const props = schema.properties || {};
  for (const k of schema.required || []) {
    const ps = props[k];
    if (obj[k] !== undefined || !ps || ps.type !== "object" || !ps.properties) continue;
    const inner = Object.keys(ps.properties);
    const hits = Object.keys(obj).filter((x) => inner.includes(x));
    if (hits.length && hits.length >= Math.ceil(inner.length / 2)) {
      const wrapped = {};
      for (const x of hits) wrapped[x] = obj[x];
      const rest = { ...obj };
      for (const x of hits) delete rest[x];
      return { ...rest, [k]: wrapped };
    }
  }
  return obj;
}

function hasStringProp(schema, name) {
  return !!(schema && schema.properties && schema.properties[name] && schema.properties[name].type === "string");
}

function parseJsonLoose(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const tries = [t];
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) tries.push(fenced[1].trim());
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a !== -1 && b > a) tries.push(t.slice(a, b + 1));
  for (const x of tries) {
    try {
      const v = JSON.parse(x);
      if (v && typeof v === "object") return v;
    } catch (_) { /* siguiente intento */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Salida de Workers AI (los modelos devuelven formatos distintos)
// ---------------------------------------------------------------------------

function stripThinking(text) {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^\s*<think>[\s\S]*$/i, "").trim();
}

function extractOutput(out, maxTokens) {
  let text = "";
  let truncated = false;
  if (typeof out === "string") {
    text = out;
  } else if (out && typeof out.response === "string") {
    text = out.response;
  } else if (out && out.response && typeof out.response === "object") {
    text = JSON.stringify(out.response);
  } else if (out && Array.isArray(out.choices) && out.choices[0]) {
    const c = out.choices[0];
    const m = c.message && c.message.content;
    text = typeof m === "string" ? m : Array.isArray(m) ? m.map((x) => (x && x.text) || "").join("") : (c.text || "");
    if (c.finish_reason === "length") truncated = true;
  } else if (out && typeof out.output_text === "string") {
    text = out.output_text;
  } else if (out && Array.isArray(out.output)) {
    text = out.output.flatMap((i) => (i && i.content) || []).filter((c) => c && typeof c.text === "string").map((c) => c.text).join("\n");
  } else if (out && out.result) {
    return extractOutput(out.result, maxTokens);
  }
  const used = out && out.usage && out.usage.completion_tokens;
  if (typeof used === "number" && used >= maxTokens) truncated = true;
  return { text: stripThinking(text), truncated };
}

function geminiEnvelope(text, model) {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }],
    modelVersion: model,
    puente: { version: VERSION, proveedor: "cloudflare-workers-ai" }
  };
}

// ---------------------------------------------------------------------------
// Lectura de la solicitud de la app
// ---------------------------------------------------------------------------

async function readJsonBody(request) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > BODY_LIMIT_BYTES) throw new PuenteError(413, "El archivo es demasiado grande para el puente (máximo 8 MB). Recorta o reduce la foto.");
  const raw = await request.text();
  if (raw.length > BODY_LIMIT_BYTES) throw new PuenteError(413, "El archivo es demasiado grande para el puente (máximo 8 MB). Recorta o reduce la foto.");
  try {
    return JSON.parse(raw);
  } catch (_) {
    throw new PuenteError(400, "La solicitud no es JSON válido.");
  }
}

function splitParts(body) {
  const contents = Array.isArray(body && body.contents) ? body.contents : [];
  const parts = contents.flatMap((c) => (c && Array.isArray(c.parts) ? c.parts : []));
  const texts = [];
  const images = [];
  const audios = [];
  for (const p of parts) {
    if (p && typeof p.text === "string" && p.text.trim()) texts.push(p.text);
    const inline = p && (p.inline_data || p.inlineData);
    if (!inline) continue;
    const mime = String(inline.mime_type || inline.mimeType || "").toLowerCase().split(";")[0].trim();
    // Solo se revisa el inicio: recorrer varios MB gastaría el tiempo de CPU del plan gratuito.
    const data = typeof inline.data === "string" ? inline.data.trim() : "";
    if (!data || !/^[A-Za-z0-9+/]+=*$/.test(data.slice(0, 256))) {
      throw new PuenteError(400, "El archivo adjunto está vacío o dañado.");
    }
    if (mime.startsWith("audio/") || mime === "video/mp4" || mime === "video/webm") {
      audios.push({ mime, data });
    } else if (IMAGE_MIME.has(mime)) {
      images.push({ mime, data });
    } else if (mime.startsWith("image/")) {
      throw new PuenteError(415, "Formato de imagen no compatible (" + mime + "). Usa una foto JPG, PNG o WebP.");
    } else {
      throw new PuenteError(415, "Tipo de archivo no compatible (" + (mime || "desconocido") + ").");
    }
  }
  return { texts, images, audios };
}

function systemText(body) {
  const si = body && (body.systemInstruction || body.system_instruction);
  const parts = si && Array.isArray(si.parts) ? si.parts : [];
  return parts.map((p) => (p && typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Audio → texto (Whisper)
// ---------------------------------------------------------------------------

const PROMPT_STOP = new Set(["REGLAS", "LFPDPPP", "CURP", "NSS", "RFC", "JSON", "PII", "IA", "NOM", "INAUDIBLE", "TYO", "ÚNICAMENTE"]);

function whisperPrompt(sys) {
  const found = String(sys || "").match(/\b[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9/-]{1,7}\b/g) || [];
  const terms = unique(found.filter((w) => !PROMPT_STOP.has(w))).slice(0, 60).join(", ");
  const base = "Dictado clínico de guardia en español de México.";
  return (terms ? base + " Abreviaturas frecuentes: " + terms + "." : base).slice(0, 700);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function transcribe(env, audios, sys, cfg, start) {
  const prompt = whisperPrompt(sys);
  const texts = [];
  let usedModel = "";
  for (const a of audios) {
    let done = false;
    let lastErr = null;
    for (let i = 0; i < cfg.audioModels.length; i++) {
      const model = cfg.audioModels[i];
      const deadline = attemptDeadline(start, cfg, i === cfg.audioModels.length - 1);
      if (!deadline) break;
      const input = model.includes("whisper-large-v3-turbo")
        ? { audio: a.data, language: "es", initial_prompt: prompt, vad_filter: true, condition_on_previous_text: false }
        : { audio: Array.from(base64ToBytes(a.data)) };
      try {
        const out = await withTimeout(env.AI.run(model, input), left(deadline));
        const text = String((out && (out.text || (out.result && out.result.text))) || "").trim();
        texts.push(text);
        usedModel = model;
        done = true;
        break;
      } catch (e) {
        if (isQuotaError(e)) throw new PuenteError(429, QUOTA_MESSAGE);
        lastErr = e;
        console.log("puente: audio falló en " + model + ": " + errorText(e).slice(0, 120));
      }
    }
    if (!done) {
      throw new PuenteError(502, "No se pudo transcribir el audio con la IA gratuita" + (lastErr ? " (" + errorText(lastErr).slice(0, 80) + ")" : "") + ". Intenta de nuevo o usa el dictado del teléfono.");
    }
  }
  return { text: texts.filter(Boolean).join("\n").trim(), model: usedModel };
}

// ---------------------------------------------------------------------------
// Texto e imagen → respuesta (modelos de lenguaje)
// ---------------------------------------------------------------------------

function buildSystem(sys, schema, wantsJson) {
  const blocks = [sys ? sys + "\n\n" + GUARD : GUARD];
  if (wantsJson) blocks.push("FORMATO DE SALIDA: responde únicamente con un objeto JSON válido, sin texto antes ni después y sin bloques de código.");
  if (schema) blocks.push("El JSON debe seguir exactamente este esquema. Usa estas mismas claves e incluye todas las requeridas; las descripciones son instrucciones:\n" + JSON.stringify(schema));
  return blocks.join("\n\n");
}

function tokenParam(model) {
  return /gemma-4/.test(model) ? "max_completion_tokens" : "max_tokens";
}

async function runChat(env, model, messages, opts, deadline, minMs) {
  const base = { messages, temperature: opts.temperature };
  base[tokenParam(model)] = opts.maxTokens;
  // Gemma 4 razona antes de responder; para redactar o extraer datos no hace falta y solo agrega espera.
  if (/gemma-4/.test(model)) base.chat_template_kwargs = { enable_thinking: false };
  const withFormat = opts.schema
    ? { ...base, response_format: { type: "json_schema", json_schema: opts.schema } }
    : opts.wantsJson ? { ...base, response_format: { type: "json_object" } } : base;

  let input = withFormat;
  let capacityRetried = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (left(deadline) < minMs) throw new Reintentable("tiempo agotado");
    try {
      const out = await withTimeout(env.AI.run(model, input), left(deadline));
      const { text, truncated } = extractOutput(out, opts.maxTokens);
      if (truncated) throw new Reintentable("respuesta incompleta");
      return text;
    } catch (e) {
      if (e instanceof Reintentable) throw e;
      if (isQuotaError(e)) throw new PuenteError(429, QUOTA_MESSAGE);
      if (input !== base && isFormatError(e)) { input = base; continue; } // sin modo JSON; el esquema va en las instrucciones
      if (!capacityRetried && isCapacityError(e)) { capacityRetried = true; await sleep(700); continue; }
      throw new Reintentable(errorText(e).slice(0, 120) || "error del modelo");
    }
  }
  throw new Reintentable("sin respuesta");
}

async function generate(body, env, start) {
  const cfg = config(env);
  const gen = (body && body.generationConfig) || {};
  const schema = gen.responseSchema ? toJsonSchema(gen.responseSchema) : null;
  const wantsJson = gen.responseMimeType === "application/json" || !!schema;
  const temperature = Math.min(Math.max(Number.isFinite(Number(gen.temperature)) ? Number(gen.temperature) : 0.1, 0), 1);
  const sys = systemText(body);
  const { texts, images, audios } = splitParts(body);

  if (!texts.length && !images.length && !audios.length) {
    throw new PuenteError(400, "La solicitud no trae texto, imagen ni audio.");
  }

  if (audios.length) {
    const t = await transcribe(env, audios, sys, cfg, start);
    // Dictado: se devuelve la transcripción literal, sin pasar por otro modelo que pueda reescribirla.
    if (!images.length && (!schema || hasStringProp(schema, "transcripcion"))) {
      if (!schema) return geminiEnvelope(t.text, t.model);
      const obj = repair({ transcripcion: t.text, segmentos_inaudibles: [], alerta_pii_en_audio: false }, schema);
      return geminiEnvelope(JSON.stringify(obj), t.model);
    }
    texts.push("Transcripción automática del audio:\n" + (t.text || "[sin voz legible]"));
  }

  const userText = texts.join("\n\n") || "Analiza la imagen.";
  const userContent = images.length
    ? [{ type: "text", text: userText }, ...images.map((im) => ({ type: "image_url", image_url: { url: "data:" + im.mime + ";base64," + im.data } }))]
    : userText;
  const messages = [
    { role: "system", content: buildSystem(sys, schema, wantsJson) },
    { role: "user", content: userContent }
  ];

  const models = images.length ? cfg.visionModels : cfg.textModels;
  const maxTokens = images.length ? Math.min(cfg.maxTokens, VISION_MAX_TOKENS) : cfg.maxTokens;
  const reasons = [];
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const deadline = attemptDeadline(start, cfg, i === models.length - 1);
    if (!deadline) break;
    try {
      const text = await runChat(env, model, messages, { schema, wantsJson, temperature, maxTokens }, deadline, minAttemptMs(cfg));
      if (wantsJson) {
        let obj = parseJsonLoose(text);
        if (!obj) throw new Reintentable("la respuesta no fue JSON válido");
        if (schema) obj = repair(rewrapTopLevel(obj, schema), schema);
        return geminiEnvelope(JSON.stringify(obj), model);
      }
      if (!text) throw new Reintentable("respuesta vacía");
      return geminiEnvelope(text, model);
    } catch (e) {
      if (e instanceof PuenteError) throw e;
      reasons.push(model.split("/").pop().split("-").slice(0, 2).join("-") + ": " + errorText(e).slice(0, 70));
      console.log("puente: falló " + model + ": " + reasons[reasons.length - 1]);
    }
  }
  throw new PuenteError(502, "La IA gratuita no pudo completar la solicitud" + (reasons.length ? " (" + reasons.join(" / ") + ")" : "") + ". Intenta de nuevo en unos segundos.");
}

// ---------------------------------------------------------------------------
// Estado (botón «Probar conexión»)
// ---------------------------------------------------------------------------

function health(env) {
  const cfg = config(env);
  return {
    ok: true,
    service: SERVICE,
    version: VERSION,
    provider: "Cloudflare Workers AI (plan gratuito)",
    keyConfigured: !!(env.AI && typeof env.AI.run === "function"),
    tokenProtected: true,
    originsRestricted: configuredOrigins(env).length > 0,
    models: { texto: cfg.textModels, imagen: cfg.visionModels, audio: cfg.audioModels }
  };
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const { origin, allowed } = originCheck(request, env);
    const cors = corsHeaders(allowed ? origin : null);
    if (!allowed) return json({ error: "Origen no autorizado. Agrega la dirección de tu app en ALLOWED_ORIGINS." }, 403, cors);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const start = Date.now();
    try {
      // Se ignoran espacios y saltos de línea invisibles al inicio o al final (la app también los quita).
      const expected = String((env && env.APP_ACCESS_TOKEN) || "").trim();
      if (expected.length < MIN_TOKEN_LENGTH) {
        throw new PuenteError(503, "Falta configurar el secreto APP_ACCESS_TOKEN en el Worker (mínimo 16 caracteres).");
      }
      if (!safeEqual(String(request.headers.get("X-TyO-Token") || "").trim(), expected)) {
        throw new PuenteError(401, "Token incorrecto o faltante. Debe ser idéntico en ⚙️ Ajustes de la app y en el secreto APP_ACCESS_TOKEN de Cloudflare.");
      }
      if (request.method === "GET") return json(health(env), 200, cors);
      if (request.method !== "POST") throw new PuenteError(405, "Método no permitido.");
      if (!env.AI || typeof env.AI.run !== "function") {
        throw new PuenteError(503, "Falta el enlace de Workers AI llamado AI en el Worker (Settings → Bindings).");
      }
      const body = await readJsonBody(request);
      return json(await generate(body, env, start), 200, cors);
    } catch (err) {
      const e = err instanceof PuenteError ? err : new PuenteError(500, "Error interno del puente.");
      if (!(err instanceof PuenteError)) console.log("puente: error interno: " + errorText(err).slice(0, 120));
      return json({ error: e.message }, e.status, cors);
    }
  }
};
