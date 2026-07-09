// Unified trace format ("oa.unified.v2") — the canonical shape every upload is
// normalized to before it is stored in logs.db, regardless of source (browser
// chat, pip-library proxy, Claude Code / Codex / VS Code / OpenCode imports).
//
// Losslessness is two-layered:
//  1. `messages` — the normalized, queryable view (always-string content,
//     typed tool calls/results with ids, reasoning, images).
//  2. `source`  — the original trace file text, stored verbatim, so the exact
//     source-format file can be reconstructed byte-for-byte. When the user
//     redacts PII, the source records are redacted in the same pass (see
//     lib/redact.ts), so the reconstruction reflects the redacted text —
//     nothing unredacted survives in the row.
//
//   any source ──normalizeMessages──▶ UnifiedMessage[] ──toStored──▶ DB row
//   DB row ──storedToMessages──▶ UnifiedMessage[] ──toChatCompletions──▶ wire
//   DB row ──sourceOf──▶ original file text (back-conversion to source format)
//
// Kept free of React/DOM so it can be unit-tested with `bun test`.

export const UNIFIED_SCHEMA = "oa.unified.v2";

/**
 * The original trace, kept verbatim. `text` is the exact file content (or, for
 * live captures, the exact wire payloads) as produced by the source tool;
 * `format` names the tool (claude-code, codex, vscode, …) and `kind` how to
 * write it back to disk.
 */
export interface SourceEnvelope {
  format: string;
  kind: "jsonl" | "json";
  /** Original file name, when the source was a file. */
  name?: string;
  text: string;
}

