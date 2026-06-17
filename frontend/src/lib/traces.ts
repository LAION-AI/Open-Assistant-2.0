// Parsing of agent "trace" files (Claude Code / VS Code / OpenAI-style session
// logs) into a normalized message list we can upload as a conversation. Kept
// free of React/DOM so it can be unit-tested with `bun test`.

import { groupConversations, type Conversation, type InteractionLog } from "./chat";

export interface TraceMessage {
  role: "user" | "assistant" | "system" | string;
  content: string;
  reasoning?: string;
  tool_calls?: any[];
}

export interface ParsedTrace {
  ok: boolean;
  fileName: string;
  platform: string;
  model: string;
  messages: TraceMessage[];
  turnCount: number;
  title: string;
  error?: string;
}

/** Guess which tool produced a trace from its path/name and content hints. */
export function detectTracePlatform(pathOrName: string, text: string): string {
  const p = pathOrName.toLowerCase();
  if (p.includes(".claude") || p.includes("claude-code") || p.includes("claude_code")) return "claude-code";
  if (p.includes("copilot") || p.includes("vscode") || p.includes("vs-code") || p.includes("chatsessions")) return "vscode";
  if (p.includes("cursor")) return "cursor";
  if (p.includes("opencode")) return "opencode";
  // Content hints (Claude Code session lines carry these fields).
  if (/"sessionId"|"cwd"|"toolUseResult"|"requestId"/.test(text)) return "claude-code";
  return "trace";
}

/** Flatten a message's content (string or block array) into text/reasoning/tools. */
function flattenContent(content: any): { text: string; reasoning: string; tools: any[] } {
  if (typeof content === "string") return { text: content, reasoning: "", tools: [] };
  if (Array.isArray(content)) {
    let text = "";
    let reasoning = "";
    const tools: any[] = [];
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if ((b.type === "text" || b.type === "output_text") && typeof b.text === "string") {
        text += (text ? "\n" : "") + b.text;
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        reasoning += (reasoning ? "\n" : "") + b.thinking;
      } else if (b.type === "tool_use" || b.type === "tool_call") {
        const args = b.input ?? b.arguments ?? {};
        tools.push({
          id: b.id,
          type: "function",
          function: { name: b.name || b.tool || "tool", arguments: typeof args === "string" ? args : JSON.stringify(args) },
        });
      } else if (b.type === "tool_result") {
        const r = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        text += (text ? "\n" : "") + `↳ tool result: ${r}`;
      }
    }
    return { text, reasoning, tools };
  }
  if (content == null) return { text: "", reasoning: "", tools: [] };
  return { text: typeof content === "object" ? JSON.stringify(content) : String(content), reasoning: "", tools: [] };
}

