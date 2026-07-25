// In-browser PII redaction via Transformers.js. Defaults to the lightweight
// nationaldesignstudio/rampart model; openai/privacy-filter is an opt-in
// alternative selectable in Settings (see REDACT_MODELS / getRedactModel).
// The model + ONNX runtime are loaded lazily (only when the user redacts) and
// run entirely on-device (WebGPU, falling back to WASM). The pure text-splicing
// logic is kept separate so it can be unit-tested without loading the model.

export type ProgressCb = (info: { status: string; progress?: number; file?: string; name?: string }) => void;

export type RedactModel = "rampart" | "openai";

// On-device PII models (token-classification, Transformers.js / ONNX). Rampart
// is the lightweight default; the OpenAI privacy-filter is heavier but broader.
export const REDACT_MODELS: Record<RedactModel, { id: string; label: string; note: string }> = {
  rampart: {
    id: "nationaldesignstudio/rampart",
    label: "Rampart",
    note: "~15 MB · fast — MiniLM, 17 PII types (recommended default)",
  },
  openai: {
    id: "openai/privacy-filter",
    label: "OpenAI Privacy Filter",
    note: "Larger BERT — slower to download, broader coverage",
  },
};

const REDACT_MODEL_KEY = "oa-redact-model";

export function getRedactModel(): RedactModel {
  try {
    const v = localStorage.getItem(REDACT_MODEL_KEY);
    if (v === "rampart" || v === "openai") return v;
  } catch {}
  return "rampart";
}

export function setRedactModel(m: RedactModel) {
  try {
    localStorage.setItem(REDACT_MODEL_KEY, m);
  } catch {}
}

// Cached per model so switching in Settings doesn't reload an already-loaded one.
const pipeCache: Partial<Record<RedactModel, Promise<any>>> = {};

/** Lazily load the token-classification pipeline for the chosen (or stored) model. */
export async function loadRedactor(onProgress?: ProgressCb, model: RedactModel = getRedactModel()): Promise<any> {
  if (!pipeCache[model]) {
    pipeCache[model] = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const id = REDACT_MODELS[model].id;
      const base: any = { dtype: "q4", progress_callback: onProgress };
      try {
        return await pipeline("token-classification", id, { ...base, device: "webgpu" });
      } catch {
        // No/blocked WebGPU — fall back to WASM (CPU).
        return await pipeline("token-classification", id, base);
      }
    })();
  }
  return pipeCache[model];
}

/** Human-friendly redaction placeholder for an entity group. */
export function placeholderFor(group: string): string {
  const g = (group || "").replace(/^private[_-]?/i, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `[REDACTED_${g || "PII"}]`;
}

/**
 * Replace detected entity spans in `text` with placeholders. Prefers character
 * offsets (start/end); falls back to literal word replacement.
 */
export function applyRedaction(text: string, entities: any[]): { text: string; count: number } {
  if (!text || !Array.isArray(entities) || entities.length === 0) return { text, count: 0 };

  const spans = entities
    .filter(e => Number.isInteger(e.start) && Number.isInteger(e.end) && e.end > e.start)
    .sort((a, b) => b.start - a.start);

  if (spans.length > 0) {
    let out = text;
    let count = 0;
    let lastStart = Infinity;
    for (const e of spans) {
      // Skip overlapping spans (already redacted a wider one).
      if (e.end > lastStart) continue;
      out = out.slice(0, e.start) + placeholderFor(e.entity_group || e.entity) + out.slice(e.end);
      lastStart = e.start;
      count++;
    }
    return { text: out, count };
  }

  // Offset-less fallback: replace each detected word once.
  let out = text;
  let count = 0;
  for (const e of entities) {
    const w = (e.word || "").trim();
    if (!w) continue;
    const idx = out.indexOf(w);
    if (idx !== -1) {
      out = out.slice(0, idx) + placeholderFor(e.entity_group || e.entity) + out.slice(idx + w.length);
      count++;
    }
  }
  return { text: out, count };
}

/** Split long text into model-sized chunks, preferring line boundaries. */
export function chunkText(text: string, max = 1500): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > i + max * 0.5) end = nl + 1;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

/** Redact a single string, chunking as needed. */
export async function redactText(text: string, classifier: any): Promise<{ text: string; count: number }> {
  if (!text || !text.trim()) return { text, count: 0 };
  const chunks = chunkText(text);
  let out = "";
  let count = 0;
  for (const chunk of chunks) {
    let entities: any[] = [];
    try {
      entities = await classifier(chunk, { aggregation_strategy: "simple" });
    } catch {
      entities = [];
    }
    const r = applyRedaction(chunk, entities);
    out += r.text;
    count += r.count;
  }
  return { text: out, count };
}

