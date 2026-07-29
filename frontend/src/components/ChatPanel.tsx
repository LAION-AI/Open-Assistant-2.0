import { useState, useRef, useEffect, type FormEvent } from "react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Markdown } from "./Markdown";
import {
  splitThinking,
  groupConversations,
  conversationToMessages,
  conversationTitle,
  type Conversation,
  type InteractionLog,
} from "../lib/chat";
import { loadRedactor, redactMessages } from "../lib/redact";
import {
  Send,
  Image as ImageIcon,
  AlertCircle,
  Server,
  Brain,
  ChevronDown,
  Copy,
  Check,
  Plus,
  MessageSquare,
  Loader2,
  ShieldCheck,
  ExternalLink,
  Settings2,
  Sprout,
  Sparkles,
} from "lucide-react";

const BONSAI_WEBGPU_URL = "https://huggingface.co/spaces/webml-community/bonsai-webgpu-kernels";
const GEMMA_WEBGPU_URL = "https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  image?: string; // base64 string
  reasoning?: string;
}

interface User {
  id: string;
  username: string;
  email?: string | null;
  credits: number;
  byoeUrl?: string | null;
  byoeKey?: string | null;
  byoeModel?: string | null;
}

interface ChatPanelProps {
  user: User;
  onRefreshUser: () => void;
  onNavigate: (tab: string) => void;
}