/** Extract assistant text + tool calls from a VS Code chat `response` array. */
function extractVscResponse(response: any): { text: string; tools: any[] } {
  if (typeof response === "string") return { text: response, tools: [] };
  if (!Array.isArray(response)) return { text: "", tools: [] };
  let text = "";
  const tools: any[] = [];
  for (const part of response) {
    if (typeof part === "string") {
      text += (text ? "\n" : "") + part;
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (typeof part.value === "string") text += (text ? "\n" : "") + part.value;
    else if (part.content && typeof part.content.value === "string") text += (text ? "\n" : "") + part.content.value;
    const kind = typeof part.kind === "string" ? part.kind.toLowerCase() : "";
    if (kind.includes("tool") || part.toolId || part.toolCallId) {
      const name = part.toolId || part.toolName || part.name || "tool";
      const args = part.toolSpecificData ?? part.invocationMessage ?? part.resultDetails ?? {};
      tools.push({
        type: "function",
        function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
      });
    }
  }
  return { text, tools };
}

/** Parse VS Code's chat session shape: { v: { requests: [{ message, response }] } }. */
function parseVscChat(whole: any): { model: string; messages: TraceMessage[] } {
  const v = whole.v || {};
  const meta = v.inputState?.selectedModel?.metadata;
  const model = meta?.family || meta?.name || meta?.id || "";
  const messages: TraceMessage[] = [];
  for (const req of v.requests || []) {
    const userText = typeof req?.message?.text === "string" ? req.message.text : flattenContent(req?.message?.parts).text;
    messages.push({ role: "user", content: userText || "" });
    const { text, tools } = extractVscResponse(req?.response);
    const am: TraceMessage = { role: "assistant", content: text };
    if (tools.length) am.tool_calls = tools;
    messages.push(am);
  }
  return { model, messages };
}

function toMessage(role: string, content: any): TraceMessage {
  const { text, reasoning, tools } = flattenContent(content);
  const m: TraceMessage = { role, content: text };
  if (reasoning) m.reasoning = reasoning;
  if (tools.length) m.tool_calls = tools;
  return m;
}

/** Extract a {role, content} message from one parsed JSONL entry, if present. */
function messageFromEntry(obj: any): { role: string; content: any } | null {
  if (!obj || typeof obj !== "object") return null;
  // Claude Code / many formats nest the actual message.
  const msg = obj.message && typeof obj.message === "object" ? obj.message : obj;
  if (typeof msg.role === "string" && msg.content !== undefined) {
    return { role: msg.role, content: msg.content };
  }
  // Some formats use type=user/assistant with content at top level.
  if ((obj.type === "user" || obj.type === "assistant") && obj.content !== undefined) {
    return { role: obj.type, content: obj.content };
  }
  return null;
}

/**
 * Parse a trace file into a normalized conversation. Supports:
 *  - OpenAI-style JSON: { model, messages: [...] }
 *  - a JSON array of messages
 *  - JSONL where each line is a message or wraps one in `message`
 *    (Claude Code, Copilot, etc.)
 */
export function parseTrace(fileName: string, path: string, text: string): ParsedTrace {
  const platform = detectTracePlatform(path || fileName, text);
  const messages: TraceMessage[] = [];
  let model = "";
  const trimmed = (text || "").trim();

  let whole: any = null;
  try {
    whole = JSON.parse(trimmed);
  } catch {}

  if (whole && !Array.isArray(whole) && whole.v && Array.isArray(whole.v.requests)) {
    // VS Code / Copilot chat session.
    const vsc = parseVscChat(whole);
    model = vsc.model;
    messages.push(...vsc.messages);
  } else if (whole && !Array.isArray(whole) && Array.isArray(whole.messages)) {
    model = typeof whole.model === "string" ? whole.model : "";
    for (const m of whole.messages) {
      const mm = messageFromEntry(m);
      if (mm) messages.push(toMessage(mm.role, mm.content));
    }
  } else if (Array.isArray(whole)) {
    for (const m of whole) {
      const mm = messageFromEntry(m);
      if (mm) messages.push(toMessage(mm.role, mm.content));
    }
  } else {
    // JSONL — one JSON object per line.
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let obj: any;
      try {
        obj = JSON.parse(t);
      } catch {
        continue;
      }
      if (!model) {
        const mdl = obj.model || obj.message?.model;
        if (typeof mdl === "string") model = mdl;
      }
      const mm = messageFromEntry(obj);
      if (mm) messages.push(toMessage(mm.role, mm.content));
    }
  }

  const filtered = messages.filter(
    m => (m.role === "user" || m.role === "assistant" || m.role === "system") && (m.content || m.tool_calls?.length || m.reasoning),
  );
  const firstUser = filtered.find(m => m.role === "user");
  const title = (firstUser?.content || fileName).replace(/\s+/g, " ").trim().slice(0, 80) || fileName;
  const turnCount = Math.max(filtered.filter(m => m.role === "user").length, 1);
  const ok = filtered.length > 0;

  return {
    ok,
    fileName,
    platform,
    model,
    messages: filtered,
    turnCount,
    title,
    error: ok ? undefined : "No conversation messages found",
  };
}

/**
 * Wrap a parsed trace as a (synthetic) Conversation so it can be previewed with
 * the same renderer used for stored conversations — without uploading it.
 */
export function traceToConversation(trace: ParsedTrace): Conversation {
  const messages = trace.messages;
  let history = messages.slice();
  let finalAssistant: any = { role: "assistant", content: "" };
  if (messages.length && messages[messages.length - 1].role === "assistant") {
    finalAssistant = messages[messages.length - 1];
    history = messages.slice(0, -1);
  }
  const log: InteractionLog = {
    id: 0,
    userId: "",
    conversationId: "preview",
    platform: trace.platform,
    prompt: { model: trace.model || "trace", messages: history },
    response: {
      role: "assistant",
      content: finalAssistant.content || "",
      reasoning_content: finalAssistant.reasoning || "",
      ...(finalAssistant.tool_calls ? { tool_calls: finalAssistant.tool_calls } : {}),
    },
    tokens: 0,
    createdAt: Math.floor(Date.now() / 1000),
  };
  return groupConversations([log])[0];
}