export interface RedactableMessage {
  role: string;
  content: string;
  reasoning?: string;
  [k: string]: any;
}

/** Redact the content + reasoning of every message in a conversation. */
export async function redactMessages(
  messages: RedactableMessage[],
  classifier: any,
): Promise<{ messages: RedactableMessage[]; count: number }> {
  let count = 0;
  const out: RedactableMessage[] = [];
  for (const m of messages) {
    const c = await redactText(m.content || "", classifier);
    const r = m.reasoning ? await redactText(m.reasoning, classifier) : { text: m.reasoning, count: 0 };
    count += c.count + r.count;
    out.push({ ...m, content: c.text, ...(m.reasoning !== undefined ? { reasoning: r.text } : {}) });
  }
  return { messages: out, count };
}

// --- Source-envelope redaction ------------------------------------------------
// Uploads can carry the original trace file verbatim (see lib/unified.ts
// SourceEnvelope) for lossless back-conversion. When the user redacts, that
// copy must be scrubbed too — otherwise the redaction would be cosmetic.

/**
 * Structural keys whose values must stay intact for the source file to remain
 * machine-readable after back-conversion (ids, enums, linkage). `arguments` is
 * skipped because it holds a nested JSON *string* — a placeholder spliced into
 * it could corrupt the inner JSON (matches redactMessages, which also leaves
 * tool arguments untouched).
 */
const STRUCTURAL_KEYS = new Set([
  "type", "role", "id", "uuid", "parentUuid", "leafUuid", "sessionId", "requestId",
  "tool_call_id", "tool_use_id", "call_id", "model", "timestamp", "version",
  "media_type", "mimeType", "kind", "format", "schema", "arguments",
]);

/** True for strings that can't contain prose PII (data URIs, base64/hash blobs). */
function skipString(s: string): boolean {
  if (s.length < 3) return true;
  if (/^data:[\w/+.-]+;base64,/.test(s)) return true;
  return s.length >= 512 && /^[A-Za-z0-9+/=_-]+$/.test(s);
}

/** Recursively redact every non-structural string value in a JSON value. */
async function redactDeep(value: any, classifier: any): Promise<{ value: any; count: number }> {
  if (typeof value === "string") {
    if (skipString(value)) return { value, count: 0 };
    const r = await redactText(value, classifier);
    return { value: r.text, count: r.count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const out: any[] = [];
    for (const v of value) {
      const r = await redactDeep(v, classifier);
      out.push(r.value);
      count += r.count;
    }
    return { value: out, count };
  }
  if (value && typeof value === "object") {
    let count = 0;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string" && STRUCTURAL_KEYS.has(k)) {
        out[k] = v;
        continue;
      }
      const r = await redactDeep(v, classifier);
      out[k] = r.value;
      count += r.count;
    }
    return { value: out, count };
  }
  return { value, count: 0 };
}

/**
 * Redact a verbatim source envelope, parse-aware so the result stays a valid
 * file of the same format: JSONL line-by-line, JSON as one document. Redacted
 * records are re-serialized (compact), so byte-identity is intentionally traded
 * for scrubbed text — an unredacted upload keeps the source byte-for-byte.
 */
export async function redactSource<T extends { kind: string; text: string }>(
  source: T,
  classifier: any,
): Promise<{ source: T; count: number }> {
  let count = 0;
  if (source.kind === "json") {
    try {
      const parsed = JSON.parse(source.text);
      const r = await redactDeep(parsed, classifier);
      return { source: { ...source, text: JSON.stringify(r.value) }, count: r.count };
    } catch {
      const r = await redactText(source.text, classifier);
      return { source: { ...source, text: r.text }, count: r.count };
    }
  }
  const lines: string[] = [];
  for (const line of source.text.split("\n")) {
    if (!line.trim()) {
      lines.push(line);
      continue;
    }
    try {
      const r = await redactDeep(JSON.parse(line), classifier);
      lines.push(JSON.stringify(r.value));
      count += r.count;
    } catch {
      const r = await redactText(line, classifier);
      lines.push(r.text);
      count += r.count;
    }
  }
  return { source: { ...source, text: lines.join("\n") }, count };
}
