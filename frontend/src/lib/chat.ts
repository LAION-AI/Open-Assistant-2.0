// Pure helpers for parsing chat messages, reasoning ("thinking") and request/
// response logs. Kept free of React so they can be unit-tested with `bun test`.

export interface ChatRole {
  role: "system" | "user" | "assistant" | string;
  content: any;
  reasoning?: string;
  reasoning_content?: string;
}

export interface Turn {
  user: any | null;
  assistant: any | null;
  isFinal: boolean;
  userTurn: number;
}

/**
 * Split reasoning ("thinking") from the visible answer. Reasoning arrives either
 * as a dedicated field or inline as a <think>…</think> block, which may still be
 * open while the response is streaming.
 */
export function splitThinking(content: any, reasoning?: string): { thinking: string; text: string } {
  let thinking = (reasoning || "").trim();
  if (typeof content !== "string") {
    return { thinking, text: "" };
  }
  let text = content;
  const open = text.indexOf("<think>");
  if (open !== -1) {
    const close = text.indexOf("</think>", open);
    if (close !== -1) {
      const inner = text.slice(open + "<think>".length, close).trim();
      thinking = thinking ? `${thinking}\n${inner}` : inner;
      text = (text.slice(0, open) + text.slice(close + "</think>".length)).trim();
    } else {
      // Unclosed block (stream cut off mid-thought) — treat the remainder as thinking.
      const inner = text.slice(open + "<think>".length).trim();
      thinking = thinking ? `${thinking}\n${inner}` : inner;
      text = text.slice(0, open).trim();
    }
  }
  return { thinking, text };
}

// Accepts either a JSON string (legacy) or an already-parsed object/array, since
// the backend now embeds prompt/response as nested JSON rather than strings.
export function parseJsonObject(raw: any): any | null {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  return null;
}

/** Extract the messages array from a logged request payload. */
export function getMessages(prompt: any): any[] | null {
  const parsed = parseJsonObject(prompt);
  if (parsed) {
    const list = Array.isArray(parsed) ? parsed : parsed.messages;
    if (Array.isArray(list) && list.length > 0) return list;
  }
  return null;
}

/** Count user messages as conversation turns (minimum 1). */
export function getTurnCount(messages: any[] | null): number {
  if (!messages) return 1;
  return Math.max(messages.filter(m => m?.role === "user").length, 1);
}

/** Plain-text representation of a message's content (handles multimodal arrays). */
export function messageText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textPart = content.find((p: any) => p?.type === "text");
    return textPart ? textPart.text : "[Multimodal content]";
  }
  return "[Structured data]";
}

export function getLastUserMessage(prompt: any): string {
  const messages = getMessages(prompt);
  if (messages) {
    const userMsgs = messages.filter(m => m?.role === "user");
    if (userMsgs.length > 0) return messageText(userMsgs[userMsgs.length - 1].content);
    return messageText(messages[messages.length - 1]?.content);
  }
  return typeof prompt === "string" ? prompt : "";
}

export function truncateText(text: string, maxLen = 80): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen).trimEnd() + "…";
}

/** Whether a logged response carries any reasoning tokens. */
export function hasThinking(response: any): boolean {
  const parsed = parseJsonObject(response);
  const content = (parsed?.content ?? response) || "";
  const reasoning = (parsed?.reasoning_content || "").trim();
  return !!(reasoning || (typeof content === "string" && content.includes("<think>")));
}

/**
 * Group request messages plus the final logged response into user/assistant
 * turns, separating out any system prompts.
 */
export function buildTurns(
  messages: any[] | null,
  finalAssistant: { content: any; reasoning?: string; toolCalls?: any } | null,
): { systemMsgs: any[]; turns: Turn[] } {
  const systemMsgs: any[] = [];
  const turns: Turn[] = [];
  let userTurn = 0;

  const openTurn = (): Turn | null => {
    const t = turns[turns.length - 1];
    return t && t.user && !t.assistant ? t : null;
  };

  for (const m of messages || []) {
    if (m.role === "system") {
      systemMsgs.push(m);
    } else if (m.role === "user") {
      userTurn++;
      turns.push({ user: m, assistant: null, isFinal: false, userTurn });
    } else if (m.role === "assistant") {
      const open = openTurn();
      if (open) {
        open.assistant = m;
      } else {
        turns.push({ user: null, assistant: m, isFinal: false, userTurn: 0 });
      }
    }
  }

  if (finalAssistant) {
    const finalMsg: any = {
      role: "assistant",
      content: finalAssistant.content,
      reasoning_content: finalAssistant.reasoning,
    };
    if (finalAssistant.toolCalls) finalMsg.tool_calls = finalAssistant.toolCalls;
    const open = openTurn();
    if (open) {
      open.assistant = finalMsg;
      open.isFinal = true;
    } else {
      turns.push({ user: null, assistant: finalMsg, isFinal: true, userTurn: 0 });
    }
  }

  return { systemMsgs, turns };
}

