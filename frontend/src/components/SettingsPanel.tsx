import { useState, useEffect, type FormEvent } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Server, Key, Brain, CheckCircle, HelpCircle, RefreshCw, Copy, Check, Trash2, Network, Code2, Download, Loader2 } from "lucide-react";

interface User {
  id: string;
  username: string;
  email?: string | null;
  credits: number;
  byoeUrl?: string | null;
  byoeKey?: string | null;
  byoeModel?: string | null;
  apiKey?: string | null;
}

interface SettingsPanelProps {
  user: User;
  onUpdateUser: (updatedUser: User) => void;
}

export function SettingsPanel({ user, onUpdateUser }: SettingsPanelProps) {
  const [byoeUrl, setByoeUrl] = useState(user.byoeUrl || "");
  const [byoeKey, setByoeKey] = useState(user.byoeKey || "");
  const [byoeModel, setByoeModel] = useState(user.byoeModel || "");
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Data-collection proxy API key
  const [apiKey, setApiKey] = useState<string | null>(user.apiKey || null);
  const [keyLoading, setKeyLoading] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const proxyBase = typeof window !== "undefined" ? `${window.location.origin}/v1` : "/v1";

  const copyToClipboard = (field: string, value: string) => {
    navigator.clipboard?.writeText(value).then(() => {
      setCopiedField(field);
      setTimeout(() => setCopiedField(prev => (prev === field ? null : prev)), 1500);
    });
  };

  // VS Code setup state
  const [vscodeState, setVscodeState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [vscodeModelCount, setVscodeModelCount] = useState(0);
  const proxyCompletions = `${proxyBase}/chat/completions`; // header-auth endpoint

  // Ensure the user has an API key (to paste into VS Code's secure prompt).
  const ensureApiKey = async (): Promise<string | null> => {
    if (apiKey) return apiKey;
    const r = await fetch("/api/user/apikey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const d = await r.json();
    setApiKey(d.apiKey);
    onUpdateUser({ ...user, apiKey: d.apiKey });
    return d.apiKey;
  };

  // Build just the `models` array (header-auth URLs) to paste into the VS Code
  // config. The API key is NOT included — VS Code stores it in Secret Storage.
  const buildVscodeModels = async (): Promise<{ json: string; count: number }> => {
    const res = await fetch("/api/models");
    const data = await res.json().catch(() => ({}));
    const ids: string[] = data?.models?.length
      ? data.models
      : byoeModel
        ? [byoeModel]
        : ["gpt-4o"];
    const models = ids.map(id => ({
      id,
      name: `${id} (OA proxy)`,
      url: proxyCompletions,
      toolCalling: true,
      vision: true,
      maxInputTokens: 128000,
      maxOutputTokens: 16000,
    }));
    return { json: JSON.stringify(models, null, 2), count: ids.length };
  };

  const copyVscodeModels = async () => {
    setVscodeState("loading");
    try {
      await ensureApiKey();
      const { json, count } = await buildVscodeModels();
      await navigator.clipboard?.writeText(json);
      setVscodeModelCount(count);
      setVscodeState("done");
      setTimeout(() => setVscodeState(prev => (prev === "done" ? "idle" : prev)), 12000);
    } catch (err) {
      console.error("VS Code models copy failed:", err);
      setVscodeState("error");
    }
  };

  const downloadVscodeModels = async () => {
    try {
      const { json } = await buildVscodeModels();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "open-assistant-vscode-models.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Download failed:", err);
    }
  };

  const updateApiKey = async (revoke: boolean) => {
    setKeyLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/user/apikey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(revoke ? { revoke: true } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update API key");
      setApiKey(data.apiKey);
      onUpdateUser({ ...user, apiKey: data.apiKey });
    } catch (err: any) {
      setError(err.message || "Failed to update API key");
    } finally {
      setKeyLoading(false);
    }
  };

  const fetchModels = async (url: string, key: string) => {
    if (!url) return;
    setFetchingModels(true);
    setError(null);
    try {
      const res = await fetch("/api/user/byoe/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ byoeUrl: url, byoeKey: key }),
      });
      if (!res.ok) {
        throw new Error("Failed to fetch models list from endpoint");
      }
      const data = await res.json();
      if (data && Array.isArray(data.data)) {
        const list = data.data.map((m: any) => m.id);
        setModels(list);
        
        // If the current model is not in the list, set it to empty or the first model
        if (list.length > 0 && !list.includes(byoeModel)) {
          // Keep it as is or default to first
        }
      } else {
        setModels([]);
      }
    } catch (err: any) {
      console.warn("Could not fetch models:", err);
      // Silence warning, just fallback to manual input
      setModels([]);
    } finally {
      setFetchingModels(false);
    }
  };

  useEffect(() => {
    if (user.byoeUrl) {
      fetchModels(user.byoeUrl, user.byoeKey || "");
    }
  }, []);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setSuccess(false);
    setError(null);

    try {
      const response = await fetch("/api/user/byoe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          byoeUrl: byoeUrl.trim() || null,
          byoeKey: byoeKey.trim() || null,
          byoeModel: byoeModel.trim() || null,
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to update settings");
      }

      const data = await response.json();
      onUpdateUser(data.user);
      setSuccess(true);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to update configuration");
    } finally {
      setLoading(false);
    }
  };

  const handleClear = async () => {
    setLoading(true);
    setSuccess(false);
    setError(null);
    try {
      const response = await fetch("/api/user/byoe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          byoeUrl: null,
          byoeKey: null,
          byoeModel: null,
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to clear settings");
      }

      const data = await response.json();
      onUpdateUser(data.user);
      setByoeUrl("");
      setByoeKey("");
      setByoeModel("");
      setModels([]);
      setSuccess(true);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to clear configuration");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 max-w-xl mx-auto">
    <Card className="bg-card/40 backdrop-blur-md border border-border/80 shadow-xl overflow-hidden">
      <CardHeader className="border-b border-border/50 bg-card/50">
        <CardTitle className="flex items-center gap-2 text-xl font-bold">
          <Server className="w-5 h-5 text-indigo-400" />
          <span>Bring Your Own Endpoint (BYOE)</span>
        </CardTitle>
        <CardDescription className="text-xs leading-relaxed mt-1">
          Donate interaction data using your own API endpoint and compute. By entering your endpoint details below, chat requests will stream directly through your custom API key.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-6">
        <form onSubmit={handleSave} className="space-y-6">
          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 text-destructive text-xs rounded-xl flex items-center gap-2">
              <HelpCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs rounded-xl flex items-center gap-2">
              <CheckCircle className="w-4 h-4 flex-shrink-0" />
              <span>Configuration saved successfully!</span>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="byoeUrl" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              API Base URL
            </Label>
            <div className="relative">
              <Input
                id="byoeUrl"
                type="url"
                value={byoeUrl}
                onChange={e => {
                  setByoeUrl(e.target.value);
                  setModels([]); // clear list when URL changes
                }}
                placeholder="https://api.openai.com/v1"
                className="pl-10 h-11 bg-background/50 border-input rounded-xl text-sm"
              />
              <Server className="absolute left-3.5 top-3.5 w-4 h-4 text-muted-foreground" />
            </div>
            <p className="text-[10px] text-muted-foreground/80 leading-relaxed px-1">
              The target OpenAI v1-compatible completions endpoint. Supports local servers (e.g. <code>https://pizero:8008/v1</code>).
            </p>
            {byoeUrl && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fetchModels(byoeUrl, byoeKey)}
                disabled={fetchingModels}
                className="mt-1 h-8 rounded-lg text-xs gap-1 hover:bg-muted"
              >
                <RefreshCw className={`w-3 h-3 ${fetchingModels ? "animate-spin" : ""}`} />
                <span>{fetchingModels ? "Fetching models..." : "Fetch Available Models"}</span>
              </Button>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="byoeKey" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              API Key (Optional)
            </Label>
            <div className="relative">
              <Input
                id="byoeKey"
                type="password"
                value={byoeKey}
                onChange={e => setByoeKey(e.target.value)}
                placeholder="sk-..."
                className="pl-10 h-11 bg-background/50 border-input rounded-xl text-sm"
              />
              <Key className="absolute left-3.5 top-3.5 w-4 h-4 text-muted-foreground" />
            </div>
            <p className="text-[10px] text-muted-foreground/80 leading-relaxed px-1">
              Your API key if required by the endpoint. Can be left blank for local servers.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="byoeModel" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Model ID
            </Label>
            <div className="relative">
              <select
                id="byoeModel"
                value={byoeModel}
                onChange={e => setByoeModel(e.target.value)}
                disabled={fetchingModels || !byoeUrl}
                className="w-full h-11 bg-background/50 border border-input rounded-xl text-sm px-3 text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              >
                {models.length === 0 ? (
                  <option value="">(Enter API Base URL and click Fetch Models to populate)</option>
                ) : (
                  <>
                    <option value="">(Select a model)</option>
                    {models.map(m => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </>
                )}
              </select>
            </div>
            <p className="text-[10px] text-muted-foreground/80 leading-relaxed px-1">
              The model selected from the remote endpoint's <code>v1/models</code> list.
            </p>
          </div>

          <div className="pt-2 flex gap-3">
            <Button
              type="submit"
              disabled={loading}
              className="flex-1 h-11 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-semibold shadow-lg shadow-indigo-600/10"
            >
              {loading ? "Saving Configuration..." : "Save Configuration"}
            </Button>
            {(user.byoeUrl || user.byoeKey || user.byoeModel) && (
              <Button
                type="button"
                variant="outline"
                onClick={handleClear}
                disabled={loading}
                className="h-11 border-border/80 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/20 rounded-xl text-sm"
              >
                Clear Endpoint
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>

    {/* Data Collection Proxy */}
    <Card className="bg-card/40 backdrop-blur-md border border-border/80 shadow-xl overflow-hidden">
      <CardHeader className="border-b border-border/50 bg-card/50">
        <CardTitle className="flex items-center gap-2 text-xl font-bold">
          <Network className="w-5 h-5 text-indigo-400" />
          <span>Data Collection Proxy</span>
        </CardTitle>
        <CardDescription className="text-xs leading-relaxed mt-1">
          Route any OpenAI-compatible tool (VS Code, opencode, Cursor, scripts…) through our proxy.
          Point the tool at the endpoint below using your personal key — requests are logged for
          open dataset collection and forwarded to your configured endpoint.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-6 space-y-5">
        {/* Base URL */}
        <div className="space-y-2">
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Base URL
          </Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 h-11 flex items-center px-3 rounded-xl bg-background/50 border border-input text-sm font-mono text-foreground/90 truncate">
              {proxyBase}
            </code>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => copyToClipboard("url", proxyBase)}
              className="h-11 w-11 flex-shrink-0 rounded-xl"
              title="Copy base URL"
            >
              {copiedField === "url" ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
        </div>

        {/* API Key */}
        <div className="space-y-2">
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            API Key
          </Label>
          {apiKey ? (
            <>
              <div className="flex items-center gap-2">
                <code className="flex-1 h-11 flex items-center px-3 rounded-xl bg-background/50 border border-input text-sm font-mono text-foreground/90 truncate">
                  {apiKey}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => copyToClipboard("key", apiKey)}
                  className="h-11 w-11 flex-shrink-0 rounded-xl"
                  title="Copy API key"
                >
                  {copiedField === "key" ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
              <div className="flex gap-3 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => updateApiKey(false)}
                  disabled={keyLoading}
                  className="h-9 rounded-lg text-xs gap-1.5"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${keyLoading ? "animate-spin" : ""}`} />
                  <span>Regenerate</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => updateApiKey(true)}
                  disabled={keyLoading}
                  className="h-9 rounded-lg text-xs gap-1.5 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/20"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Revoke</span>
                </Button>
              </div>
              <p className="text-[10px] text-amber-400/80 leading-relaxed px-1">
                Treat this like a password. Regenerating invalidates the previous key immediately.
              </p>
            </>
          ) : (
            <div className="space-y-2">
              <Button
                type="button"
                onClick={() => updateApiKey(false)}
                disabled={keyLoading}
                className="h-11 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold gap-2"
              >
                <Key className="w-4 h-4" />
                <span>{keyLoading ? "Generating…" : "Generate API Key"}</span>
              </Button>
              <p className="text-[10px] text-muted-foreground/80 leading-relaxed px-1">
                No key yet. Generate one to start routing external tools through the logging proxy.
              </p>
            </div>
          )}
        </div>

        {/* VS Code setup — secure flow (key stored in VS Code Secret Storage) */}
        <div className="space-y-3">
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Code2 className="w-3.5 h-3.5" /> Add to VS Code
          </Label>

          <ol className="space-y-2.5 text-[11px] text-muted-foreground leading-relaxed">
            <li className="flex gap-2">
              <span className="flex-shrink-0 w-4 h-4 rounded-full bg-indigo-500/15 text-indigo-400 text-[9px] font-bold flex items-center justify-center mt-0.5">1</span>
              <span>
                Command Palette (<code>⌘⇧P</code> / <code>Ctrl+Shift+P</code>) → run{" "}
                <code>Chat: Manage Language Models</code> → <strong className="text-foreground/85">Add Custom Endpoint</strong> (OpenAI-compatible).
              </span>
            </li>

            <li className="flex gap-2">
              <span className="flex-shrink-0 w-4 h-4 rounded-full bg-indigo-500/15 text-indigo-400 text-[9px] font-bold flex items-center justify-center mt-0.5">2</span>
              <div className="flex-1 space-y-1">
                <div>When it asks for the <strong className="text-foreground/85">Base URL</strong>, paste:</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-2 py-1.5 rounded-lg bg-background/60 border border-input font-mono text-[10px] truncate">{proxyBase}</code>
                  <Button type="button" variant="outline" size="sm" onClick={() => copyToClipboard("baseurl", proxyBase)} className="h-8 rounded-lg text-[10px] gap-1 flex-shrink-0">
                    {copiedField === "baseurl" ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>Copy</span>
                  </Button>
                </div>
              </div>
            </li>

            <li className="flex gap-2">
              <span className="flex-shrink-0 w-4 h-4 rounded-full bg-indigo-500/15 text-indigo-400 text-[9px] font-bold flex items-center justify-center mt-0.5">3</span>
              <div className="flex-1 space-y-1">
                <div>When it asks for the <strong className="text-foreground/85">API key</strong>, paste yours — VS Code stores it securely (it never lands in the JSON):</div>
                {apiKey ? (
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1.5 rounded-lg bg-background/60 border border-input font-mono text-[10px] truncate">{apiKey}</code>
                    <Button type="button" variant="outline" size="sm" onClick={() => copyToClipboard("vscodekey", apiKey)} className="h-8 rounded-lg text-[10px] gap-1 flex-shrink-0">
                      {copiedField === "vscodekey" ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      <span>Copy</span>
                    </Button>
                  </div>
                ) : (
                  <div className="text-[10px] text-amber-400/80">Generate an API key above first.</div>
                )}
              </div>
            </li>

            <li className="flex gap-2">
              <span className="flex-shrink-0 w-4 h-4 rounded-full bg-indigo-500/15 text-indigo-400 text-[9px] font-bold flex items-center justify-center mt-0.5">4</span>
              <div className="flex-1 space-y-1.5">
                <div>
                  Open the generated config (<code>chatLanguageModels.json</code>) and replace its{" "}
                  <code>"models"</code> array with your full model list:
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    onClick={copyVscodeModels}
                    disabled={vscodeState === "loading"}
                    className="h-9 rounded-lg bg-[#0066b8] hover:bg-[#0a72c9] text-white text-xs font-semibold gap-2"
                  >
                    {vscodeState === "loading" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : vscodeState === "done" ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{vscodeState === "done" ? `Copied ${vscodeModelCount} model${vscodeModelCount === 1 ? "" : "s"}!` : "Copy models"}</span>
                  </Button>
                  <Button type="button" variant="outline" onClick={downloadVscodeModels} className="h-9 rounded-lg text-xs gap-2">
                    <Download className="w-3.5 h-3.5" />
                    <span>Download</span>
                  </Button>
                </div>
                {vscodeState === "error" && (
                  <div className="text-[10px] text-destructive">Couldn't fetch models (endpoint unreachable or clipboard blocked).</div>
                )}
              </div>
            </li>
          </ol>

          <p className="text-[10px] text-muted-foreground/80 leading-relaxed px-1 flex items-start gap-1.5">
            <CheckCircle className="w-3 h-3 text-emerald-400/70 flex-shrink-0 mt-0.5" />
            <span>Your key stays in VS Code's encrypted Secret Storage — the config only references it (<code>{"${input:...}"}</code>), so it's never written in plain text.</span>
          </p>
        </div>

        {/* Usage hint */}
        <div className="rounded-xl bg-muted/30 border border-border/50 p-3.5 text-[11px] text-muted-foreground leading-relaxed space-y-1">
          <div className="font-semibold text-foreground/80">Example (curl):</div>
          <pre className="overflow-x-auto font-mono text-[10px] text-muted-foreground/90 whitespace-pre-wrap">
{`curl ${proxyBase}/chat/completions \\
  -H "Authorization: Bearer ${apiKey || "<your-api-key>"}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${byoeModel || user.byoeModel || "<model>"}","messages":[{"role":"user","content":"hi"}]}'`}
          </pre>
        </div>
      </CardContent>
    </Card>
    </div>
  );
}
