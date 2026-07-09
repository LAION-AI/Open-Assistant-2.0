import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { ConversationThread } from "./ConversationThread";
import { TraceUpload } from "./TraceUpload";
import {
  groupConversations,
  conversationTitle,
  conversationHasThinking,
  truncateText,
  getLastUserMessage,
  platformCategory,
  buildConversationTurns,
  getMessages,
  messageText,
  parseJsonObject,
  type Conversation,
  type InteractionLog,
} from "../lib/chat";
import { PlatformBadge } from "./PlatformBadge";
import { loadRedactor, redactMessages, redactSource } from "../lib/redact";
import { sourceOf, sourceFileName } from "../lib/unified";
import {
  Database,
  MessageSquare,
  Code,
  Brain,
  Calendar,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Trash2,
  Download,
  AlertCircle,
  Loader2,
  Boxes,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";

type Filter = "all" | "chat" | "v1" | "trace" | "pip-library";

function formatTime(ts: number) {
  return new Date(ts > 9999999999 ? ts : ts * 1000).toLocaleString();
}

export function UploadsPanel() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [deleting, setDeleting] = useState<number | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/chat/history");
      if (!res.ok) throw new Error(`Failed to load uploads: ${res.statusText}`);
      const data = await res.json();
      setConversations(groupConversations((data.logs || []) as InteractionLog[]));
    } catch (err: any) {
      setError(err.message || "Failed to load uploads");
    } finally {
      setLoading(false);
    }
  };

  const [redacting, setRedacting] = useState<number | null>(null);
  const [redactingAll, setRedactingAll] = useState(false);

  const isRedacted = (conv: Conversation): boolean => {
    const promptStr = typeof conv.latest.prompt === "string" ? conv.latest.prompt : JSON.stringify(conv.latest.prompt || "");
    const responseStr = typeof conv.latest.response === "string" ? conv.latest.response : JSON.stringify(conv.latest.response || "");
    return promptStr.includes("[REDACTED_") || responseStr.includes("[REDACTED_");
  };

  const redactOne = async (conv: Conversation, classifier: any) => {
    const messages = getMessages(conv.latest.prompt) || [];
    const responseParsed = parseJsonObject(conv.latest.response);

    // 1:1 mapping (no dropping/splitting) so per-row slicing below stays
    // aligned; tool linkage and images ride along so the redacted rewrite
    // stays as lossless as the original unified row.
    const history: any[] = messages.map((m: any) => {
      const images = Array.isArray(m.images)
        ? m.images
        : Array.isArray(m.content)
          ? m.content.map((p: any) => p?.image_url?.url).filter(Boolean)
          : [];
      return {
        role: m.role || "user",
        content: typeof m.content === "string" ? m.content : messageText(m.content),
        reasoning: m.reasoning_content || m.reasoning || "",
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.name ? { name: m.name } : {}),
        ...(images.length ? { images } : {}),
      };
    });

    if (responseParsed) {
      history.push({
        role: "assistant",
        content: responseParsed.content || "",
        reasoning: responseParsed.reasoning_content || responseParsed.reasoning || "",
        ...(responseParsed.tool_calls ? { tool_calls: responseParsed.tool_calls } : {}),
      });
    }

    const { messages: redactedHistory } = await redactMessages(history, classifier);

    // The row may carry the original trace file verbatim — scrub it in the
    // same pass and send it along; the server drops any stored source that
    // isn't re-supplied, so unredacted text can't survive the rewrite.
    const storedSource = sourceOf(conv.latest.prompt);
    const redactedSource = storedSource ? (await redactSource(storedSource, classifier)).source : undefined;

    if (conv.conversationId) {
      const res = await fetch("/api/chat/redact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: conv.conversationId,
          messages: redactedHistory,
          model: conv.model,
          ...(redactedSource ? { source: redactedSource } : {}),
        }),
      });
      if (!res.ok) {
        throw new Error(`Failed to save redacted conversation: ${res.statusText}`);
      }
    } else {
      for (const log of conv.logs) {
        if (!log) continue;
        const logMsgs = getMessages(log.prompt) || [];
        const logMsgCount = logMsgs.length;
        const subHistory = redactedHistory.slice(0, logMsgCount + 1);
        const logSource = sourceOf(log.prompt);
        const logRedactedSource = logSource ? (await redactSource(logSource, classifier)).source : undefined;

        const res = await fetch("/api/chat/redact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            logId: log.id,
            messages: subHistory,
            model: conv.model,
            ...(logRedactedSource ? { source: logRedactedSource } : {}),
          }),
        });
        if (!res.ok) {
          throw new Error(`Failed to save redacted log row ${log.id}: ${res.statusText}`);
        }
      }
    }
  };

  // Reconstruct and download the original source-format file from a stored
  // row (redacted if the row was redacted) — the back-conversion path.
  const downloadSource = (conv: Conversation) => {
    const source = sourceOf(conv.latest.prompt);
    if (!source) return;
    const blob = new Blob([source.text], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = sourceFileName(source);
    a.click();
    URL.revokeObjectURL(url);
  };

  const redactConversation = async (conv: Conversation) => {
    if (!confirm("Run on-device PII redact filter on this conversation?")) return;
    setRedacting(conv.id);
    try {
      const classifier = await loadRedactor();
      await redactOne(conv, classifier);
      await fetchData();
    } catch (err: any) {
      setError(err.message || "Failed to redact");
    } finally {
      setRedacting(null);
    }
  };

  const redactGroup = async (targets: Conversation[]) => {
    const unredacted = targets.filter(c => !isRedacted(c));
    if (unredacted.length === 0) return;
    if (!confirm(`Run on-device PII redact filter on all ${unredacted.length} unredacted conversations in this view?`)) {
      return;
    }
    setRedactingAll(true);
    setError(null);
    try {
      const classifier = await loadRedactor();
      for (const conv of unredacted) {
        setRedacting(conv.id);
        await redactOne(conv, classifier);
      }
      await fetchData();
    } catch (err: any) {
      setError(err.message || "Failed to redact group");
    } finally {
      setRedacting(null);
      setRedactingAll(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const visible = conversations.filter(c => (filter === "all" ? true : platformCategory(c.platform) === filter));

  const totalTokens = conversations.reduce((a, c) => a + c.totalTokens, 0);
  const chatCount = conversations.filter(c => platformCategory(c.platform) === "chat").length;
  const v1Count = conversations.filter(c => platformCategory(c.platform) === "v1").length;
  const traceCount = conversations.filter(c => platformCategory(c.platform) === "trace").length;
  const pipLibCount = conversations.filter(c => platformCategory(c.platform) === "pip-library").length;

  const deleteConversation = async (conv: Conversation) => {
    if (!confirm("Delete this conversation permanently? This removes it from the dataset.")) return;
    setDeleting(conv.id);
    try {
      if (conv.conversationId) {
        await fetch("/api/chat/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: conv.conversationId }),
        });
      } else {
        // Legacy rows have no conversation id — delete each member row by id.
        for (const l of conv.logs) {
          await fetch("/api/chat/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: l.id }),
          });
        }
      }
      await fetchData();
    } catch (err: any) {
      setError(err.message || "Failed to delete");
    } finally {
      setDeleting(null);
    }
  };

  const FilterBtn = ({ value, label }: { value: Filter; label: string }) => (
    <button
      onClick={() => setFilter(value)}
      className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
        filter === value ? "bg-background/80 text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Trace uploader */}
      <TraceUpload onUploaded={fetchData} />

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="bg-card/45 border-border/80 backdrop-blur-md">
          <CardContent className="p-6 flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Conversations</span>
              <p className="text-3xl font-extrabold text-indigo-400">{conversations.length}</p>
            </div>
            <div className="w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
              <MessageSquare className="w-6 h-6" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/45 border-border/80 backdrop-blur-md">
          <CardContent className="p-6 flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">V1 Proxy / Traces</span>
              <p className="text-3xl font-extrabold text-sky-400">{v1Count + traceCount + pipLibCount}</p>
            </div>
            <div className="w-12 h-12 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400">
              <Code className="w-6 h-6" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/45 border-border/80 backdrop-blur-md">
          <CardContent className="p-6 flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Tokens</span>
              <p className="text-3xl font-extrabold text-amber-400">{totalTokens.toLocaleString()}</p>
            </div>
            <div className="w-12 h-12 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
              <Database className="w-6 h-6" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="bg-card/40 border-border/80 backdrop-blur-md shadow-2xl overflow-hidden">
        <CardHeader className="border-b border-border/50 bg-card/50 flex flex-row items-center justify-between py-4">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-xl font-bold">
              <Boxes className="w-5 h-5 text-indigo-400" />
              <span>My Uploads</span>
            </CardTitle>
            <CardDescription className="text-xs">
              Everything you've contributed — web chats and external tool (V1 API) sessions. Review or delete any of it.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {visible.some(c => !isRedacted(c)) && (
              <button
                onClick={() => redactGroup(visible)}
                disabled={redactingAll || loading}
                className="px-3 py-1.5 rounded-xl border border-indigo-500/20 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 text-xs font-semibold flex items-center gap-1.5 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50"
                title="Redact all unredacted conversations in this group"
              >
                {redactingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldAlert className="w-3.5 h-3.5" />}
                <span>Redact Group ({visible.filter(c => !isRedacted(c)).length})</span>
              </button>
            )}
            <button
              onClick={fetchData}
              disabled={loading}
              className="p-2 rounded-xl hover:bg-muted text-muted-foreground hover:text-foreground transition-all active:scale-95 disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </CardHeader>

        <div className="flex gap-1 border-b border-border/40 bg-muted/40 p-1">
          <FilterBtn value="all" label={`All (${conversations.length})`} />
          <FilterBtn value="chat" label={`Chat (${chatCount})`} />
          <FilterBtn value="v1" label={`V1 Proxy (${v1Count})`} />
          <FilterBtn value="pip-library" label={`V1 Local Proxy (${pipLibCount})`} />
          <FilterBtn value="trace" label={`Local traces (${traceCount})`} />
        </div>

        <CardContent className="p-0">
          {error && (
            <div className="p-4 bg-destructive/10 border-b border-destructive/20 text-destructive text-xs flex items-center gap-2.5">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="p-12 flex flex-col items-center justify-center gap-3 text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin" />
              <span className="text-[10px] uppercase tracking-wider font-semibold">Loading your uploads…</span>
            </div>
          ) : visible.length === 0 ? (
            <div className="p-12 text-center text-xs text-muted-foreground">Nothing here yet.</div>
          ) : (
            <div className="divide-y divide-border/40">
              {visible.map(conv => {
                const open = expanded === conv.id;
                return (
                  <div key={conv.id}>
                    <div
                      onClick={() => setExpanded(open ? null : conv.id)}
                      className="px-5 py-3.5 flex items-center justify-between cursor-pointer select-none hover:bg-muted/10 transition-all"
                    >
                      <div className="flex items-center gap-3 text-xs min-w-0 flex-1">
                        <PlatformBadge platform={conv.platform} />
                        {conv.model && (
                          <div
                            className="px-2 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/20 text-[10px] text-indigo-400 font-medium font-mono truncate max-w-[160px] flex-shrink-0"
                            title={conv.model}
                          >
                            {conv.model}
                          </div>
                        )}
                        <div className="flex items-center gap-1 text-[10px] text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 px-1.5 py-0.5 rounded-full flex-shrink-0">
                          <span>{conv.turnCount} {conv.turnCount === 1 ? "turn" : "turns"}</span>
                        </div>
                        {conversationHasThinking(conv) && (
                          <div className="flex items-center gap-1 text-[10px] text-violet-400 bg-violet-500/10 border border-violet-500/20 px-1.5 py-0.5 rounded-full flex-shrink-0">
                            <Brain className="w-3 h-3" />
                          </div>
                        )}
                        {isRedacted(conv) && (
                          <div className="flex items-center gap-1 text-[10px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded-full flex-shrink-0">
                            <ShieldCheck className="w-3 h-3" />
                            <span>Redacted</span>
                          </div>
                        )}
                        <div className="text-muted-foreground truncate flex-1 min-w-0 pr-2 font-medium">
                          {truncateText(conversationTitle(conv) || getLastUserMessage(conv.latest.prompt), 80)}
                        </div>
                        <div className="flex items-center gap-1 text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full flex-shrink-0">
                          <Database className="w-3 h-3" />
                          <span>{conv.totalTokens} tk</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 pl-3 flex-shrink-0 text-muted-foreground">
                        <div className="hidden sm:flex items-center gap-1 text-xs">
                          <Calendar className="w-3.5 h-3.5" />
                          <span>{formatTime(conv.updatedAt)}</span>
                        </div>
                        {sourceOf(conv.latest.prompt) && (
                          <button
                            onClick={e => { e.stopPropagation(); downloadSource(conv); }}
                            className="p-1.5 rounded-lg hover:bg-sky-500/10 hover:text-sky-400 transition-colors text-muted-foreground/60"
                            title="Download original trace file (source format)"
                          >
                            <Download className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={e => { e.stopPropagation(); redactConversation(conv); }}
                          disabled={redacting === conv.id || isRedacted(conv)}
                          className={`p-1.5 rounded-lg transition-colors ${
                            isRedacted(conv)
                              ? "text-emerald-500 hover:bg-emerald-500/10 cursor-default"
                              : "hover:bg-indigo-500/10 hover:text-indigo-400 text-muted-foreground/60"
                          }`}
                          title={isRedacted(conv) ? "Protected (PII Redacted)" : "Redact PII on-device"}
                        >
                          {redacting === conv.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : isRedacted(conv) ? (
                            <ShieldCheck className="w-4 h-4" />
                          ) : (
                            <ShieldAlert className="w-4 h-4" />
                          )}
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); deleteConversation(conv); }}
                          disabled={deleting === conv.id}
                          className="p-1.5 rounded-lg hover:bg-destructive/10 hover:text-destructive transition-colors"
                          title="Delete conversation"
                        >
                          {deleting === conv.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                        </button>
                        {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </div>
                    </div>

                    {open && (
                      <div className="px-5 pb-5 pt-1 bg-muted/10 border-t border-border/20">
                        <ConversationThread conv={conv} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
