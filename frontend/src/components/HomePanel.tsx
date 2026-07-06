import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import {
  Trophy,
  Coins,
  FileText,
  RefreshCw,
  MessageSquare,
  Upload,
  Network,
  Medal,
  TrendingUp,
  Sparkles,
  ArrowRight,
} from "lucide-react";

interface LeaderboardEntry {
  username: string;
  totalTokens: number;
  totalTraces: number;
}

interface HomePanelProps {
  onNavigate: (tab: string) => void;
}

export function HomePanel({ onNavigate }: HomePanelProps) {
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLeaderboard = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/leaderboard");
      if (!res.ok) throw new Error("Failed to load leaderboard");
      const data = await res.json();
      setLeaderboard(data.leaderboard || []);
    } catch (err: any) {
      console.error("Leaderboard error:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLeaderboard();
  }, []);

  const tokensSorted = [...leaderboard].sort((a, b) => b.totalTokens - a.totalTokens);
  const tracesSorted = [...leaderboard].sort((a, b) => b.totalTraces - a.totalTraces);

  const getMedalColor = (rank: number) => {
    if (rank === 0) return "text-amber-400";
    if (rank === 1) return "text-gray-300";
    if (rank === 2) return "text-amber-600";
    return "text-muted-foreground/40";
  };

  const getMedalBg = (rank: number) => {
    if (rank === 0) return "bg-amber-500/10 border-amber-500/25";
    if (rank === 1) return "bg-gray-300/10 border-gray-300/25";
    if (rank === 2) return "bg-amber-600/10 border-amber-600/25";
    return "bg-muted/20 border-border/30";
  };

  const formatNumber = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toLocaleString();
  };

  const renderLeaderboardTable = (
    data: LeaderboardEntry[],
    valueKey: "totalTokens" | "totalTraces",
    label: string,
    icon: React.ReactNode,
    accentColor: string,
    emptyMsg: string,
  ) => {
    const maxVal = data.length > 0 && data[0] ? data[0][valueKey] : 1;

    return (
      <Card className="bg-card/40 border-border/80 backdrop-blur-md shadow-xl overflow-hidden">
        <CardHeader className="border-b border-border/50 bg-card/50 py-4 px-5 flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base font-bold">
            {icon}
            <span>{label}</span>
          </CardTitle>
          <button
            onClick={fetchLeaderboard}
            disabled={loading}
            className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-all active:scale-95 disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <div className="p-8 text-center text-xs text-muted-foreground">{error}</div>
          ) : loading ? (
            <div className="p-8 flex flex-col items-center justify-center gap-2">
              <div className="w-5 h-5 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin" />
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                Loading…
              </span>
            </div>
          ) : data.length === 0 ? (
            <div className="p-8 text-center text-xs text-muted-foreground">
              {emptyMsg}
            </div>
          ) : (
            <div className="divide-y divide-border/30">
              {data.slice(0, 15).map((entry, idx) => {
                const barWidth = maxVal > 0 ? (entry[valueKey] / maxVal) * 100 : 0;
                return (
                  <div
                    key={entry.username}
                    className="flex items-center gap-3 px-5 py-2.5 hover:bg-muted/10 transition-colors relative group"
                  >
                    {/* Rank */}
                    <div className={`w-7 h-7 rounded-lg border flex items-center justify-center flex-shrink-0 ${getMedalBg(idx)}`}>
                      {idx < 3 ? (
                        <Medal className={`w-3.5 h-3.5 ${getMedalColor(idx)}`} />
                      ) : (
                        <span className="text-[10px] font-bold text-muted-foreground/60">{idx + 1}</span>
                      )}
                    </div>

                    {/* Username + bar */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className={`text-xs font-semibold truncate ${idx < 3 ? "text-foreground" : "text-foreground/80"}`}>
                          {entry.username}
                        </span>
                        <span className={`text-xs font-bold tabular-nums flex-shrink-0 ml-3 ${accentColor}`}>
                          {formatNumber(entry[valueKey])}
                        </span>
                      </div>
                      <div className="w-full h-1 rounded-full bg-muted/50 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ease-out ${
                            idx === 0
                              ? "bg-gradient-to-r from-amber-500 to-amber-400"
                              : idx === 1
                              ? "bg-gradient-to-r from-gray-400 to-gray-300"
                              : idx === 2
                              ? "bg-gradient-to-r from-amber-700 to-amber-500"
                              : `bg-gradient-to-r ${
                                  valueKey === "totalTokens"
                                    ? "from-indigo-600/60 to-indigo-400/60"
                                    : "from-emerald-600/60 to-emerald-400/60"
                                }`
                          }`}
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  const usageModes = [
    {
      icon: <MessageSquare className="w-5 h-5" />,
      title: "Chat",
      description:
        "Have conversations with your own model endpoint. Each exchange is automatically logged — contributing high-quality interaction data for training the next generation of open models.",
      action: "Start chatting",
      tab: "chat",
      gradient: "from-indigo-500/15 to-violet-500/15",
      borderColor: "border-indigo-500/20",
      iconColor: "text-indigo-400",
    },
    {
      icon: <Upload className="w-5 h-5" />,
      title: "Upload Traces",
      description:
        "Upload coding agent traces from tools like OpenCode, Antigravity, or Claude Code. Your exported SQLite databases are parsed and added to the shared dataset — no manual formatting required.",
      action: "Upload traces",
      tab: "uploads",
      gradient: "from-emerald-500/15 to-teal-500/15",
      borderColor: "border-emerald-500/20",
      iconColor: "text-emerald-400",
    },
    {
      icon: <Network className="w-5 h-5" />,
      title: "V1 Proxy",
      description:
        "Generate an API key and point any OpenAI-compatible tool (VS Code Copilot, Cursor, CLI scripts) at our /v1 proxy. Every request is transparently logged while being forwarded to your endpoint — zero workflow disruption.",
      action: "Configure proxy",
      tab: "settings",
      gradient: "from-amber-500/15 to-orange-500/15",
      borderColor: "border-amber-500/20",
      iconColor: "text-amber-400",
    },
  ];

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      {/* Hero / Intro */}
      <div className="text-center space-y-2 pt-2">
        <div className="flex items-center justify-center gap-2">
          <TrendingUp className="w-5 h-5 text-indigo-400" />
          <h1 className="text-xl font-extrabold tracking-tight">Community Leaderboard</h1>
        </div>
        <p className="text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
          Contributors ranked by total tokens logged and number of interaction traces donated.
          Opt-in or out via <button className="text-indigo-400 hover:underline cursor-pointer font-semibold" onClick={() => onNavigate("settings")}>Settings</button>.
        </p>
      </div>

      {/* Leaderboards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {renderLeaderboardTable(
          tokensSorted,
          "totalTokens",
          "Tokens Donated",
          <Coins className="w-4 h-4 text-amber-400" />,
          "text-amber-400",
          "No contributions yet. Start chatting or upload traces!",
        )}
        {renderLeaderboardTable(
          tracesSorted,
          "totalTraces",
          "Traces Contributed",
          <FileText className="w-4 h-4 text-emerald-400" />,
          "text-emerald-400",
          "No traces contributed yet. Be the first!",
        )}
      </div>

      {/* Usage Guide */}
      <div className="space-y-4">
        <div className="flex items-center justify-center gap-2">
          <Sparkles className="w-4 h-4 text-indigo-400" />
          <h2 className="text-base font-bold tracking-tight text-center">How to Contribute</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {usageModes.map((mode) => (
            <button
              key={mode.tab}
              onClick={() => onNavigate(mode.tab)}
              className={`text-left group rounded-2xl border ${mode.borderColor} bg-gradient-to-br ${mode.gradient} p-5 space-y-3 hover:scale-[1.02] transition-all duration-200 cursor-pointer`}
            >
              <div className={`w-10 h-10 rounded-xl bg-background/30 border border-border/40 flex items-center justify-center ${mode.iconColor}`}>
                {mode.icon}
              </div>
              <h3 className="font-bold text-sm text-foreground">{mode.title}</h3>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {mode.description}
              </p>
              <div className="flex items-center gap-1 text-[11px] font-semibold text-indigo-400 group-hover:gap-2 transition-all">
                <span>{mode.action}</span>
                <ArrowRight className="w-3 h-3" />
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
