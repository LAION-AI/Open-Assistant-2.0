import { useState, useEffect, type FormEvent } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Server, Key, Brain, CheckCircle, HelpCircle, RefreshCw, Copy, Check, Trash2, Network, Code2, Download, Loader2, Trophy, Eye, EyeOff, Terminal } from "lucide-react";
import { LoginMethods } from "./LoginMethods";
import { RedactionSettings } from "./RedactionSettings";
import { TwoFactorSettings } from "./TwoFactorSettings";

interface User {
  id: string;
  username: string;
  email?: string | null;
  credits: number;
  byoeUrl?: string | null;
  byoeKey?: string | null;
  byoeModel?: string | null;
  hasApiKey?: boolean;
  emailVerified?: number;
  hasPassword?: boolean;
  hasPasskey?: boolean;
  twoFactorEnabled?: boolean;
  twoFactorMethod?: string | null;
  backupCodesRemaining?: number;
  onboarded?: boolean;
  showInLeaderboard?: number;
  isAdmin: number;
}

interface SettingsPanelProps {
  user: User;
  onUpdateUser: (updatedUser: User) => void;
  subTab: "byoe" | "v1proxy" | "pyproxy";
  onSubTabChange: (tab: "byoe" | "v1proxy" | "pyproxy") => void;
}