export interface UnifiedToolCall {
  /** Provider call id when the source had one — preserved for back-conversion. */
  id?: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface UnifiedMessage {
  role: "system" | "user" | "assistant" | "tool" | string;
  /** Always a plain string — images/tools/thinking live in dedicated fields. */
  content: string;
  reasoning_content?: string;
  tool_calls?: UnifiedToolCall[];
  /** tool role: linkage back to the tool_call that produced this result. */
  tool_call_id?: string;
  /** tool role: name of the tool that ran. */
  name?: string;
  /** Image URLs / data URIs attached to the message (user turns). */
  images?: string[];
}

// --- Normalization (any source shape → UnifiedMessage[]) ---------------------

function stringify(v: any): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Coerce OpenAI/Anthropic-style tool call entries into UnifiedToolCall. */
function normalizeToolCall(tc: any): UnifiedToolCall {
  const fn = tc?.function && typeof tc.function === "object" ? tc.function : tc;
  const args = fn?.arguments ?? fn?.input ?? tc?.input ?? {};
  const out: UnifiedToolCall = {
    type: "function",
    function: {
      name: fn?.name || tc?.name || tc?.tool || "tool",
      arguments: typeof args === "string" ? args : stringify(args),
    },
  };
  const id = tc?.id ?? tc?.call_id ?? tc?.tool_call_id;
  if (typeof id === "string" && id) out.id = id;
  return out;
}

/** Extract an image URL from a content block, if it is one. */
function imageOfBlock(b: any): string | null {
  if (b?.type === "image_url") {
    const url = b.image_url?.url ?? b.image_url;
    return typeof url === "string" ? url : null;
  }
  if (b?.type === "image") {
    if (typeof b.url === "string") return b.url;
    const src = b.source;
    if (src?.type === "base64" && typeof src.data === "string") {
      return `data:${src.media_type || "image/png"};base64,${src.data}`;
    }
    if (typeof src?.url === "string") return src.url;
  }
  return null;
}

function hasPayload(m: UnifiedMessage): boolean {
  return !!(m.content || m.reasoning_content || m.tool_calls?.length || m.images?.length || m.role === "tool");
}

/**
 * Normalize one raw message. Anthropic-style user messages can carry
 * `tool_result` blocks inline; those are split out as separate `tool` role
 * messages, so a single input may produce several outputs (in source order).
 * Deterministic: the same input always yields the same output (no generated ids).
 */
export function normalizeMessage(raw: any): UnifiedMessage[] {
  if (!raw || typeof raw !== "object") return [];
  const role =
    typeof raw.role === "string" ? raw.role : raw.type === "user" || raw.type === "assistant" ? raw.type : "";
  if (!role) return [];

  const out: UnifiedMessage[] = [];
  const msg: UnifiedMessage = { role, content: "" };
  const texts: string[] = [];
  const reasonings: string[] = [];
  const toolCalls: UnifiedToolCall[] = [];
  const images: string[] = [];

  const reasoning = raw.reasoning_content ?? raw.reasoning;
  if (typeof reasoning === "string" && reasoning) reasonings.push(reasoning);
  if (typeof raw.image === "string" && raw.image) images.push(raw.image);
  if (Array.isArray(raw.images)) for (const u of raw.images) if (typeof u === "string" && u) images.push(u);
  if (Array.isArray(raw.tool_calls)) for (const tc of raw.tool_calls) toolCalls.push(normalizeToolCall(tc));

  const content = raw.content;
  if (typeof content === "string") {
    if (content) texts.push(content);
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if ((b.type === "text" || b.type === "output_text" || b.type === "input_text") && typeof b.text === "string") {
        if (b.text) texts.push(b.text);
      } else if (b.type === "thinking" || b.type === "reasoning") {
        const t = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
        if (t) reasonings.push(t);
      } else if (b.type === "tool_use" || b.type === "tool_call" || b.type === "function_call") {
        toolCalls.push(normalizeToolCall(b));
      } else if (b.type === "tool_result" || b.type === "function_call_output") {
        // Split inline tool results into a proper tool message (flushed below,
        // after the host message, preserving order for the common case of a
        // single result block per message).
        const tm: UnifiedMessage = {
          role: "tool",
          content: typeof b.content === "string" ? b.content : stringify(b.content ?? b.output ?? ""),
        };
        const id = b.tool_use_id ?? b.tool_call_id ?? b.call_id;
        if (typeof id === "string" && id) tm.tool_call_id = id;
        if (typeof b.name === "string" && b.name) tm.name = b.name;
        out.push(tm);
      } else {
        const img = imageOfBlock(b);
        if (img) images.push(img);
      }
    }
  } else if (content != null) {
    texts.push(stringify(content));
  }

  msg.content = texts.join("\n");
  if (reasonings.length) msg.reasoning_content = reasonings.join("\n");
  if (toolCalls.length) msg.tool_calls = toolCalls;
  if (images.length) msg.images = images;
  if (role === "tool") {
    const id = raw.tool_call_id ?? raw.call_id;
    if (typeof id === "string" && id) msg.tool_call_id = id;
    if (typeof raw.name === "string" && raw.name) msg.name = raw.name;
  }

  // Tool results split from an assistant/user message come *after* its own text.
  if (hasPayload(msg)) out.unshift(msg);
  return out;
}

/** Normalize a whole conversation from any supported source shape. */
export function normalizeMessages(raw: any[]): UnifiedMessage[] {
  const out: UnifiedMessage[] = [];
  for (const m of raw || []) out.push(...normalizeMessage(m));
  return out;
}

// --- Storage (UnifiedMessage[] ⇄ logs.db prompt/response row) -----------------

export interface StoredPayload {
  prompt: { schema: string; model: string; messages: UnifiedMessage[]; source?: SourceEnvelope };
  response: UnifiedMessage;
  tokens: number;
}

/**
 * Split a normalized conversation into the stored (prompt, response) pair: the
 * final assistant message becomes the response, everything before it the prompt
 * history. The optional source envelope rides along in the prompt for lossless
 * back-conversion. Returns objects; use buildStoredPayload for the JSON strings.
 */
