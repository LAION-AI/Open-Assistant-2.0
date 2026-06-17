// In-browser PII redaction using openai/privacy-filter via Transformers.js.
// The model + ONNX runtime are loaded lazily (only when the user redacts) and
// run entirely on-device (WebGPU, falling back to WASM). The pure text-splicing
// logic is kept separate so it can be unit-tested without loading the model.

export type ProgressCb = (info: { status: string; progress?: number; file?: string; name?: string }) => void;

let pipePromise: Promise<any> | null = null;

/** Lazily load the token-classification pipeline (singleton). */
export async function loadRedactor(onProgress?: ProgressCb): Promise<any> {
  if (!pipePromise) {
    pipePromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const base: any = { dtype: "q4", progress_callback: onProgress };
      try {
        return await pipeline("token-classification", "openai/privacy-filter", { ...base, device: "webgpu" });
      } catch {
        // No/blocked WebGPU — fall back to WASM (CPU).
        return await pipeline("token-classification", "openai/privacy-filter", base);
      }
    })();
  }
  return pipePromise;
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
