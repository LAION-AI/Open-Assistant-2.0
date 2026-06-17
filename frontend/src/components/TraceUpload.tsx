import { useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Modal } from "./Modal";
import { ConversationThread } from "./ConversationThread";
import { PlatformBadge } from "./PlatformBadge";
import { parseTrace, traceToConversation, type ParsedTrace } from "../lib/traces";
import {
  Upload,
  FolderOpen,
  FileJson,
  Loader2,
  CheckCircle,
  AlertCircle,
  MessagesSquare,
} from "lucide-react";

interface Entry {
  id: string;
  trace: ParsedTrace;
  selected: boolean;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 400;

export function TraceUpload({ onUploaded }: { onUploaded: () => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [scanning, setScanning] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ParsedTrace | null>(null);

  const folderRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setScanning(true);
    setError(null);
    setResult(null);
    try {
      const files = Array.from(fileList)
        .filter(f => /\.(jsonl?|ndjson)$/i.test(f.name) && f.size <= MAX_FILE_BYTES)
        .slice(0, MAX_FILES);

      const parsed: Entry[] = [];
      for (const f of files) {
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

      // Newest-looking / largest conversations first.
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

  const upload = async () => {
    if (selected.length === 0) return;
    setUploading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/traces/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          traces: selected.map(e => ({
            platform: e.trace.platform,
            model: e.trace.model,
            messages: e.trace.messages,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setResult(`Uploaded ${data.saved} trace${data.saved === 1 ? "" : "s"}.`);
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
          <Button type="button" onClick={() => folderRef.current?.click()} disabled={scanning} className="h-11 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold gap-2">
            {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderOpen className="w-4 h-4" />}
            <span>Choose folder</span>
          </Button>
          <Button type="button" variant="outline" onClick={() => filesRef.current?.click()} disabled={scanning} className="h-11 rounded-xl text-sm gap-2">
            <FileJson className="w-4 h-4" />
            <span>Choose files</span>
          </Button>
        </div>

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

            <div className="max-h-[320px] overflow-y-auto rounded-xl border border-border/50 divide-y divide-border/40">
              {entries.map(({ id, trace, selected }) => (
                <div key={id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/20">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggle(id)}
                    className="w-4 h-4 accent-indigo-600 flex-shrink-0 cursor-pointer"
                  />
                  <PlatformBadge platform={trace.platform} />
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

            <Button onClick={upload} disabled={uploading || selected.length === 0} className="h-11 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold gap-2">
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              <span>{uploading ? "Uploading…" : `Upload ${selected.length} selected`}</span>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>

    {preview && (
      <Modal
        title={
          <span className="flex items-center gap-2">
            <PlatformBadge platform={preview.platform} />
            <span className="truncate">{preview.title}</span>
          </span>
        }
        onClose={() => setPreview(null)}
      >
        <ConversationThread conv={traceToConversation(preview)} />
      </Modal>
    )}
    </>
  );
}
