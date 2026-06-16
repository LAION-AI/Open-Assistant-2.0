import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { ConversationThread } from "./ConversationThread";
import {
  groupConversations,
  conversationTitle,
  conversationHasThinking,
  truncateText,
  getLastUserMessage,
  type Conversation,
  type InteractionLog,
} from "../lib/chat";
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
  AlertCircle,
  Loader2,
  Boxes,
} from "lucide-react";

type Filter = "all" | "chat" | "api";

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

  useEffect(() => {
    fetchData();
  }, []);

  const isChat = (c: Conversation) => c.platform === "chat" || c.platform === "";
  const visible = conversations.filter(c =>
    filter === "all" ? true : filter === "chat" ? isChat(c) : !isChat(c),
  );

  const totalTokens = conversations.reduce((a, c) => a + c.totalTokens, 0);
  const apiCount = conversations.filter(c => !isChat(c)).length;

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
              <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">API / Tool Uploads</span>
              <p className="text-3xl font-extrabold text-sky-400">{apiCount}</p>
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
          <button
            onClick={fetchData}
            disabled={loading}
            className="p-2 rounded-xl hover:bg-muted text-muted-foreground hover:text-foreground transition-all active:scale-95 disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </CardHeader>

        <div className="flex gap-1 border-b border-border/40 bg-muted/40 p-1">
          <FilterBtn value="all" label={`All (${conversations.length})`} />
          <FilterBtn value="chat" label={`Chat (${conversations.length - apiCount})`} />
          <FilterBtn value="api" label={`API / Tools (${apiCount})`} />
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
                const chat = isChat(conv);
                return (
                  <div key={conv.id}>
                    <div
                      onClick={() => setExpanded(open ? null : conv.id)}
                      className="px-5 py-3.5 flex items-center justify-between cursor-pointer select-none hover:bg-muted/10 transition-all"
                    >
                      <div className="flex items-center gap-3 text-xs min-w-0 flex-1">
                        <div
                          className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0 border ${
                            chat ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" : "text-sky-400 bg-sky-500/10 border-sky-500/20"
                          }`}
                        >
                          {chat ? <MessageSquare className="w-3 h-3" /> : <Code className="w-3 h-3" />}
                          <span>{conv.platform || "chat"}</span>
                        </div>
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
