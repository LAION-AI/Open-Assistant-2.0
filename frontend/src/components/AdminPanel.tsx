import { useState, useEffect } from "react";
import { Markdown } from "./Markdown";
import { PlatformBadge } from "./PlatformBadge";
import { ConversationThread } from "./ConversationThread";
import {
  splitThinking,
  getLastUserMessage,
  truncateText,
  parseJsonObject,
  groupConversations,
  buildConversationTurns,
  conversationHasThinking,
  type Turn,
  type InteractionLog,
} from "../lib/chat";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Users, FileText, Database, Shield, Coins, Calendar, ChevronDown, ChevronUp, RefreshCw, AlertCircle, Brain, MessageSquare, Code, Eye, EyeOff } from "lucide-react";

interface AdminUser {
  id: string;
  username: string;
  email?: string | null;
  credits: number;
  byoeUrl?: string | null;
  byoeModel?: string | null;
  isAdmin: number;
  createdAt: number;
}

interface FeedbackItem {
  id: number;
  userId: string;
  message: string;
  category: string;
  status: string; // "open" | "done"
  createdAt: number;
  resolvedAt: number;
}

export function AdminPanel() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [logs, setLogs] = useState<InteractionLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<"users" | "logs" | "feedback">("users");
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [expandedLogId, setExpandedLogId] = useState<number | null>(null);
  const [expandedThinkingKeys, setExpandedThinkingKeys] = useState<Set<string>>(new Set());
  const [showRawJsonIds, setShowRawJsonIds] = useState<Set<number>>(new Set());

  // Server-side pagination + category filter for logs.
  const PAGE_SIZE = 100;
  const [logCategory, setLogCategory] = useState<"all" | "chat" | "v1" | "trace">("all");
  const [logPage, setLogPage] = useState(0);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsLoading, setLogsLoading] = useState(false);

  const fetchUsers = async () => {
    const res = await fetch("/api/admin/users");
    if (!res.ok) throw new Error(`Failed to fetch users: ${res.statusText}`);
    const data = await res.json();
    setUsers(data.users || []);
  };

  const fetchLogs = async (category = logCategory, page = logPage) => {
    setLogsLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        category,
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      const res = await fetch(`/api/admin/logs?${qs.toString()}`);
      if (!res.ok) throw new Error(`Failed to fetch interaction logs: ${res.statusText}`);
      const data = await res.json();
      setLogs(data.logs || []);
      setLogsTotal(data.total || 0);
      setExpandedLogId(null);
    } catch (err: any) {
      console.error("Error fetching admin logs:", err);
      setError(err.message || "Failed to load logs");
    } finally {
      setLogsLoading(false);
    }
  };

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([fetchUsers(), fetchLogs(logCategory, logPage)]);
    } catch (err: any) {
      console.error("Error fetching admin data:", err);
      setError(err.message || "Failed to load admin dashboard data");
    } finally {
      setLoading(false);
    }
  };

  const fetchFeedback = async () => {
    setFeedbackLoading(true);
    try {
      const res = await fetch("/api/feedback?status=all");
      if (res.ok) {
        const data = await res.json();
        setFeedback(data.feedback || []);
      }
    } catch (err) {
      console.warn("Failed to load feedback:", err);
    } finally {
      setFeedbackLoading(false);
    }
  };

  const toggleFeedback = async (item: FeedbackItem) => {
    const next = item.status === "done" ? "open" : "done";
    // Optimistic update.
    setFeedback(prev => prev.map(f => (f.id === item.id ? { ...f, status: next } : f)));
    try {
      await fetch("/api/feedback/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, status: next }),
      });
    } catch {
      // Revert on failure.
      setFeedback(prev => prev.map(f => (f.id === item.id ? { ...f, status: item.status } : f)));
    }
  };

  const changeCategory = (category: "all" | "chat" | "v1" | "trace") => {
    setLogCategory(category);
    setLogPage(0);
    fetchLogs(category, 0);
  };

  const goToPage = (page: number) => {
    setLogPage(page);
    fetchLogs(logCategory, page);
  };

  const parsePrompt = (prompt: string) => parseJsonObject(prompt);
  const parseResponse = (response: string) => parseJsonObject(response);

  const toggleThinking = (key: string) => {
    setExpandedThinkingKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const toggleRawJson = (logId: number) => {
    setShowRawJsonIds(prev => {
      const next = new Set(prev);
      if (next.has(logId)) {
        next.delete(logId);
      } else {
        next.add(logId);
      }
      return next;
    });
  };

  const renderMessageContent = (content: any) => {
    if (typeof content === "string") {
      return <span className="whitespace-pre-wrap">{content}</span>;
    }
    if (Array.isArray(content)) {
      return (
        <div className="space-y-2">
          {content.map((part: any, pIdx: number) => {
            if (part.type === "text") {
              return <span key={pIdx} className="whitespace-pre-wrap">{part.text}</span>;
            }
            if (part.type === "image_url") {
              return (
                <div key={pIdx} className="mt-1.5 max-w-[120px] rounded-lg overflow-hidden border border-border/60 shadow-sm">
                  <img src={part.image_url?.url} alt="Attached" className="w-full h-auto" />
                </div>
              );
            }
            return null;
          })}
        </div>
      );
    }
    return <span className="font-mono text-[10px]">{JSON.stringify(content)}</span>;
  };

  // Collapsible reasoning panel, shared by context and final assistant turns
  const renderThinking = (key: string, thinkingText: string) => {
    if (!thinkingText) return null;
    const isOpen = expandedThinkingKeys.has(key);
    return (
      <div className="w-full max-w-[85%] mb-2">
        <button
          onClick={(e) => { e.stopPropagation(); toggleThinking(key); }}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-violet-500/8 border border-violet-500/20 hover:bg-violet-500/15 transition-all duration-150 text-left group"
        >
          <div className="w-5 h-5 rounded-md bg-violet-500/15 flex items-center justify-center flex-shrink-0">
            <Brain className="w-3 h-3 text-violet-400" />
          </div>
          <span className="text-[10px] font-semibold text-violet-300 flex-1">
            Thinking Process
          </span>
          <span className="text-[9px] text-violet-400/60 font-mono">
            {thinkingText.length.toLocaleString()} chars
          </span>
          <ChevronDown
            className={`w-3.5 h-3.5 text-violet-400/60 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
          />
        </button>

        {isOpen && (
          <div
            className="mt-1.5 overflow-hidden rounded-xl border-l-[3px] border-violet-500/40"
            style={{
              borderImage: "linear-gradient(to bottom, rgb(139 92 246 / 0.5), rgb(99 102 241 / 0.3)) 1",
              animation: "slideDown 200ms ease-out",
            }}
          >
            <div className="px-3.5 py-3 bg-violet-950/15 border border-violet-500/10 rounded-r-xl">
              <div className="text-muted-foreground/80 max-h-[400px] overflow-y-auto">
                <Markdown compact>{thinkingText}</Markdown>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  useEffect(() => {
    fetchData();
    fetchFeedback();
  }, []);

  const openFeedback = feedback.filter(f => f.status !== "done").length;

  // Fold per-turn log rows into conversations (one entry per chat).
  const conversations = groupConversations(logs as InteractionLog[]);

  // Calculate quick stats
  const totalUsers = users.length;
  const totalLogs = logsTotal; // server-side total for the active filter
  const pageCount = Math.max(1, Math.ceil(logsTotal / PAGE_SIZE));
  const totalTokens = logs.reduce((acc, curr) => acc + (curr.tokens || 0), 0);

  const formatTime = (ts: number) => {
    // Check if timestamp is in seconds or milliseconds
    const date = new Date(ts > 9999999999 ? ts : ts * 1000);
    return date.toLocaleString();
  };

  const getUsername = (userId: string) => {
    const found = users.find(u => u.id === userId);
    return found ? found.username : userId.slice(0, 8) + "...";
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Dashboard Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="bg-card/45 border-border/80 backdrop-blur-md">
          <CardContent className="p-6 flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Total Users</span>
              <p className="text-3xl font-extrabold text-indigo-400">{totalUsers}</p>
            </div>
            <div className="w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
              <Users className="w-6 h-6" />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/45 border-border/80 backdrop-blur-md">
          <CardContent className="p-6 flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Logged Prompts</span>
              <p className="text-3xl font-extrabold text-emerald-400">{totalLogs}</p>
            </div>
            <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <FileText className="w-6 h-6" />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/45 border-border/80 backdrop-blur-md">
          <CardContent className="p-6 flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Tokens Logged</span>
              <p className="text-3xl font-extrabold text-amber-400">{totalTokens.toLocaleString()}</p>
            </div>
            <div className="w-12 h-12 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
              <Database className="w-6 h-6" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Admin Section */}
      <Card className="bg-card/40 border-border/80 backdrop-blur-md shadow-2xl overflow-hidden">
        <CardHeader className="border-b border-border/50 bg-card/50 flex flex-row items-center justify-between py-4">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-xl font-bold">
              <Shield className="w-5 h-5 text-indigo-400" />
              <span>Admin Dashboard</span>
            </CardTitle>
            <CardDescription className="text-xs">
              Monitor registered users, credits, endpoints, and collected interaction telemetry.
            </CardDescription>
          </div>
          <button
            onClick={fetchData}
            disabled={loading}
            className="p-2 rounded-xl hover:bg-muted text-muted-foreground hover:text-foreground transition-all active:scale-95 disabled:opacity-50"
            title="Refresh Data"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </CardHeader>

        {/* Sub Navigation */}
        <div className="flex border-b border-border/40 bg-muted/40 p-1">
          <button
            onClick={() => setActiveSubTab("users")}
            className={`flex-1 py-2.5 text-xs font-semibold rounded-lg transition-all ${
              activeSubTab === "users"
                ? "bg-background/80 text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
            }`}
          >
            Registered Users ({totalUsers})
          </button>
          <button
            onClick={() => setActiveSubTab("logs")}
            className={`flex-1 py-2.5 text-xs font-semibold rounded-lg transition-all ${
              activeSubTab === "logs"
                ? "bg-background/80 text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
            }`}
          >
            Conversations ({logsTotal})
          </button>
          <button
            onClick={() => setActiveSubTab("feedback")}
            className={`flex-1 py-2.5 text-xs font-semibold rounded-lg transition-all flex items-center justify-center gap-1.5 ${
              activeSubTab === "feedback"
                ? "bg-background/80 text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
            }`}
          >
            <span>Feedback ({feedback.length})</span>
            {openFeedback > 0 && (
              <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-amber-500/15 text-amber-400 border border-amber-500/25">
                {openFeedback} open
              </span>
            )}
          </button>
        </div>

        <CardContent className="p-0">
          {error && (
            <div className="p-4 bg-destructive/10 border-b border-destructive/20 text-destructive text-xs flex items-center gap-2.5 leading-relaxed">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="p-12 flex flex-col items-center justify-center gap-3">
              <div className="w-6 h-6 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin"></div>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                Loading database rows...
              </span>
            </div>
          ) : activeSubTab === "users" ? (
            /* Users Table */
            <div className="overflow-x-auto">
              {users.length === 0 ? (
                <div className="p-12 text-center text-xs text-muted-foreground">No users registered yet.</div>
              ) : (
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-border/40 text-[10px] text-muted-foreground font-bold uppercase bg-muted/20">
                      <th className="px-6 py-3.5">Username</th>
                      <th className="px-6 py-3.5">Credits</th>
                      <th className="px-6 py-3.5">BYOE Status</th>
                      <th className="px-6 py-3.5">Admin</th>
                      <th className="px-6 py-3.5 text-right">Registered At</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30 text-xs">
                    {users.map(u => (
                      <tr key={u.id} className="hover:bg-muted/10 transition-colors">
                        <td className="px-6 py-4 font-semibold text-foreground flex items-center gap-1.5">
                          <span>{u.username}</span>
                          {u.isAdmin === 1 && (
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                              owner
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-muted-foreground font-medium flex items-center gap-1">
                          <Coins className="w-3.5 h-3.5 text-amber-500/80" />
                          <span>{u.credits}</span>
                        </td>
                        <td className="px-6 py-4">
                          {u.byoeUrl ? (
                            <span className="text-indigo-400 font-medium truncate max-w-[180px] block" title={u.byoeUrl}>
                              {u.byoeModel || "Custom Endpoint"}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/60 italic">Not configured</span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <span className={u.isAdmin === 1 ? "text-emerald-400 font-semibold" : "text-muted-foreground/60"}>
                            {u.isAdmin === 1 ? "Yes" : "No"}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right text-muted-foreground">
                          {u.createdAt ? formatTime(u.createdAt) : "N/A"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : activeSubTab === "feedback" ? (
            /* Feedback List */
            <div>
              <div className="flex items-center justify-between px-5 py-3 border-b border-border/40 bg-muted/20">
                <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
                  {openFeedback} open · {feedback.length} total
                </span>
                <button
                  onClick={fetchFeedback}
                  disabled={feedbackLoading}
                  className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground"
                  title="Refresh feedback"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${feedbackLoading ? "animate-spin" : ""}`} />
                </button>
              </div>
              {feedback.length === 0 ? (
                <div className="p-12 text-center text-xs text-muted-foreground">No feedback yet.</div>
              ) : (
                <div className="divide-y divide-border/40">
                  {feedback.map(item => {
                    const isDone = item.status === "done";
                    return (
                      <div
                        key={item.id}
                        className={`px-5 py-3.5 flex items-start gap-3 ${isDone ? "opacity-55" : ""}`}
                      >
                        <Checkbox
                          checked={isDone}
                          onCheckedChange={() => toggleFeedback(item)}
                          className="mt-0.5 flex-shrink-0"
                          title={isDone ? "Reopen" : "Mark done"}
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <p className={`text-xs leading-relaxed whitespace-pre-wrap break-words ${isDone ? "line-through text-muted-foreground" : "text-foreground/90"}`}>
                            {item.message}
                          </p>
                          <div className="flex items-center gap-2 text-[10px] text-muted-foreground/70">
                            <span className="flex items-center gap-1">
                              <Users className="w-3 h-3" /> {getUsername(item.userId)}
                            </span>
                            <span>·</span>
                            <span>{formatTime(item.createdAt)}</span>
                            {item.category && (
                              <>
                                <span>·</span>
                                <span className="px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">{item.category}</span>
                              </>
                            )}
                          </div>
                        </div>
                        <span
                          className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full border flex-shrink-0 ${
                            isDone
                              ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                              : "text-amber-400 bg-amber-500/10 border-amber-500/20"
                          }`}
                        >
                          {isDone ? "done" : "open"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* Logs List */
            <div>
              {/* Category filter */}
              <div className="flex gap-1 border-b border-border/40 bg-muted/20 p-1 flex-wrap items-center">
                {(["all", "chat", "v1", "trace"] as const).map(val => (
                  <button
                    key={val}
                    onClick={() => changeCategory(val)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                      logCategory === val ? "bg-background/80 text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
                    }`}
                  >
                    {val === "v1" ? "V1 Proxy" : val === "trace" ? "Local traces" : val === "chat" ? "Chat" : "All"}
                  </button>
                ))}
                {logsLoading && <RefreshCw className="w-3.5 h-3.5 animate-spin text-muted-foreground ml-1" />}
              </div>

              <div className="divide-y divide-border/40">
              {conversations.length === 0 ? (
                <div className="p-12 text-center text-xs text-muted-foreground">No conversations logged yet.</div>
              ) : (
                conversations.map(conv => {
                  const isExpanded = expandedLogId === conv.id;
                  const parsedPrompt = parsePrompt(conv.latest.prompt);
                  const turnCount = conv.turnCount;
                  const lastUserMsg = getLastUserMessage(conv.latest.prompt);
                  const thinking = conversationHasThinking(conv);
                  const isRawJsonVisible = showRawJsonIds.has(conv.id);

                  // Extract model name
                  let requestModel = "";
                  if (parsedPrompt && typeof parsedPrompt === "object" && !Array.isArray(parsedPrompt)) {
                    requestModel = parsedPrompt.model || "";
                  }

                  return (
                    <div key={conv.id} className="transition-colors">
                      {/* Summary Row */}
                      <div
                        onClick={() => setExpandedLogId(isExpanded ? null : conv.id)}
                        className="px-5 py-3.5 flex items-center justify-between cursor-pointer select-none hover:bg-muted/10 transition-all duration-150"
                      >
                        <div className="flex items-center gap-3 text-xs min-w-0 flex-1">
                          {/* User */}
                          <div className="flex items-center gap-1.5 font-semibold text-foreground min-w-[110px] max-w-[140px] truncate flex-shrink-0">
                            <Users className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                            <span>{getUsername(conv.userId)}</span>
                          </div>

                          {/* Model badge */}
                          {requestModel && (
                            <div className="px-2 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/20 text-[10px] text-indigo-400 font-medium font-mono uppercase truncate max-w-[130px] flex-shrink-0" title={requestModel}>
                              {requestModel}
                            </div>
                          )}

                          {/* Turns badge */}
                          <div className="flex items-center gap-1 text-[10px] text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 px-1.5 py-0.5 rounded-full flex-shrink-0">
                            <MessageSquare className="w-3 h-3" />
                            <span>{turnCount} {turnCount === 1 ? "turn" : "turns"}</span>
                          </div>

                          {/* Platform badge */}
                          {conv.platform && <PlatformBadge platform={conv.platform} />}

                          {/* Thinking badge */}
                          {thinking && (
                            <div className="flex items-center gap-1 text-[10px] text-violet-400 bg-violet-500/10 border border-violet-500/20 px-1.5 py-0.5 rounded-full flex-shrink-0" title="Reasoning / thinking tokens used">
                              <Brain className="w-3 h-3" />
                              <span>Thinking</span>
                            </div>
                          )}

                          {/* Last user message */}
                          <div className="text-muted-foreground truncate flex-1 min-w-0 pr-2">
                            <span className="font-semibold text-foreground/70">Q: </span>
                            {truncateText(lastUserMsg, 80)}
                          </div>

                          {/* Token badge */}
                          <div className="flex items-center gap-1 text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full flex-shrink-0">
                            <Database className="w-3 h-3" />
                            <span>{conv.totalTokens} tk</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 text-xs text-muted-foreground pl-3 flex-shrink-0">
                          <div className="flex items-center gap-1 hidden sm:flex">
                            <Calendar className="w-3.5 h-3.5" />
                            <span>{formatTime(conv.updatedAt)}</span>
                          </div>
                          <div className="w-5 h-5 rounded-md flex items-center justify-center hover:bg-muted/30 transition-colors">
                            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </div>
                        </div>
                      </div>

                      {/* Expanded Detail Panel */}
                      {isExpanded && (
                        <div
                          className="px-5 pb-5 pt-1 bg-muted/10 border-t border-border/20 space-y-4 text-xs leading-relaxed"
                          style={{ animation: "slideDown 200ms ease-out" }}
                        >
                          {/* Conversation Thread */}
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 pb-1">
                              <MessageSquare className="w-3.5 h-3.5 text-indigo-400" />
                              <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-400">
                                Conversation Thread
                              </span>
                              <span className="text-[10px] text-muted-foreground">
                                · {turnCount} {turnCount === 1 ? "turn" : "turns"}
                              </span>
                              {requestModel && (
                                <span className="text-[10px] text-muted-foreground font-mono">
                                  · {requestModel}
                                </span>
                              )}
                            </div>

                            <ConversationThread conv={conv} />
                          </div>

                          {/* Raw JSON Toggle */}
                          <div className="space-y-2">
                            <button
                              onClick={(e) => { e.stopPropagation(); toggleRawJson(conv.id); }}
                              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/30 border border-border/40 hover:bg-muted/50 transition-all duration-150 text-[10px] font-semibold text-muted-foreground hover:text-foreground group"
                            >
                              {isRawJsonVisible ? (
                                <>
                                  <EyeOff className="w-3 h-3" />
                                  <span>Hide Raw Database Records ({conv.logs.length})</span>
                                </>
                              ) : (
                                <>
                                  <Code className="w-3 h-3" />
                                  <span>Show Raw Database Records ({conv.logs.length})</span>
                                </>
                              )}
                            </button>

                            {isRawJsonVisible && (
                              <div style={{ animation: "slideDown 150ms ease-out" }}>
                                <pre className="p-3 bg-background/60 rounded-xl border border-border/40 overflow-x-auto font-mono text-[10px] leading-normal text-muted-foreground/80 max-h-[300px] overflow-y-auto">
                                  {JSON.stringify(conv.logs.length === 1 ? conv.logs[0] : conv.logs, null, 2)}
                                </pre>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
              </div>

              {/* Pagination */}
              {logsTotal > PAGE_SIZE && (
                <div className="flex items-center justify-between px-5 py-3 border-t border-border/40 text-xs">
                  <span className="text-muted-foreground">
                    {logPage * PAGE_SIZE + 1}–{Math.min((logPage + 1) * PAGE_SIZE, logsTotal)} of {logsTotal.toLocaleString()}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => goToPage(logPage - 1)}
                      disabled={logPage <= 0 || logsLoading}
                      className="px-3 py-1.5 rounded-lg border border-border/50 hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed font-semibold"
                    >
                      Prev
                    </button>
                    <span className="text-muted-foreground">Page {logPage + 1} / {pageCount}</span>
                    <button
                      onClick={() => goToPage(logPage + 1)}
                      disabled={logPage + 1 >= pageCount || logsLoading}
                      className="px-3 py-1.5 rounded-lg border border-border/50 hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed font-semibold"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Inline keyframe animation */}
      <style>{`
        @keyframes slideDown {
          from {
            opacity: 0;
            transform: translateY(-8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}
