import { useState, type FormEvent } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { addPasskey } from "../lib/auth";
import { Fingerprint, Mail, Lock, ShieldCheck, Loader2, CheckCircle, AlertCircle, Plus, Terminal } from "lucide-react";

interface User {
  email?: string | null;
  emailVerified?: number;
  hasPassword?: boolean;
  hasPasskey?: boolean;
}

export function LoginMethods({ user, onUpdateUser }: { user: User; onUpdateUser: (u: any) => void }) {
  const [pkBusy, setPkBusy] = useState(false);
  const [pkMsg, setPkMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const [showPw, setShowPw] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const refresh = async () => {
    const res = await fetch("/api/auth/me");
    if (res.ok) {
      const data = await res.json();
      onUpdateUser(data.user);
    }
  };

  const handleAddPasskey = async () => {
    setPkBusy(true);
    setPkMsg(null);
    const res = await addPasskey();
    setPkBusy(false);
    if (res.error) setPkMsg({ type: "err", text: res.error });
    else {
      setPkMsg({ type: "ok", text: "Passkey added — you can now sign in with it." });
      await refresh();
    }
  };

  const handleSetPassword = async (e: FormEvent) => {
    e.preventDefault();
    setPwBusy(true);
    setPwMsg(null);
    try {
      const body: any = { password };
      if (!user.email) body.email = email;
      const res = await fetch("/api/user/set-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setPassword("");
      setShowPw(false);
      setPwMsg({
        type: "ok",
        text: data.needsVerification
          ? `Saved! Check ${email} for a verification link to enable email sign-in.`
          : user.hasPassword
            ? "Password updated."
            : "Email login enabled.",
      });
      await refresh();
    } catch (err: any) {
      setPwMsg({ type: "err", text: err.message });
    } finally {
      setPwBusy(false);
    }
  };

  const Msg = ({ m }: { m: { type: "ok" | "err"; text: string } | null }) =>
    m ? (
      <div className={`text-[11px] flex items-start gap-1.5 ${m.type === "ok" ? "text-emerald-400" : "text-destructive"}`}>
        {m.type === "ok" ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> : <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
        <span>{m.text}</span>
      </div>
    ) : null;

  return (
    <Card className="bg-card/40 backdrop-blur-md border border-border/80 shadow-xl overflow-hidden">
      <CardHeader className="border-b border-border/50 bg-card/50">
        <CardTitle className="flex items-center gap-2 text-xl font-bold">
          <ShieldCheck className="w-5 h-5 text-indigo-400" />
          <span>Login & Security</span>
        </CardTitle>
        <CardDescription className="text-xs leading-relaxed mt-1">
          Add a second way to sign in. We recommend keeping a passkey — it's phishing-resistant.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-6 space-y-5">
        {/* Passkey */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 flex-shrink-0">
              <Fingerprint className="w-4.5 h-4.5" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold flex items-center gap-2">
                Passkey
                {user.hasPasskey && (
                  <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">enabled</span>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {user.hasPasskey ? "Add another device's passkey for backup." : "Passwordless, phishing-resistant sign-in."}
              </p>
            </div>
          </div>
          <Button onClick={handleAddPasskey} disabled={pkBusy} variant="outline" size="sm" className="rounded-lg gap-1.5 flex-shrink-0">
            {pkBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            <span>{user.hasPasskey ? "Add another" : "Add passkey"}</span>
          </Button>
        </div>
        <Msg m={pkMsg} />

        <div className="h-px bg-border/50" />

        {/* Email + password */}
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3 min-w-0">
              <div className="w-9 h-9 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 flex-shrink-0">
                <Mail className="w-4.5 h-4.5" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold flex items-center gap-2">
                  Email & password
                  {user.hasPassword && (
                    <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">enabled</span>
                  )}
                  {user.email && !user.emailVerified && (
                    <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">unverified</span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed truncate">
                  {user.email ? user.email : "Sign in with an email and password."}
                </p>
              </div>
            </div>
            {!showPw && (
              <Button onClick={() => setShowPw(true)} variant="outline" size="sm" className="rounded-lg gap-1.5 flex-shrink-0">
                <Lock className="w-3.5 h-3.5" />
                <span>{user.hasPassword ? "Change password" : "Set password"}</span>
              </Button>
            )}
          </div>

          {showPw && (
            <form onSubmit={handleSetPassword} className="space-y-3 rounded-xl border border-border/50 bg-background/30 p-3.5">
              {!user.email && (
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground px-1">Email</Label>
                  <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required className="h-10 rounded-lg" autoComplete="email" />
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground px-1">
                  {user.hasPassword ? "New password" : "Password"} (min 8 chars)
                </Label>
                <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required className="h-10 rounded-lg" autoComplete="new-password" />
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={pwBusy} className="h-10 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs gap-2">
                  {pwBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>{user.hasPassword ? "Update password" : "Enable email login"}</span>
                </Button>
                <Button type="button" variant="outline" onClick={() => { setShowPw(false); setPwMsg(null); }} className="h-10 rounded-lg text-xs">Cancel</Button>
              </div>
            </form>
          )}
          <Msg m={pwMsg} />
        </div>

        <div className="h-px bg-border/50" />

        {/* OA Proxy CLI Setup Instructions */}
        <div className="space-y-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 flex-shrink-0">
              <Terminal className="w-4.5 h-4.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold flex items-center gap-2">
                Open Assistant Proxy CLI
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed mb-3">
                Install and configure the local completions proxy on your machine to automatically redact PII on-device before donating traces.
              </p>
              
              <div className="space-y-3 rounded-xl border border-border/50 bg-background/30 p-4 font-mono text-[10px] leading-relaxed">
                <div>
                  <span className="text-muted-foreground"># 1. Install package</span>
                  <div className="text-foreground mt-1 p-1.5 rounded bg-black/40 border border-border/20">
                    <code>pip install open-assistant-proxy</code>
                  </div>
                </div>
                
                <div>
                  <span className="text-muted-foreground"># 2. Configure proxy settings (paste your API key when prompted)</span>
                  <div className="text-foreground mt-1 p-1.5 rounded bg-black/40 border border-border/20 font-sans">
                    <code className="font-mono">oa-proxy config</code>
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
                  <div className="text-foreground mt-1 p-1.5 rounded bg-black/40 border border-border/20">
                    <code>oa-proxy start</code>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