function relativeTime(ts: number): string {
  const ms = ts > 9999999999 ? ts : ts * 1000;
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function ChatPanel({ user, onRefreshUser, onNavigate }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [redacting, setRedacting] = useState(false);
  const [redactStatus, setRedactStatus] = useState<string | null>(null);

  // Model selection (populated from the endpoint's /v1/models)
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string>(user.byoeModel || "");

  // Conversation sidebar / history
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  // The active chat's stable id; every turn is logged under it so the backend
  // groups them into one conversation. Selecting a past chat reuses its id so
  // new turns append to it rather than starting a new conversation.
  const [conversationId, setConversationId] = useState<string>(() => crypto.randomUUID());

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasV1Endpoint = !!user.byoeUrl?.trim();

  // Auto-scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const fetchHistory = async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch("/api/chat/history");
      if (res.ok) {
        const data = await res.json();
        // The sidebar is for web chats only; API/tool (V1) sessions live in the
        // "My Uploads" tab. Legacy rows have no platform — treat them as chat.
        const all = groupConversations((data.logs || []) as InteractionLog[]);
        setConversations(all.filter(c => c.platform === "chat" || c.platform === ""));
      }
    } catch (err) {
      // Non-fatal — the sidebar just stays empty.
      console.warn("Failed to load chat history:", err);
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory();
  }, []);

  useEffect(() => {
    if (!hasV1Endpoint) {
      setModels([]);
      setModel("");
      return;
    }

    // Load the model list for the on-the-fly model picker.
    fetch("/api/models")
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d?.models?.length) {
          setModels(d.models);
          setModel(prev => {
            if (prev && d.models.includes(prev)) return prev;
            return d.default || d.models[0] || "";
          });
        } else {
          setModels([]);
          setModel("");
        }
      })
      .catch(() => {
        setModels([]);
        setModel("");
      });
  }, [hasV1Endpoint, user.byoeUrl, user.byoeKey]);

  const newChat = () => {
    setMessages([]);
    setError(null);
    setInput("");
    setImage(null);
    setConversationId(crypto.randomUUID());
  };

  const selectConversation = (conv: Conversation) => {
    const reconstructed = conversationToMessages(conv).map(m => ({
      id: crypto.randomUUID(),
      role: m.role,
      content: m.content,
      reasoning: m.reasoning,
      image: m.image,
    }));
    setMessages(reconstructed);
    // Reuse the chat's id so follow-ups append to it. Legacy rows (no id) get a
    // fresh id since they can't be appended to retroactively.
    setConversationId(conv.conversationId || crypto.randomUUID());
    if (conv.model) setModel(conv.model); // preserve model for redaction/replies
    setError(null);
    setInput("");
    setRedactStatus(null);
  };

  // Redact PII in the current conversation on-device and persist it.
  const redactConversation = async () => {
    if (redacting || loading || messages.length === 0) return;
    setError(null);
    setRedacting(true);
    setRedactStatus("Loading privacy model…");
    try {
      const classifier = await loadRedactor(info => {
        if (info.status === "progress" && typeof info.progress === "number") {
          setRedactStatus(`Downloading model… ${Math.round(info.progress)}%`);
        }
      });
      setRedactStatus("Redacting…");
      const { messages: redacted, count } = await redactMessages(messages as any, classifier);
      setMessages(redacted as any);

      // Persist the redacted conversation (best-effort; needs a saved chat).
      await fetch("/api/chat/redact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          model,
          messages: redacted.map((m: any) => ({
            role: m.role,
            content: m.content,
            reasoning: m.reasoning,
            image: m.image,
          })),
        }),
      });
      fetchHistory();
      setRedactStatus(`Redacted ${count} PII item${count === 1 ? "" : "s"}.`);
      setTimeout(() => setRedactStatus(null), 4000);
    } catch (err: any) {
      console.error(err);
      setError(`Redaction failed: ${err?.message || err}`);
      setRedactStatus(null);
    } finally {
      setRedacting(false);
    }
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 2 * 1024 * 1024) {
        setError("Image size must be under 2MB");
        return;
      }
      setError(null);
      const reader = new FileReader();
      reader.onloadend = () => {
        setImage(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const removeImage = () => {
    setImage(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!hasV1Endpoint) {
      setError("Configure a V1-compatible endpoint before starting a chat.");
      return;
    }
    if (!input.trim() && !image) return;
    if (loading) return;

    setError(null);
    setLoading(true);

    const userMsgId = crypto.randomUUID();
    const newUserMsg: Message = {
      id: userMsgId,
      role: "user",
      content: input.trim(),
      image: image || undefined,
    };

    // Add user message to UI
    setMessages(prev => [...prev, newUserMsg]);
    setInput("");
    setImage(null);

    // Prepare message array for OpenAI API format.
    const apiMessages: any[] = [];
    messages.forEach(msg => {
      if (msg.role === "assistant") {
        // Carry reasoning along as reasoning_content so it's logged for every
        // turn. The proxy strips it before forwarding to the model.
        const { thinking, text } = splitThinking(msg.content, msg.reasoning);
        apiMessages.push({
          role: "assistant",
          content: text,
          ...(thinking ? { reasoning_content: thinking } : {}),
        });
      } else if (msg.image) {
        apiMessages.push({
          role: msg.role,
          content: [
            { type: "text", text: msg.content },
            { type: "image_url", image_url: { url: msg.image } },
          ],
        });
      } else {
        apiMessages.push({ role: msg.role, content: msg.content });
      }
    });

    // Add the current message
    if (newUserMsg.image) {
      apiMessages.push({
        role: "user",
        content: [
          { type: "text", text: newUserMsg.content },
          { type: "image_url", image_url: { url: newUserMsg.image } },
        ],
      });
    } else {
      apiMessages.push({
        role: "user",
        content: newUserMsg.content,
      });
    }

    const assistantMsgId = crypto.randomUUID();
    setStreamingId(assistantMsgId);
    setMessages(prev => [...prev, { id: assistantMsgId, role: "assistant", content: "", reasoning: "" }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Conversation-Id": conversationId,
        },
        body: JSON.stringify({
          messages: apiMessages,
          stream: true,
          ...(model ? { model } : {}),
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Server responded with status ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Response body is not readable");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // keep incomplete line in buffer

        for (const line of lines) {
          const cleanedLine = line.trim();
          if (!cleanedLine) continue;

          if (cleanedLine.startsWith("data: ")) {
            const dataStr = cleanedLine.slice(6);
            if (dataStr === "[DONE]") {
              break;
            }

            try {
              const parsed = JSON.parse(dataStr);
              const chunk = parsed.choices?.[0]?.delta?.content || "";
              const reasoningChunk = parsed.choices?.[0]?.delta?.reasoning_content || "";
              if (chunk || reasoningChunk) {
                setMessages(prev =>
                  prev.map(msg =>
                    msg.id === assistantMsgId
                      ? {
                          ...msg,
                          content: msg.content + chunk,
                          reasoning: (msg.reasoning || "") + reasoningChunk,
                        }
                      : msg
                  )
                );
              }
            } catch (e) {
              // Ignore parse errors from malformed stream lines
            }
          }
        }
      }

      // Refresh endpoint settings and the conversation sidebar after a successful response.
      onRefreshUser();
      fetchHistory();
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to fetch response");
      // Remove empty assistant message if it failed before streaming
      setMessages(prev => prev.filter(msg => msg.id !== assistantMsgId));
    } finally {
      setLoading(false);
      setStreamingId(null);
    }
  };

  const toggleThinking = (id: string) => {
    setExpandedThinking(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const copyMessage = (id: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(prev => (prev === id ? null : prev)), 1500);
    });
  };

  return (
    <div className="flex h-full min-w-0 bg-card/30 backdrop-blur-md rounded-xl sm:rounded-2xl border border-border/70 overflow-hidden shadow-xl">
      {/* Conversation Sidebar */}
      <aside className="hidden md:flex w-72 flex-shrink-0 flex-col border-r border-border/60 bg-card/40">
        <div className="p-3 border-b border-border/50">
          <Button
            onClick={newChat}
            className="w-full h-10 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white gap-2 text-sm font-semibold shadow-sm"
          >
            <Plus className="w-4 h-4" />
            <span>New chat</span>
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <div className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
            Your conversations
          </div>

          {historyLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Loading…</span>
            </div>
          ) : conversations.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground/70 leading-relaxed">
              No conversations yet. Start chatting and they'll appear here.
            </div>
          ) : (
            conversations.map(conv => {
              const active = conv.conversationId && conv.conversationId === conversationId;
              return (
                <button
                  key={conv.id}
                  onClick={() => selectConversation(conv)}
                  className={`w-full text-left px-3 py-2.5 rounded-xl transition-all group ${
                    active
                      ? "bg-indigo-500/15 border border-indigo-500/30"
                      : "border border-transparent hover:bg-muted/50"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <MessageSquare
                      className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${active ? "text-indigo-400" : "text-muted-foreground/60"}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className={`text-xs font-medium truncate ${active ? "text-foreground" : "text-foreground/85"}`}>
                        {conversationTitle(conv)}
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground/60">
                        <span>{conv.turnCount} {conv.turnCount === 1 ? "turn" : "turns"}</span>
                        <span>·</span>
                        <span>{relativeTime(conv.updatedAt)}</span>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* Main Chat Column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Panel Header */}
        <div className="flex min-w-0 items-center justify-between gap-2 px-3 sm:px-6 py-2.5 sm:py-3.5 border-b border-border/70 bg-card/50">
          <div className="flex items-center gap-2 min-w-0">
            <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${hasV1Endpoint ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/40"}`}></div>
            <span className="font-semibold text-sm text-foreground truncate">
              {messages.length > 0 ? "Conversation" : "New chat"}
            </span>
            {/* New chat button for mobile (sidebar hidden) */}
            <Button
              variant="ghost"
              size="icon"
              onClick={newChat}
              className="md:hidden h-7 w-7 text-muted-foreground"
              title="New chat"
            >
              <Plus className="w-4 h-4" />
            </Button>
          </div>
          <div className="flex min-w-0 items-center gap-1.5 sm:gap-3 text-xs font-medium flex-shrink">
            {messages.length > 0 && (
              <button
                onClick={redactConversation}
                disabled={redacting || loading}
                title={redactStatus || "Redact PII in this conversation (on-device) and save"}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-violet-500/10 text-violet-400 border border-violet-500/20 hover:bg-violet-500/20 transition-colors disabled:opacity-50"
              >
                {redacting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                <span className="hidden sm:inline">{redacting ? "Redacting…" : "Redact"}</span>
              </button>
            )}
            {models.length > 0 && (
              <select
                value={model}
                onChange={e => setModel(e.target.value)}
                title="Model — switch on the fly"
                className="h-8 min-w-0 w-24 min-[400px]:w-28 sm:w-auto sm:max-w-[200px] rounded-lg border border-border/70 bg-background/60 px-1.5 sm:px-2 text-[11px] sm:text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {models.map(m => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}
            {hasV1Endpoint && (
              <div className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                <Server className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">V1 endpoint</span>
              </div>
            )}
          </div>
        </div>

        {/* Messages Scroll Area */}
        <div className="flex-1 min-h-0 min-w-0 px-3 sm:px-6 py-4 sm:py-6 overflow-x-hidden overflow-y-auto overscroll-contain space-y-4 sm:space-y-6">
          {messages.length === 0 && !hasV1Endpoint ? (
            <div className="h-full flex flex-col items-center justify-center p-3 sm:p-8">
              <div className="w-full max-w-xl overflow-hidden rounded-3xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 via-card/80 to-indigo-500/10 p-5 text-left shadow-xl sm:p-7">
                <div className="mb-5 flex items-start gap-3">
                  <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-400">
                    <Sprout className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-400">
                      On-device WebGPU
                    </p>
                    <h3 className="text-lg font-bold text-foreground sm:text-xl">
                      Choose a model that runs in your browser
                    </h3>
                  </div>
                </div>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Launch a browser-native runner in an isolated tab or connect an OpenAI V1-compatible endpoint.
                  WebGPU runners cache their weights locally, and inference stays on your device.
                </p>
                <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
                  <a
                    href={BONSAI_WEBGPU_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="group flex min-h-16 items-center gap-3 rounded-xl bg-emerald-600 px-4 py-3 text-left text-white shadow-lg shadow-emerald-600/15 transition hover:bg-emerald-500"
                  >
                    <Sprout className="h-5 w-5 flex-shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">Bonsai 27B 1-bit</span>
                      <span className="block text-[10px] font-medium text-white/75">3.80 GB · browser WebGPU</span>
                    </span>
                    <ExternalLink className="h-3.5 w-3.5 flex-shrink-0 opacity-70 transition group-hover:opacity-100" />
                  </a>
                  <a
                    href={GEMMA_WEBGPU_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="group flex min-h-16 items-center gap-3 rounded-xl bg-indigo-600 px-4 py-3 text-left text-white shadow-lg shadow-indigo-600/15 transition hover:bg-indigo-500"
                  >
                    <Sparkles className="h-5 w-5 flex-shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">Gemma 4 E2B</span>
                      <span className="block text-[10px] font-medium text-white/75">2.46 GB · browser WebGPU</span>
                    </span>
                    <ExternalLink className="h-3.5 w-3.5 flex-shrink-0 opacity-70 transition group-hover:opacity-100" />
                  </a>
                </div>
              </div>
            </div>
          ) : messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-4 sm:p-8 space-y-4 max-w-md mx-auto">
              <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 text-indigo-400">
                <Server className="w-6 h-6" />
              </div>
              <h3 className="font-bold text-lg text-foreground">Crowdsource AI Data</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Start chatting. If configured, your queries will run through your custom LLM endpoint, and conversations are safely collected for the training of future open models.
              </p>
            </div>
          ) : (
            messages
              .filter(msg => msg.role !== "assistant" || msg.content !== "" || msg.reasoning !== "")
              .map(msg => {
                const { thinking, text } = splitThinking(msg.content, msg.reasoning);
                const isStreaming = streamingId === msg.id;
                // Auto-open the reasoning panel while it streams; otherwise honor
                // the user's manual toggle (collapsed by default once finished).
                const thinkingOpen = isStreaming ? !text : expandedThinking.has(msg.id);
                const stillThinking = isStreaming && !!thinking && !text;

                if (msg.role === "user") {
                  return (
                    <div key={msg.id} className="flex justify-end">
                      <div className="max-w-[92%] sm:max-w-[80%] min-w-0 break-words rounded-2xl rounded-br-md bg-indigo-600 text-white px-3.5 sm:px-4 py-3 text-sm leading-relaxed shadow-md">
                        {msg.image && (
                          <div className="mb-2 max-w-[200px] overflow-hidden rounded-lg border border-white/10">
                            <img src={msg.image} alt="Uploaded payload" className="w-full h-auto object-cover" />
                          </div>
                        )}
                        {msg.content && <div className="whitespace-pre-wrap break-words">{msg.content}</div>}
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={msg.id} className="flex flex-col items-start gap-1.5 group">
                    {thinking && (
                      <div className="w-full max-w-[94%] sm:max-w-[85%]">
                        <button
                          onClick={() => toggleThinking(msg.id)}
                          className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-violet-500/8 border border-violet-500/20 hover:bg-violet-500/15 transition-all text-left"
                        >
                          <div className="w-5 h-5 rounded-md bg-violet-500/15 flex items-center justify-center flex-shrink-0">
                            <Brain className={`w-3 h-3 text-violet-400 ${stillThinking ? "animate-pulse" : ""}`} />
                          </div>
                          <span className="text-[11px] font-semibold text-violet-300 flex-1">
                            {stillThinking ? "Thinking…" : "Thinking Process"}
                          </span>
                          <span className="text-[9px] text-violet-400/60 font-mono">
                            {thinking.length.toLocaleString()} chars
                          </span>
                          <ChevronDown
                            className={`w-3.5 h-3.5 text-violet-400/60 transition-transform ${thinkingOpen ? "rotate-180" : ""}`}
                          />
                        </button>
                        {thinkingOpen && (
                          <div className="mt-1.5 px-3.5 py-3 bg-violet-950/15 border border-violet-500/15 border-l-[3px] border-l-violet-500/40 rounded-xl">
                            <div className="text-muted-foreground/80 max-h-[320px] overflow-y-auto">
                              <Markdown compact>{thinking}</Markdown>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {(text || (!thinking && isStreaming)) && (
                      <div className="max-w-[94%] sm:max-w-[80%] min-w-0 break-words rounded-2xl rounded-bl-md bg-muted text-foreground border border-border/50 px-3.5 sm:px-4 py-3 shadow-md relative">
                        <Markdown>{text}</Markdown>
                        {isStreaming && !text && (
                          <span className="inline-block w-1.5 h-4 align-middle bg-muted-foreground/60 animate-pulse rounded-sm" />
                        )}
                        {!isStreaming && text && (
                          <button
                            onClick={() => copyMessage(msg.id, text)}
                            className="absolute -bottom-3 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 px-2 py-1 rounded-lg bg-card border border-border/60 text-[10px] text-muted-foreground hover:text-foreground shadow-sm"
                            title="Copy response"
                          >
                            {copiedId === msg.id ? (
                              <><Check className="w-3 h-3 text-emerald-400" /><span>Copied</span></>
                            ) : (
                              <><Copy className="w-3 h-3" /><span>Copy</span></>
                            )}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
          )}
          {loading && !messages.some(m => m.id === streamingId && (m.content || m.reasoning)) && (
            <div className="flex justify-start">
              <div className="bg-muted text-foreground rounded-2xl rounded-bl-none border border-border/50 px-4 py-3 text-sm leading-relaxed shadow-md flex items-center gap-2">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.3s]"></span>
                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.15s]"></span>
                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce"></span>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Error / Alert Display */}
        {error && (
          <div className="px-3 sm:px-6 py-2 bg-destructive/10 border-t border-b border-destructive/20 text-destructive text-xs flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Redaction status */}
        {redactStatus && !error && (
          <div className="px-3 sm:px-6 py-2 bg-violet-500/10 border-t border-b border-violet-500/20 text-violet-300 text-xs flex items-center gap-2">
            <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" />
            <span>{redactStatus}</span>
          </div>
        )}

        {/* Image Upload Preview */}
        {image && (
          <div className="px-3 sm:px-6 py-3 bg-muted/30 border-t border-border/50 flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-3">
              <div className="relative w-12 h-12 rounded-lg border border-border overflow-hidden bg-background">
                <img src={image} alt="Upload preview" className="w-full h-full object-cover" />
              </div>
              <span className="text-xs text-muted-foreground">Payload image attached</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={removeImage}
              className="text-xs text-muted-foreground hover:text-destructive"
            >
              Remove
            </Button>
          </div>
        )}

        {/* Input Form Area */}
        {hasV1Endpoint ? (
          <form
            onSubmit={handleSubmit}
            className="px-3 sm:px-6 py-3 sm:py-4 border-t border-border/70 bg-card/50 flex min-w-0 items-end gap-2 sm:gap-3"
          >
          <input
            type="file"
            accept="image/*"
            ref={fileInputRef}
            onChange={handleImageChange}
            className="hidden"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => fileInputRef.current?.click()}
            className="h-10 w-10 flex-shrink-0 rounded-xl hover:bg-muted/80"
            title="Attach Image Payload"
          >
            <ImageIcon className="w-4 h-4 text-muted-foreground" />
          </Button>

          <Textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask Open Assistant anything..."
            className="min-h-[40px] min-w-0 max-h-[160px] resize-none py-2 px-3 rounded-xl border border-input focus-visible:ring-1 focus-visible:ring-ring flex-1"
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
          />

          <Button
            type="submit"
            disabled={(!input.trim() && !image) || loading}
            className="h-10 w-10 flex-shrink-0 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-indigo-600/45 disabled:text-white/60"
          >
            <Send className="w-4 h-4" />
          </Button>
          </form>
        ) : (
          <div className="border-t border-border/70 bg-card/50 px-3 py-3 sm:px-6 sm:py-4">
            <div className="grid gap-2 sm:grid-cols-2">
              <a
                href={BONSAI_WEBGPU_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 text-xs font-semibold text-white transition hover:bg-emerald-500"
              >
                <Sprout className="h-4 w-4" />
                Run Bonsai in browser
                <ExternalLink className="h-3.5 w-3.5 opacity-70" />
              </a>
              <a
                href={GEMMA_WEBGPU_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-3 text-xs font-semibold text-white transition hover:bg-indigo-500"
              >
                <Sparkles className="h-4 w-4" />
                Run Gemma 4 in browser
                <ExternalLink className="h-3.5 w-3.5 opacity-70" />
              </a>
              <Button
                type="button"
                variant="outline"
                onClick={() => onNavigate("settings-byoe")}
                className="h-10 rounded-xl text-xs font-semibold sm:col-span-2"
              >
                <Settings2 className="mr-2 h-4 w-4" />
                Configure a V1 endpoint instead
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
