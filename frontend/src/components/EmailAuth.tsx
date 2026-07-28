import { useState, type FormEvent } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Mail, Lock, User as UserIcon, Loader2, CheckCircle, AlertCircle, ArrowLeft, ShieldCheck, Smartphone } from "lucide-react";

type Mode = "menu" | "login" | "register" | "forgot" | "reset" | "2fa";

// Reset links land on /?reset=<token>; show the reset form when present.
function resetTokenFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("reset");
}

export function EmailAuth({ onAuthed }: { onAuthed: (user: any) => void }) {
  const initialReset = resetTokenFromUrl();
  const [mode, setMode] = useState<Mode>(initialReset ? "reset" : "menu");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Second-factor step: the challenge stands in for a session until the code
  // checks out, so nothing is signed in while it is pending.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [twoFaMethod, setTwoFaMethod] = useState<"totp" | "email">("totp");
  const [code, setCode] = useState("");

  const reset = (m: Mode) => {
    setMode(m);
    setError(null);
    setNotice(null);
    setPassword("");
  };

  const post = async (url: string, body: any) => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } finally {
      setLoading(false);
    }
  };

  const doLogin = async (e: FormEvent) => {
    e.preventDefault();
    const { ok, data } = await post("/api/auth/email/login", { email, password });
    if (ok && data.twoFactorRequired) {
      setChallenge(data.challenge);
      setTwoFaMethod(data.method === "email" ? "email" : "totp");
      setPassword("");
      setCode("");
      setMode("2fa");
    } else if (ok) onAuthed(data.user);
    else if (data.needsVerification) {
      setError("Please verify your email — check your inbox.");
      setNotice("resend");
    } else setError(data.error || "Login failed");
  };

  const doRegister = async (e: FormEvent) => {
    e.preventDefault();
    const { ok, data } = await post("/api/auth/email/register", { username, email, password });
    if (ok && data.user) onAuthed(data.user);
    else if (ok && data.needsVerification) {
      setNotice(`We sent a verification link to ${email}. Click it to activate your account.`);
      setMode("menu");
    } else setError(data.error || "Registration failed");
  };

  const doForgot = async (e: FormEvent) => {
    e.preventDefault();
    await post("/api/auth/email/forgot", { email });
    setNotice(`If an account exists for ${email}, a reset link is on its way.`);
  };

  const doReset = async (e: FormEvent) => {
    e.preventDefault();
    const { ok, data } = await post("/api/auth/email/reset", { token: initialReset, password });
    if (ok) {
      // Clean the token out of the URL and sign in.
      window.history.replaceState({}, "", window.location.pathname);
      onAuthed(data.user);
    } else setError(data.error || "Reset failed");
  };

  const doTwoFactor = async (e: FormEvent) => {
    e.preventDefault();
    const { ok, data } = await post("/api/auth/2fa/verify", { challenge, code });
    if (ok) onAuthed(data.user);
    else setError(data.error || "Verification failed");
  };

  const resendCode = async () => {
    await post("/api/auth/2fa/resend", { challenge });
    setNotice("A new code is on its way.");
  };

  const resend = async () => {
    await post("/api/auth/email/resend", { email });
    setNotice(`Verification link re-sent to ${email}.`);
  };

  const fieldEmail = (
    <div className="space-y-1.5">
      <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground px-1">Email</Label>
      <div className="relative">
        <Mail className="absolute left-3 top-3 w-4 h-4 text-muted-foreground" />
        <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" required className="pl-9 h-11 rounded-xl" />
      </div>
    </div>
  );
  const fieldPassword = (label: string, autoComplete: string) => (
    <div className="space-y-1.5">
      <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground px-1">{label}</Label>
      <div className="relative">
        <Lock className="absolute left-3 top-3 w-4 h-4 text-muted-foreground" />
        <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" autoComplete={autoComplete} required className="pl-9 h-11 rounded-xl" />
      </div>
    </div>
  );

  const alerts = (
    <>
      {error && (
        <div className="p-2.5 bg-destructive/10 border border-destructive/20 text-destructive text-[11px] rounded-xl flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      {notice && notice !== "resend" && (
        <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[11px] rounded-xl flex items-start gap-2">
          <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>{notice}</span>
        </div>
      )}
      {notice === "resend" && (
        <button type="button" onClick={resend} className="text-[11px] text-indigo-400 hover:underline">Resend verification email</button>
      )}
    </>
  );

  const submitBtn = (label: string) => (
    <Button type="submit" disabled={loading} className="w-full h-11 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold gap-2">
      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
      <span>{label}</span>
    </Button>
  );
  const backBtn = (
    <button type="button" onClick={() => reset("menu")} className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1">
      <ArrowLeft className="w-3 h-3" /> Back
    </button>
  );

  if (mode === "reset") {
    return (
      <form onSubmit={doReset} className="space-y-3">
        <p className="text-xs text-muted-foreground">Choose a new password for your account.</p>
        {fieldPassword("New password", "new-password")}
        {alerts}
        {submitBtn("Set new password & sign in")}
      </form>
    );
  }

  // Second factor. Takes over the panel so there's one obvious thing to do.
  if (mode === "2fa") {
    return (
      <form onSubmit={doTwoFactor} className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span>Two-factor verification</span>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed flex items-start gap-1.5">
          {twoFaMethod === "totp" ? (
            <>
              <Smartphone className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              Enter the 6-digit code from your authenticator app.
            </>
          ) : (
            <>
              <Mail className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              We emailed a 6-digit code to {email}. It expires in 10 minutes.
            </>
          )}
        </p>
        <Input
          value={code}
          onChange={e => setCode(e.target.value.replace(/[^0-9a-zA-Z-]/g, "").slice(0, 11))}
          placeholder="000000"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          required
          className="h-12 rounded-xl font-mono tracking-[0.4em] text-center text-lg"
        />
        {alerts}
        {submitBtn("Verify & sign in")}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              setChallenge(null);
              setCode("");
              reset("login");
            }}
            className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <ArrowLeft className="w-3 h-3" /> Back
          </button>
          {twoFaMethod === "email" && (
            <button type="button" onClick={resendCode} className="text-[11px] text-indigo-400 hover:underline">
              Send a new code
            </button>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground/70 text-center leading-relaxed">
          Lost your device? Enter one of your recovery codes above instead.
        </p>
      </form>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative flex items-center gap-3 py-1">
        <div className="flex-1 h-px bg-border/60" />
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground/70">or use email</span>
        <div className="flex-1 h-px bg-border/60" />
      </div>

      {mode === "menu" && (
        <div className="space-y-2">
          {notice && (
            <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[11px] rounded-xl flex items-start gap-2">
              <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /><span>{notice}</span>
            </div>
          )}
          <Button type="button" variant="outline" onClick={() => reset("login")} className="w-full h-11 rounded-xl gap-2 text-sm">
            <Mail className="w-4 h-4" /> Sign in with email
          </Button>
          <p className="text-center text-[11px] text-muted-foreground">
            No account?{" "}
            <button type="button" onClick={() => reset("register")} className="text-indigo-400 hover:underline">Create one</button>
          </p>
        </div>
      )}

      {mode === "login" && (
        <form onSubmit={doLogin} className="space-y-3">
          {fieldEmail}
          {fieldPassword("Password", "current-password")}
          {alerts}
          {submitBtn("Sign in")}
          <div className="flex items-center justify-between">
            {backBtn}
            <button type="button" onClick={() => reset("forgot")} className="text-[11px] text-muted-foreground hover:text-foreground">Forgot password?</button>
          </div>
        </form>
      )}

      {mode === "register" && (
        <form onSubmit={doRegister} className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground px-1">Username</Label>
            <div className="relative">
              <UserIcon className="absolute left-3 top-3 w-4 h-4 text-muted-foreground" />
              <Input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="yourname" autoComplete="username" required className="pl-9 h-11 rounded-xl" />
            </div>
          </div>
          {fieldEmail}
          {fieldPassword("Password (min 8 chars)", "new-password")}
          {alerts}
          {submitBtn("Create account")}
          {backBtn}
        </form>
      )}

      {mode === "forgot" && (
        <form onSubmit={doForgot} className="space-y-3">
          <p className="text-xs text-muted-foreground">Enter your email and we'll send a reset link.</p>
          {fieldEmail}
          {alerts}
          {submitBtn("Send reset link")}
          {backBtn}
        </form>
      )}
    </div>
  );
}
