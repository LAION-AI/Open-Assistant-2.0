import { useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { ConversationThread } from "./ConversationThread";
import { PlatformBadge } from "./PlatformBadge";
import { parseTrace, traceToConversation, type ParsedTrace } from "../lib/traces";
import { loadRedactor, redactMessages, redactSource } from "../lib/redact";
import {
  Upload,
  FolderOpen,
  FileJson,
  Loader2,
  CheckCircle,
  AlertCircle,
  MessagesSquare,
  Sparkles,
  Copy,
  Check,
  Terminal,
  Code2,
  Zap,
  PawPrint,
  ShieldCheck,
  Bot,
  Rocket,
  type LucideIcon,
} from "lucide-react";

type OS = "mac" | "windows" | "linux" | "unknown";

function detectOS(): OS {
  if (typeof navigator === "undefined") return "unknown";
  const data = (navigator as any).userAgentData?.platform || "";
  const s = `${data} ${navigator.platform || ""} ${navigator.userAgent || ""}`.toLowerCase();
  if (s.includes("mac")) return "mac";
  if (s.includes("win")) return "windows";
  if (s.includes("linux") || s.includes("android")) return "linux";
  return "unknown";
}

interface TraceSource {
  id: string;
  label: string;
  color: string;
  icon: LucideIcon;
  /** Default location of the tool's session/history files, per OS. */
  paths: Record<OS, string>;
}

// Best-effort default locations. The picker still lets the user navigate
// elsewhere — these just pre-fill the path on the clipboard.
const TRACE_SOURCES: TraceSource[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    color: "#D97757",
    icon: Sparkles,
    paths: {
      mac: "~/.claude/projects",
      linux: "~/.claude/projects",
      windows: "%USERPROFILE%\\.claude\\projects",
      unknown: "~/.claude/projects",
    },
  },
  {
    id: "opencode",
    label: "OpenCode",
    color: "#0ea5e9",
    icon: Terminal,
    // Newer OpenCode keeps everything in opencode.db (SQLite); we parse it.
    paths: {
      mac: "~/.local/share/opencode",
      linux: "~/.local/share/opencode",
      windows: "%USERPROFILE%\\.local\\share\\opencode",
      unknown: "~/.local/share/opencode",
    },
  },
  {
    id: "copilot",
    label: "Copilot Chat",
    color: "#0066b8",
    icon: Code2,
    paths: {
      mac: "~/Library/Application Support/Code/User/workspaceStorage",
      linux: "~/.config/Code/User/workspaceStorage",
      windows: "%APPDATA%\\Code\\User\\workspaceStorage",
      unknown: "~/.config/Code/User/workspaceStorage",
    },
  },
  {
    id: "codex",
    label: "Codex",
    color: "#10a37f",
    icon: Bot,
    // OpenAI Codex CLI rollout transcripts.
    paths: {
      mac: "~/.codex/sessions",
      linux: "~/.codex/sessions",
      windows: "%USERPROFILE%\\.codex\\sessions",
      unknown: "~/.codex/sessions",
    },
  },
  {
    id: "antigravity",
    label: "Antigravity",
    color: "#4285F4",
    icon: Rocket,
    // Google Antigravity (Gemini) — one SQLite db per conversation.
    paths: {
      mac: "~/.gemini/antigravity/conversations",
      linux: "~/.gemini/antigravity/conversations",
      windows: "%USERPROFILE%\\.gemini\\antigravity\\conversations",
      unknown: "~/.gemini/antigravity/conversations",
    },
  },
  {
    id: "hermes",
    label: "Hermes Agent",
    color: "#8b5cf6",
    icon: Zap,
    // Nous Hermes Agent. Modern builds use ~/.hermes/state.db (SQLite); legacy
    // JSONL transcripts live under ~/.hermes/sessions.
    paths: {
      mac: "~/.hermes",
      linux: "~/.hermes",
      windows: "%USERPROFILE%\\.hermes",
      unknown: "~/.hermes",
    },
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    color: "#f97316",
    icon: PawPrint,
    // OpenClaw stores transcripts at ~/.openclaw/agents/<id>/sessions/<id>.jsonl
    paths: {
      mac: "~/.openclaw/agents",
      linux: "~/.openclaw/agents",
      windows: "%USERPROFILE%\\.openclaw\\agents",
      unknown: "~/.openclaw/agents",
    },
  },
];

