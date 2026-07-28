import { useState } from "react";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { AlertTriangle, Trash2, UserX } from "lucide-react";

type Scope = "traces" | "account";

/**
 * Self-service erasure (GDPR Art. 17).
 *
 * Two scopes, because they are genuinely different asks: "stop holding what I
 * contributed" and "forget me entirely". Both require typing the username —
 * these are irreversible and there is no undo, no soft delete and no grace
 * period, which the copy says plainly rather than implying.
 */
export function DangerZone({ username }: { username: string }) {
  const [scope, setScope] = useState<Scope | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const close = () => {
    setScope(null);
    setConfirm("");
    setError(null);
  };

  const run = async () => {
    if (!scope) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/user/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, confirm }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Deletion failed");

      if (scope === "account") {
        // The session cookie is already cleared server-side; reload into the
        // signed-out state rather than leaving a dead session on screen.
        window.location.href = "/";
        return;
      }
      setDone(`Deleted ${data.deleted} contribution${data.deleted === 1 ? "" : "s"}.`);
      close();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const rows: { scope: Scope; icon: typeof Trash2; title: string; body: string; cta: string }[] = [
    {
      scope: "traces",
      icon: Trash2,
      title: "Delete all my contributions",
      body: "Removes every chat, proxy interaction and imported trace you have contributed. Your account, settings and API key stay as they are.",
      cta: "Delete data",
    },
    {
      scope: "account",
      icon: UserX,
      title: "Delete my account",
      body: "Removes your account, passkeys, two-factor secrets, consent records and all of your contributions. You will be signed out immediately.",
      cta: "Delete account",
    },
  ];

  return (
    <Card className="bg-card/40 backdrop-blur-md border border-destructive/30 shadow-xl overflow-hidden">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-destructive" />
          <h3 className="text-sm font-semibold text-destructive">Danger Zone</h3>
        </div>

        {done && (
          <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[11px] rounded-lg">
            {done}
          </div>
        )}

        {rows.map(row => (
          <div key={row.scope} className="space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-destructive/10 border border-destructive/20 flex items-center justify-center flex-shrink-0">
                  <row.icon className="w-4 h-4 text-destructive" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{row.title}</div>
                  <div className="text-[11px] text-muted-foreground leading-relaxed">{row.body}</div>
                </div>
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  setDone(null);
                  setScope(scope === row.scope ? null : row.scope);
                  setConfirm("");
                  setError(null);
                }}
                className="h-8 px-3 text-[11px] border-destructive/40 text-destructive hover:bg-destructive/10 flex-shrink-0"
              >
                {row.cta}
              </Button>
            </div>

            {scope === row.scope && (
              <div className="ml-12 p-3 rounded-xl bg-destructive/5 border border-destructive/20 space-y-2.5">
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  This cannot be undone.{" "}
                  {row.scope === "account"
                    ? "Everything listed above is erased immediately."
                    : "Every contribution you have made is erased immediately."}{" "}
                  Data that is already part of a published dataset release cannot be recalled —
                  see the{" "}
                  <a href="/privacy" target="_blank" className="text-indigo-400 hover:underline">
                    Privacy Policy
                  </a>
                  . Type <strong className="text-foreground">{username}</strong> to confirm.
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                    placeholder={username}
                    autoComplete="off"
                    className="h-8 text-xs rounded-lg"
                  />
                  <Button
                    onClick={run}
                    disabled={busy || confirm !== username}
                    className="h-8 px-3 text-[11px] bg-destructive hover:bg-destructive/90 text-white flex-shrink-0 disabled:opacity-50"
                  >
                    {busy ? "Deleting…" : "Confirm"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={close}
                    disabled={busy}
                    className="h-8 px-3 text-[11px] flex-shrink-0"
                  >
                    Cancel
                  </Button>
                </div>
                {error && <p className="text-[11px] text-destructive">{error}</p>}
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