export function toStored(model: string, rawMessages: any[], source?: SourceEnvelope | null): StoredPayload {
  const messages = normalizeMessages(rawMessages);
  let history = messages;
  let finalAssistant: UnifiedMessage = { role: "assistant", content: "" };
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant") {
    finalAssistant = last;
    history = messages.slice(0, -1);
  }
  const prompt: StoredPayload["prompt"] = { schema: UNIFIED_SCHEMA, model: model || "trace", messages: history };
  const response: UnifiedMessage = {
    role: "assistant",
    content: finalAssistant.content || "",
    reasoning_content: finalAssistant.reasoning_content || "",
    ...(finalAssistant.tool_calls ? { tool_calls: finalAssistant.tool_calls } : {}),
    ...(finalAssistant.images ? { images: finalAssistant.images } : {}),
  };
  // Token estimate covers the conversation only — the verbatim source copy
  // must not inflate contribution credit.
  const tokens = Math.floor((JSON.stringify(prompt).length + JSON.stringify(response).length) / 4);
  if (source && typeof source.text === "string" && source.text) {
    prompt.source = {
      format: source.format || "trace",
      kind: source.kind === "json" ? "json" : "jsonl",
      ...(source.name ? { name: source.name } : {}),
      text: source.text,
    };
  }
  return { prompt, response, tokens };
}

/** JSON-string form of toStored, matching the /api/log-interaction contract. */
export function buildStoredPayload(
  model: string,
  messages: any[],
  source?: SourceEnvelope | null,
): { prompt: string; response: string; tokens: number } {
  const { prompt, response, tokens } = toStored(model, messages, source);
  return { prompt: JSON.stringify(prompt), response: JSON.stringify(response), tokens };
}

/** Extract the verbatim source envelope from a stored prompt, if present. */
export function sourceOf(prompt: any): SourceEnvelope | null {
  const p = typeof prompt === "string" ? safeParse(prompt) : prompt;
  const s = p?.source;
  if (!s || typeof s !== "object" || typeof s.text !== "string" || !s.text) return null;
  return {
    format: typeof s.format === "string" && s.format ? s.format : "trace",
    kind: s.kind === "json" ? "json" : "jsonl",
    ...(typeof s.name === "string" && s.name ? { name: s.name } : {}),
    text: s.text,
  };
}

/** File name to write a reconstructed source to. */
export function sourceFileName(source: SourceEnvelope): string {
  if (source.name) return source.name;
  return `${source.format || "trace"}.${source.kind === "json" ? "json" : "jsonl"}`;
}

/**
 * Back-conversion step 1: reassemble the full unified conversation from a
 * stored row's prompt/response (objects or legacy JSON strings). Also accepts
 * pre-unified legacy rows, which normalize losslessly.
 */
export function storedToMessages(prompt: any, response: any): UnifiedMessage[] {
  const p = typeof prompt === "string" ? safeParse(prompt) : prompt;
  const r = typeof response === "string" ? safeParse(response) : response;
  const messages = normalizeMessages(Array.isArray(p) ? p : p?.messages || []);
  for (const m of normalizeMessage(r)) {
    if (hasPayload(m) && (m.content || m.reasoning_content || m.tool_calls?.length)) messages.push(m);
  }
  return messages;
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// --- Back-conversion to provider wire format ---------------------------------

/** UnifiedMessage[] → OpenAI chat-completions messages (images re-expanded). */
export function toChatCompletions(messages: UnifiedMessage[]): any[] {
  return messages.map(m => {
    if (m.role === "tool") {
      return {
        role: "tool",
        content: m.content,
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.name ? { name: m.name } : {}),
      };
    }
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content,
        ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      };
    }
    if (m.images?.length) {
      return {
        role: m.role,
        content: [
          { type: "text", text: m.content },
          ...m.images.map(url => ({ type: "image_url", image_url: { url } })),
        ],
      };
    }
    return { role: m.role, content: m.content };
  });
}