const DIALOG_TIP: Record<OS, string> = {
  mac: "In the dialog, press ⌘⇧G, paste (⌘V), then Enter.",
  linux: "In the dialog, press Ctrl+L, paste, then Enter.",
  windows: "Paste the path into the dialog's address bar, then Enter.",
  unknown: "Navigate to the folder shown above.",
};

interface Entry {
  id: string;
  trace: ParsedTrace;
  selected: boolean;
  redactions?: number; // PII items redacted (undefined = not yet redacted)
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_DB_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 400;

export function TraceUpload({ onUploaded }: { onUploaded: () => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [scanning, setScanning] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ParsedTrace | null>(null);
  const [tip, setTip] = useState<TraceSource | null>(null);
  const [pathCopied, setPathCopied] = useState(false);
  const [redactState, setRedactState] = useState<"idle" | "loading" | "running" | "done">("idle");
  const [redactStatus, setRedactStatus] = useState("");
  const [autoRedact, setAutoRedact] = useState(true);

  const folderRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);

  const os = detectOS();
  const osLabel = os === "windows" ? "Windows" : os === "mac" ? "macOS" : os === "linux" ? "Linux" : "your OS";

  const copyPath = (path: string) => {
    navigator.clipboard?.writeText(path).then(() => {
      setPathCopied(true);
      setTimeout(() => setPathCopied(false), 1500);
    });
  };

  const openSource = (src: TraceSource) => {
    // Browsers can't point the picker at an arbitrary path, so copy it and tell
    // the user how to jump there in the native dialog.
    navigator.clipboard?.writeText(src.paths[os]).catch(() => {});
    setTip(src);
    folderRef.current?.click();
  };

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setScanning(true);
    setError(null);
    setResult(null);
    try {
      const all = Array.from(fileList);
      const byPath = new Map(all.map(f => [((f as any).webkitRelativePath || f.name) as string, f]));
      const parsed: Entry[] = [];

      // Text-based traces (Claude Code / VS Code / OpenAI JSON & JSONL).
      const textFiles = all
        .filter(f => /\.(jsonl?|ndjson)$/i.test(f.name) && f.size <= MAX_FILE_BYTES)
        .slice(0, MAX_FILES);
      for (const f of textFiles) {
        const path = (f as any).webkitRelativePath || f.name;
        let text = "";
        try {
          text = await f.text();
        } catch {
          continue;
        }
        const trace = parseTrace(f.name, path, text);
        if (trace.ok) parsed.push({ id: `${path}:${parsed.length}`, trace, selected: true });
      }

      // SQLite databases (OpenCode) — parsed server-side via bun:sqlite.
      const dbFiles = all.filter(f => /\.db$/i.test(f.name) && f.size <= MAX_DB_BYTES);
      for (const dbf of dbFiles) {
        const path = (dbf as any).webkitRelativePath || dbf.name;
        const fd = new FormData();
        fd.append("db", dbf);
        const wal = byPath.get(path + "-wal");
        const shm = byPath.get(path + "-shm");
        if (wal) fd.append("wal", wal);
        if (shm) fd.append("shm", shm);
        try {
          const res = await fetch("/api/traces/parse-db", { method: "POST", body: fd });
          if (res.ok) {
            const data = await res.json();
            for (const t of data.traces || []) {
              if (t.ok) parsed.push({ id: `${path}:${parsed.length}`, trace: t, selected: true });
            }
          }
        } catch {
          // ignore unreadable db
        }
      }

      // Largest conversations first.
      parsed.sort((a, b) => b.trace.messages.length - a.trace.messages.length);
      setEntries(parsed);
      if (parsed.length === 0) setError("No readable conversation traces found in that selection.");
    } finally {
      setScanning(false);
    }
  };