// --- Conversation grouping --------------------------------------------------
// Every chat request is logged as its own row, and each row's prompt contains
// the full history so far. A follow-up turn therefore produces a row whose
// messages are a superset of the previous row's. We fold those rows back into a
// single conversation so the admin shows one entry per chat, not one per turn.

export interface InteractionLog {
  id: number;
  userId: string;
  // Embedded JSON from the backend (object); may be a string for legacy data.
  prompt: any;
  response: any;
  tokens: number;
  createdAt: number;
  conversationId?: string;
  platform?: string;
}

export interface Conversation {
  id: number; // id of the representative (latest) row
  userId: string;
  conversationId: string; // stable chat id (empty for legacy rows)
  platform: string; // origin of the latest turn (chat, claude-code, …)
  model: string; // model id used for the latest turn
  logs: InteractionLog[]; // member rows, ascending by time (one per turn)
  latest: InteractionLog; // the superset row holding the full history
  createdAt: number; // first turn
  updatedAt: number; // last turn
  totalTokens: number;
  turnCount: number;
}

export interface ReconstructedMessage {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  image?: string;
}

type Sig = { role: string; text: string }[];

/** Stable role+text fingerprint of a request's message list. */
export function messageSignature(prompt: any): Sig {
  const msgs = getMessages(prompt);
  if (!msgs) return [];
  return msgs.map(m => ({ role: m?.role, text: messageText(m?.content) }));
}

/** Whether `short` is a positional prefix of `long`. */
export function isPrefix(short: Sig, long: Sig): boolean {
  if (short.length > long.length) return false;
  for (let i = 0; i < short.length; i++) {
    const s = short[i];
    const l = long[i];
    if (!s || !l || s.role !== l.role || s.text !== l.text) return false;
  }
  return true;
}

/** Assemble a Conversation from its member rows (ascending by time). */
function toConversation(logs: InteractionLog[]): Conversation {
  const latest = logs[logs.length - 1];
  if (!latest) throw new Error("Empty conversation logs");
  const promptObj = parseJsonObject(latest.prompt);
  const firstLog = logs[0] || latest;
  return {
    id: latest.id,
    userId: latest.userId,
    conversationId: (latest.conversationId || "").trim(),
    platform: (latest.platform || "").trim(),
    model: (promptObj?.model || "").trim(),
    logs,
    latest,
    createdAt: firstLog.createdAt,
    updatedAt: latest.createdAt,
    totalTokens: logs.reduce((s, l) => s + (l.tokens || 0), 0),
    turnCount: getTurnCount(getMessages(latest.prompt)),
  };
}

/**
 * Fold per-turn log rows into conversations, one entry per chat.
 *
 * Rows carrying a `conversationId` are grouped exactly by it (bulletproof).
 * Legacy rows without one fall back to a heuristic: a row continues a
 * conversation when (same user and) the conversation's latest message signature
 * is a strict prefix of the row's. Returns conversations newest-activity first.
 */
export function groupConversations(logs: InteractionLog[]): Conversation[] {
  const ascending = [...logs].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);

  const byId = new Map<string, InteractionLog[]>();
  const legacy: InteractionLog[] = [];

  for (const log of ascending) {
    const cid = (log.conversationId || "").trim();
    if (cid) {
      const key = `${log.userId} ${cid}`;
      const bucket = byId.get(key);
      if (bucket) bucket.push(log);
      else byId.set(key, [log]);
    } else {
      legacy.push(log);
    }
  }

  const conversations: Conversation[] = [];
  for (const bucket of byId.values()) conversations.push(toConversation(bucket));

  // Heuristic chaining for rows that predate conversation ids.
  interface Chain {
    logs: InteractionLog[];
    sig: Sig;
    userId: string;
  }
  const chains: Chain[] = [];
  for (const log of legacy) {
    const sig = messageSignature(log.prompt);
    let best: Chain | null = null;
    let bestLen = -1;
    let bestTime = -1;
    for (const c of chains) {
      if (c.userId !== log.userId) continue;
      if (sig.length > c.sig.length && isPrefix(c.sig, sig)) {
        const lastLog = c.logs[c.logs.length - 1];
        const t = lastLog ? lastLog.createdAt : 0;
        if (c.sig.length > bestLen || (c.sig.length === bestLen && t > bestTime)) {
          best = c;
          bestLen = c.sig.length;
          bestTime = t;
        }
      }
    }
    if (best) {
      best.logs.push(log);
      best.sig = sig;
    } else {
      chains.push({ logs: [log], sig, userId: log.userId });
    }
  }
  for (const c of chains) conversations.push(toConversation(c.logs));

  return conversations.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Reconstruct the full turn-by-turn thread for a conversation. The single
 * (latest) row holds the whole history; intermediate assistant turns carry
 * their reasoning inline as `reasoning_content`, and the final turn's reasoning
 * comes from the logged response — so thinking is preserved for every turn.
 */