export function SettingsPanel({ user, onUpdateUser, subTab, onSubTabChange }: SettingsPanelProps) {
  const [byoeUrl, setByoeUrl] = useState(user.byoeUrl || "");
  const [byoeKey, setByoeKey] = useState(user.byoeKey || "");
  const [byoeModel, setByoeModel] = useState(user.byoeModel || "");
  const [showByoeKey, setShowByoeKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The email 2FA method needs working SMTP; hide it when the server has none.
  const [emailAvailable, setEmailAvailable] = useState(false);
  useEffect(() => {
    fetch("/api/auth/email/status")
      .then(r => r.json())
      .then(d => setEmailAvailable(!!d.emailVerification))
      .catch(() => {});
  }, []);

  // Pull the authoritative user record after a security change, so flags like
  // twoFactorEnabled / backupCodesRemaining reflect the server, not a guess.
  const refreshUser = async () => {
    try {
      const r = await fetch("/api/auth/me");
      if (r.ok) {
        const d = await r.json();
        if (d.user) onUpdateUser(d.user);
      }
    } catch {}
  };

  // Data-collection proxy API key. Only the hash is stored server-side, so the
  // plaintext is only ever held here transiently right after (re)generation;
  // `user.hasApiKey` tells us whether a key exists at all across reloads.
  const [apiKey, setApiKey] = useState<string | null>(null);
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
    onUpdateUser({ ...user, hasApiKey: !!d.apiKey });
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
      onUpdateUser({ ...user, hasApiKey: !!data.apiKey });
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
        
        // If the current model is not in the list, default to the first model
        if (list.length > 0 && !list.includes(byoeModel)) {
          setByoeModel(list[0]);
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
    <LoginMethods user={user} onUpdateUser={onUpdateUser} />

    {/* Anchor target for the "Set up 2FA" banner link. */}
    <div id="two-factor" className="scroll-mt-24">
      <TwoFactorSettings user={user} emailAvailable={emailAvailable} onUpdated={refreshUser} />
    </div>

    <RedactionSettings />
       {/* Sub-tab selection pills */}
    <div className="flex rounded-xl bg-background/50 border border-border/60 p-1.5 gap-1.5 animate-fade-in">
      <button
        type="button"
        onClick={() => onSubTabChange("byoe")}
        className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 text-xs font-semibold rounded-lg transition-all duration-200 cursor-pointer ${
          subTab === "byoe"
            ? "bg-indigo-600/15 border border-indigo-500/30 text-indigo-400 shadow-sm"
            : "text-muted-foreground hover:text-foreground border border-transparent"
        }`}
      >
        <Server className="w-3.5 h-3.5" />
        <span>BYOE Endpoint</span>
      </button>

      <button
        type="button"
        onClick={() => onSubTabChange("v1proxy")}
        className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 text-xs font-semibold rounded-lg transition-all duration-200 cursor-pointer ${
          subTab === "v1proxy"
            ? "bg-amber-500/15 border border-amber-500/30 text-amber-400 shadow-sm"
            : "text-muted-foreground hover:text-foreground border border-transparent"
        }`}
      >
        <Network className="w-3.5 h-3.5" />
        <span>V1 Proxy (API Key)</span>
      </button>

      <button
        type="button"
        onClick={() => onSubTabChange("pyproxy")}
        className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 text-xs font-semibold rounded-lg transition-all duration-200 cursor-pointer ${
          subTab === "pyproxy"
            ? "bg-rose-500/15 border border-rose-500/30 text-rose-400 shadow-sm"
            : "text-muted-foreground hover:text-foreground border border-transparent"
        }`}
      >
        <Terminal className="w-3.5 h-3.5" />
        <span>Python SDK / Proxy</span>
      </button>
    </div>

    {/* BYOE Card Option */}
    {subTab === "byoe" && (
      <Card className="bg-gradient-to-br from-indigo-500/5 to-violet-500/5 bg-card/40 border border-indigo-500/25 shadow-xl overflow-hidden backdrop-blur-md animate-fade-in pt-0">
        <CardHeader className="border-b border-indigo-500/20 bg-indigo-500/10 pt-6">
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
                  className="mt-2 text-xs font-semibold flex items-center gap-1.5"
                >
                  <RefreshCw className={`w-3 h-3 ${fetchingModels ? "animate-spin" : ""}`} />
                  <span>{fetchingModels ? "Fetching Available Models..." : "Fetch Available Models"}</span>
                </Button>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="byoeKey" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                API Key
              </Label>
              <div className="relative">
                <Input
                  id="byoeKey"
                  type={showByoeKey ? "text" : "password"}
                  value={byoeKey}
                  onChange={e => setByoeKey(e.target.value)}
                  placeholder="••••••••••••••••••••••••••••••••••••••••••••"
                  className="h-11 rounded-xl pr-10 bg-background/50 font-mono"
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() => setShowByoeKey(!showByoeKey)}
                  className="absolute right-3 top-3.5 text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  {showByoeKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground/80 leading-relaxed px-1">
                Your API key if required by the endpoint. Can be left blank for local servers.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="byoeModel" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Default Model ID
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
                      <option value="">(Select default model)</option>
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
                The fallback model used when an incoming proxy request does not specify one.
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
    )}

    {/* V1 Proxy Card Option */}
    {subTab === "v1proxy" && (
      <Card className="bg-gradient-to-br from-amber-500/5 to-orange-500/5 bg-card/40 border border-amber-500/25 shadow-xl overflow-hidden backdrop-blur-md animate-fade-in pt-0">
        <CardHeader className="border-b border-amber-500/20 bg-amber-500/10 pt-6">
          <CardTitle className="flex items-center gap-2 text-xl font-bold">
            <Network className="w-5 h-5 text-amber-400" />
            <span>Data Collection Proxy (V1 Proxy)</span>
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
            {(apiKey || user.hasApiKey) ? (
              <>
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
                    <p className="text-[10px] text-amber-400/90 leading-relaxed px-1">
                      Copy it now — for your security this key is only shown once and can't be retrieved later.
                    </p>
                  </>
                ) : (
                  <div className="text-[11px] text-muted-foreground/90 leading-relaxed px-1 py-2 rounded-xl bg-background/40 border border-input">
                    An API key is set but hidden for security. Regenerate to issue a new one — the previous key stops working immediately.
                  </div>
                )}
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

          {/* VS Code setup — secure flow */}
          <div className="space-y-3">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Code2 className="w-3.5 h-3.5" /> Add to VS Code
            </Label>

            <ol className="space-y-2.5 text-[11px] text-muted-foreground leading-relaxed">
              <li className="flex gap-2">
                <span className="flex-shrink-0 w-4 h-4 rounded-full bg-amber-500/15 text-amber-400 text-[9px] font-bold flex items-center justify-center mt-0.5">1</span>
                <span>
                  Command Palette (<code>⌘⇧P</code> / <code>Ctrl+Shift+P</code>) → run{" "}
                  <code>Chat: Manage Language Models</code> → <strong className="text-foreground/85">Add Custom Endpoint</strong> (OpenAI-compatible).
                </span>
              </li>

              <li className="flex gap-2">
                <span className="flex-shrink-0 w-4 h-4 rounded-full bg-amber-500/15 text-amber-400 text-[9px] font-bold flex items-center justify-center mt-0.5">2</span>
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
                <span className="flex-shrink-0 w-4 h-4 rounded-full bg-amber-500/15 text-amber-400 text-[9px] font-bold flex items-center justify-center mt-0.5">3</span>
                <div className="flex-1 space-y-1">
                  <div>When it asks for the <strong className="text-foreground/85">API key</strong>, paste yours — VS Code stores it securely:</div>
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
                <span className="flex-shrink-0 w-4 h-4 rounded-full bg-amber-500/15 text-amber-400 text-[9px] font-bold flex items-center justify-center mt-0.5">4</span>
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
                </div>
              </li>
            </ol>

            <p className="text-[10px] text-muted-foreground/80 leading-relaxed px-1 flex items-start gap-1.5">
              <CheckCircle className="w-3 h-3 text-emerald-400/70 flex-shrink-0 mt-0.5" />
              <span>Your key stays in VS Code's encrypted Secret Storage — the config only references it, so it's never written in plain text.</span>
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
    )}

    {/* Python CLI Proxy Card Option */}
    {subTab === "pyproxy" && (
      <Card className="bg-gradient-to-br from-rose-500/5 to-pink-500/5 bg-card/40 border border-rose-500/25 shadow-xl overflow-hidden backdrop-blur-md animate-fade-in pt-0">
        <CardHeader className="border-b border-rose-500/20 bg-rose-500/10 pt-6">
          <CardTitle className="flex items-center gap-2 text-xl font-bold">
            <Terminal className="w-5 h-5 text-rose-400" />
            <span>Open Assistant Proxy CLI</span>
          </CardTitle>
          <CardDescription className="text-xs leading-relaxed mt-1">
            Install and configure the local completions proxy on your machine to automatically redact PII on-device before donating traces.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-6 space-y-4">
          <div className="space-y-3 font-mono text-[10px] leading-relaxed">
            <div>
              <span className="text-muted-foreground"># 1. Install package from the git repository branch</span>
              <div className="text-foreground mt-1 p-1.5 rounded bg-black/40 border border-border/20 overflow-x-auto whitespace-pre-wrap select-all">
                <code>uv pip install "git+https://github.com/LAION-AI/Open-Assistant-2.0.git@first-poc#subdirectory=pip-library"</code>
              </div>
            </div>
            
            <div>
              <span className="text-muted-foreground"># 2. Configure proxy settings (paste your API key when prompted)</span>
              <div className="text-foreground mt-1 p-1.5 rounded bg-black/40 border border-border/20">
                <code>oa-proxy config</code>
              </div>
            </div>

            <div>
              <span className="text-muted-foreground"># 3. Setup the redactor model (tqdm setup progress)</span>
              <div className="text-foreground mt-1 p-1.5 rounded bg-black/40 border border-border/20">
                <code>oa-proxy setup</code>
              </div>
            </div>
            
            <div>
              <span className="text-muted-foreground"># 4. Start local proxy on port 1010</span>
              <div className="text-foreground mt-1 p-1.5 rounded bg-black/40 border border-border/20 font-sans">
                <code className="font-mono">oa-proxy start</code>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    )}

    {/* Leaderboard Privacy */}
    <Card className="bg-card/40 backdrop-blur-md border border-border/80 shadow-xl overflow-hidden">
      <CardContent className="p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0">
              <Trophy className="w-4 h-4 text-amber-400" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold">Leaderboard Visibility</div>
              <div className="text-[11px] text-muted-foreground leading-relaxed">
                {user.showInLeaderboard !== 0 ? "Your username and stats appear on the public leaderboard." : "You are hidden from the public leaderboard."}
              </div>
            </div>
          </div>
          <button
            onClick={async () => {
              const newVal = user.showInLeaderboard === 0;
              try {
                const res = await fetch("/api/user/leaderboard", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ show: newVal }),
                });
                if (!res.ok) throw new Error("Failed to update preference");
                const data = await res.json();
                onUpdateUser(data.user);
              } catch (err) {
                console.error("Leaderboard toggle error:", err);
              }
            }}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 flex-shrink-0 cursor-pointer ${
              user.showInLeaderboard !== 0 ? "bg-emerald-600" : "bg-muted border border-border/50"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${
                user.showInLeaderboard !== 0 ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>
      </CardContent>
    </Card>
    </div>
  );
}