  const toggle = (id: string) =>
    setEntries(prev => prev.map(e => (e.id === id ? { ...e, selected: !e.selected } : e)));
  const setAll = (v: boolean) => setEntries(prev => prev.map(e => ({ ...e, selected: v })));

  const selected = entries.filter(e => e.selected);
  const redactBusy = redactState === "loading" || redactState === "running";

  // Load the model and redact the given entries on-device: message text +
  // reasoning, plus the verbatim source copy (parse-aware, so it stays a valid
  // file of the same format). Tool_call arguments are never touched, so stored
  // JSON stays valid. Returns id -> redacted trace parts so callers can use
  // fresh results immediately.
  const redactEntries = async (
    targets: Entry[],
  ): Promise<Map<string, { messages: any[]; source?: ParsedTrace["source"] }>> => {
    const result = new Map<string, { messages: any[]; source?: ParsedTrace["source"] }>();
    if (targets.length === 0) return result;

    setRedactState("loading");
    setRedactStatus("Loading privacy model (first run downloads weights)…");
    let classifier: any;
    try {
      classifier = await loadRedactor(info => {
        if (info.status === "progress" && typeof info.progress === "number") {
          setRedactStatus(`Downloading model… ${Math.round(info.progress)}%`);
        } else if (info.status === "ready") {
          setRedactStatus("Model ready — redacting…");
        }
      });
    } catch (e: any) {
      setRedactState("idle");
      throw new Error(`Couldn't load the privacy model: ${e?.message || e}. (WebGPU/WASM unavailable?)`);
    }

    setRedactState("running");
    let total = 0;
    for (let i = 0; i < targets.length; i++) {
      const e = targets[i];
      if (!e) continue;
      setRedactStatus(`Redacting conversation ${i + 1} / ${targets.length}…`);
      try {
        const { messages, count } = await redactMessages(e.trace.messages as any, classifier);
        let source = e.trace.source;
        let count2 = 0;
        if (source) {
          // The verbatim original must be scrubbed too, or the redaction above
          // would be cosmetic.
          const r = await redactSource(source, classifier);
          source = r.source;
          count2 = r.count;
        }
        total += count + count2;
        result.set(e.id, { messages, source });
        setEntries(prev =>
          prev.map(x =>
            x.id === e.id ? { ...x, trace: { ...x.trace, messages, source }, redactions: count + count2 } : x,
          ),
        );
      } catch {
        setEntries(prev => prev.map(x => (x.id === e.id ? { ...x, redactions: x.redactions ?? 0 } : x)));
      }
    }
    setRedactState("done");
    setRedactStatus(`Redacted ${total} PII item${total === 1 ? "" : "s"} across ${targets.length} conversation${targets.length === 1 ? "" : "s"}.`);
    return result;
  };