export function buildConversationTurns(conv: Conversation): { systemMsgs: any[]; turns: Turn[] } {
  const messages = getMessages(conv.latest.prompt);
  const finalParsed = parseJsonObject(conv.latest.response) || {};
  const finalContent =
    finalParsed.content ?? (typeof conv.latest.response === "string" ? conv.latest.response : "") ?? "";
  const finalReasoning = finalParsed.reasoning_content || "";

  return buildTurns(messages, {
    content: finalContent,
    reasoning: finalReasoning,
    toolCalls: finalParsed.tool_calls,
  });
}

export interface ToolCallView {
  name: string;
  /** Parsed arguments object when arguments were valid JSON, else null. */
  args: any | null;
  /** Raw argument string. */
  raw: string;
  /** A file path if the call looks like a file write. */
  path?: string;
  /** File content if the call looks like a file write. */
  content?: string;
}

/** Normalize a message's tool_calls into a view model, surfacing created files. */
export function toolCallsOf(message: any): ToolCallView[] {
  const calls = message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.map((tc: any) => {
    const name = tc?.function?.name || tc?.name || "tool";
    const raw = tc?.function?.arguments ?? tc?.arguments ?? "";
    let args: any = null;
    try {
      args = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {}
    const path =
      args?.path || args?.filePath || args?.file || args?.filename || args?.file_path || undefined;
    const content =
      args?.content ?? args?.contents ?? args?.code ?? args?.text ?? args?.fileText ?? undefined;
    return { name, args, raw: typeof raw === "string" ? raw : JSON.stringify(raw), path, content };
  });
}

/** Whether any turn in the conversation carries reasoning tokens. */
export function conversationHasThinking(conv: Conversation): boolean {
  return conv.logs.some(l => hasThinking(l.response));
}

export type PlatformCategory = "chat" | "v1" | "trace";

/**
 * Bucket a platform value: web chat, a live V1-proxy session, or an uploaded
 * local trace (marked with a `trace:` prefix at ingest time).
 */
export function platformCategory(platform: string | undefined): PlatformCategory {
  const p = (platform || "").toLowerCase();
  if (p === "" || p === "chat") return "chat";
  if (p === "trace" || p.startsWith("trace:")) return "trace";
  return "v1";
}

/** Human-friendly platform label (strips the internal `trace:` marker). */
export function platformLabel(platform: string | undefined): string {
  const p = platform || "";
  if (p === "") return "chat";
  if (p.toLowerCase().startsWith("trace:")) return p.slice("trace:".length);
  return p;
}

/** Short label for a conversation, from its first user message. */
export function conversationTitle(conv: Conversation): string {
  const msgs = getMessages(conv.latest.prompt);
  const firstUser = msgs?.find(m => m?.role === "user");
  const text = (firstUser ? messageText(firstUser.content) : "").trim();
  return text || "New chat";
}

/** Pull display text and any attached image out of a message's content. */
function extractUserContent(content: any): { text: string; image?: string } {
  if (typeof content === "string") return { text: content };
  if (Array.isArray(content)) {
    const text = content.find((p: any) => p?.type === "text")?.text ?? "";
    const image = content.find((p: any) => p?.type === "image_url")?.image_url?.url;
    return { text, image };
  }
  return { text: messageText(content) };
}

/**
 * Rebuild a flat user/assistant message list for a stored conversation so it can
 * be reloaded into the live chat. Reasoning is preserved per turn.
 */
export function conversationToMessages(conv: Conversation): ReconstructedMessage[] {
  const { turns } = buildConversationTurns(conv);
  const out: ReconstructedMessage[] = [];
  for (const turn of turns) {
    if (turn.user) {
      const { text, image } = extractUserContent(turn.user.content);
      out.push({ role: "user", content: text, image });
    }
    if (turn.assistant) {
      const { thinking, text } = splitThinking(turn.assistant.content, turn.assistant.reasoning_content);
      out.push({ role: "assistant", content: text, reasoning: thinking });
    }
  }
  return out;
}
