import { useState, useEffect, type FormEvent } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Server, Key, Brain, CheckCircle, HelpCircle, RefreshCw, Copy, Check, Trash2, Network } from "lucide-react";

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