  // Redact every loaded conversation (manual button).
  const redactAll = async () => {
    if (entries.length === 0 || redactBusy) return;
    setError(null);
    try {
      await redactEntries(entries);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const upload = async () => {
    if (selected.length === 0 || uploading || redactBusy) return;
    setUploading(true);
    setError(null);
    setResult(null);
    try {
      // Redact (on-device) any selected, not-yet-redacted conversations first.
      let redacted = new Map<string, { messages: any[]; source?: ParsedTrace["source"] }>();
      if (autoRedact) {
        const pending = selected.filter(e => e.redactions == null);
        if (pending.length > 0) {
          try {
            redacted = await redactEntries(pending);
          } catch (e: any) {
            setError(e.message);
            setUploading(false);
            return;
          }
        }
      }

      const res = await fetch("/api/traces/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          traces: selected.map(e => ({
            platform: e.trace.platform,
            model: e.trace.model,
            messages: redacted.get(e.id)?.messages || e.trace.messages,
            source: redacted.get(e.id)?.source ?? e.trace.source,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setResult(`Uploaded ${data.saved} trace${data.saved === 1 ? "" : "s"}${autoRedact ? " (PII redacted)" : ""}.`);
      setEntries([]);
      onUploaded();
    } catch (err: any) {
      setError(err.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
    <Card className="bg-card/40 border-border/80 backdrop-blur-md shadow-xl overflow-hidden">
      <CardHeader className="border-b border-border/50 bg-card/50">
        <CardTitle className="flex items-center gap-2 text-xl font-bold">
          <Upload className="w-5 h-5 text-indigo-400" />
          <span>Upload your VS Code, Claude Code or alike traces</span>
        </CardTitle>
        <CardDescription className="text-xs leading-relaxed mt-1">
          Pick a folder (e.g. <code>~/.claude/projects</code>) or individual session files. Everything is parsed
          locally — review and select exactly which conversations to contribute before uploading.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-6 space-y-4">
        {/* Pickers */}
        <div className="flex flex-wrap gap-2">
          <input
            ref={folderRef}
            type="file"
            multiple
            // @ts-expect-error non-standard but widely supported
            webkitdirectory=""
            directory=""
            className="hidden"
            onChange={e => handleFiles(e.target.files)}
          />
          <input
            ref={filesRef}
            type="file"
            multiple
            accept=".json,.jsonl,.ndjson"
            className="hidden"
            onChange={e => handleFiles(e.target.files)}
          />
          {TRACE_SOURCES.map(src => {
            const Icon = src.icon;
            return (
              <Button
                key={src.id}
                type="button"
                onClick={() => openSource(src)}
                disabled={scanning}
                className="h-11 rounded-xl text-white text-sm font-semibold gap-2 hover:brightness-110 transition"
                style={{ backgroundColor: src.color }}
                title={`Open the ${src.label} traces folder`}
              >
                <Icon className="w-4 h-4" />
                <span>{src.label}</span>
              </Button>
            );
          })}
          <Button type="button" variant="outline" onClick={() => folderRef.current?.click()} disabled={scanning} className="h-11 rounded-xl text-sm gap-2">
            {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderOpen className="w-4 h-4" />}
            <span>Choose folder</span>
          </Button>
          <Button type="button" variant="outline" onClick={() => filesRef.current?.click()} disabled={scanning} className="h-11 rounded-xl text-sm gap-2">
            <FileJson className="w-4 h-4" />
            <span>Choose files</span>
          </Button>
        </div>

        {tip && (
          <div
            className="rounded-xl border p-3.5 text-[11px] leading-relaxed space-y-1.5"
            style={{ borderColor: `${tip.color}40`, backgroundColor: `${tip.color}14` }}
          >
            <div className="font-semibold flex items-center gap-1.5" style={{ color: tip.color }}>
              <tip.icon className="w-3.5 h-3.5" /> {tip.label} sessions live here ({osLabel}):
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-2 py-1.5 rounded-lg bg-background/60 border border-input font-mono text-[10px] truncate">{tip.paths[os]}</code>
              <Button type="button" variant="outline" size="sm" onClick={() => copyPath(tip.paths[os])} className="h-8 rounded-lg text-[10px] gap-1 flex-shrink-0">
                {pathCopied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>Copy</span>
              </Button>
            </div>
            <div className="text-muted-foreground">{DIALOG_TIP[os]} <span className="text-muted-foreground/70">(path already copied to your clipboard)</span></div>
          </div>
        )}

        {error && (
          <div className="p-3 bg-destructive/10 border border-destructive/20 text-destructive text-xs rounded-xl flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {result && (
          <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs rounded-xl flex items-center gap-2">
            <CheckCircle className="w-4 h-4 flex-shrink-0" />
            <span>{result}</span>
          </div>
        )}

        {/* Parsed traces list */}
        {entries.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-3">
                <span className="font-semibold text-foreground">{entries.length} conversation{entries.length === 1 ? "" : "s"} found</span>
                <button onClick={() => setAll(true)} className="text-indigo-400 hover:underline">Select all</button>
                <button onClick={() => setAll(false)} className="text-muted-foreground hover:underline">None</button>
              </div>
              <span className="text-muted-foreground">{selected.length} selected</span>
            </div>

            {/* Local PII redaction */}
            <div className="flex items-center gap-3 flex-wrap rounded-xl bg-violet-500/8 border border-violet-500/20 px-3 py-2.5">
              <Button
                type="button"
                onClick={redactAll}
                disabled={redactBusy}
                className="h-9 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold gap-2"
              >
                {redactBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                <span>{redactState === "done" ? "Redact again" : "Redact PII locally"}</span>
              </Button>
              <span className="text-[11px] text-muted-foreground flex-1 min-w-0">
                {redactStatus || "Removes names, emails, phones, etc. on-device (openai/privacy-filter) before upload — nothing leaves your machine."}
              </span>
            </div>

            <div className="max-h-[320px] overflow-y-auto rounded-xl border border-border/50 divide-y divide-border/40">
              {entries.map(({ id, trace, selected, redactions }) => (
                <div key={id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/20">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggle(id)}
                    className="w-4 h-4 accent-indigo-600 flex-shrink-0 cursor-pointer"
                  />
                  <PlatformBadge platform={trace.platform} />
                  {redactions != null && (
                    <span
                      className="flex items-center gap-1 text-[10px] text-violet-400 bg-violet-500/10 border border-violet-500/20 px-1.5 py-0.5 rounded-full flex-shrink-0"
                      title={`${redactions} PII item(s) redacted`}
                    >
                      <ShieldCheck className="w-3 h-3" />
                      <span>{redactions}</span>
                    </span>
                  )}
                  {/* Click the message count to preview the conversation */}
                  <button
                    onClick={() => setPreview(trace)}
                    title="Preview conversation"
                    className="flex items-center gap-1 text-[10px] text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 hover:bg-cyan-500/20 px-1.5 py-0.5 rounded-full flex-shrink-0 transition-colors"
                  >
                    <MessagesSquare className="w-3 h-3" />
                    <span>{trace.messages.length} msgs</span>
                  </button>
                  <button
                    onClick={() => setPreview(trace)}
                    className="text-xs text-foreground/85 truncate flex-1 min-w-0 text-left hover:text-foreground hover:underline"
                    title="Preview conversation"
                  >
                    {trace.title}
                  </button>
                  {trace.model && (
                    <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[120px] flex-shrink-0 hidden sm:block">{trace.model}</span>
                  )}
                </div>
              ))}
            </div>

            <div className="flex items-center gap-4 flex-wrap">
              <Button onClick={upload} disabled={uploading || redactBusy || selected.length === 0} className="h-11 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold gap-2">
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                <span>{uploading ? (redactBusy ? "Redacting…" : "Uploading…") : `Upload ${selected.length} selected`}</span>
              </Button>
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                <Checkbox
                  checked={autoRedact}
                  onCheckedChange={v => setAutoRedact(v === true)}
                  disabled={uploading || redactBusy}
                />
                <span className="flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5 text-violet-400" />
                  Redact PII before upload
                </span>
              </label>
            </div>
          </div>
        )}
      </CardContent>
    </Card>

    <Dialog open={!!preview} onOpenChange={o => !o && setPreview(null)}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm pr-6">
            <PlatformBadge platform={preview?.platform} />
            <span className="truncate">{preview?.title}</span>
          </DialogTitle>
        </DialogHeader>
        {preview && <ConversationThread conv={traceToConversation(preview)} />}
      </DialogContent>
    </Dialog>
    </>
  );
}
