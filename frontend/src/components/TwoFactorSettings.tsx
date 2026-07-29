import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import {
  ShieldCheck,
  ShieldAlert,
  Smartphone,
  Mail,
  Loader2,
  AlertCircle,
  CheckCircle,
  Copy,
  Check,
  KeyRound,
  Fingerprint,
} from "lucide-react";

interface Props {
  user: {
    hasPassword?: boolean;
    hasPasskey?: boolean;
    email?: string | null;
    twoFactorEnabled?: boolean;
    twoFactorMethod?: string | null;
    backupCodesRemaining?: number;
  };
  onUpdated: () => void;
  emailAvailable: boolean;
}

type Step = "idle" | "totp-setup" | "totp-confirm" | "email-confirm" | "codes" | "disable" | "regen";

export function TwoFactorSettings({ user, onUpdated, emailAvailable }: Props) {
  const [step, setStep] = useState<Step>("idle");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [setupData, setSetupData] = useState<{ formatted: string; qrSvg: string } | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  const post = async (url: string, body: any = {}) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error || "Something went wrong");
      return { ok: res.ok, data };
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setStep("idle");
    setCode("");
    setPassword("");
    setError(null);
    setSetupData(null);
    setBackupCodes(null);
  };

  const startTotp = async () => {
    const { ok, data } = await post("/api/user/2fa/totp/setup");
    if (ok) {
      setSetupData({ formatted: data.formatted, qrSvg: data.qrSvg });
      setStep("totp-confirm");
    }
  };

  const confirmTotp = async () => {
    const { ok, data } = await post("/api/user/2fa/totp/enable", { code });
    if (ok) {
      setBackupCodes(data.backupCodes);
      setStep("codes");
      onUpdated();
    }
  };

  const startEmail = async () => {
    const { ok, data } = await post("/api/user/2fa/email/start");
    if (ok) {
      setNotice(`Code sent to ${data.sentTo}`);
      setStep("email-confirm");
    }
  };

  const confirmEmail = async () => {
    const { ok, data } = await post("/api/user/2fa/email/enable", { code });
    if (ok) {
      setBackupCodes(data.backupCodes);
      setStep("codes");
      onUpdated();
    }
  };

  const doDisable = async () => {
    const { ok } = await post("/api/user/2fa/disable", { password });
    if (ok) {
      reset();
      onUpdated();
    }
  };

  const doRegen = async () => {
    const { ok, data } = await post("/api/user/2fa/backup-codes", { password });
    if (ok) {
      setBackupCodes(data.backupCodes);
      setStep("codes");
      onUpdated();
    }
  };

  const copyCodes = () => {
    if (!backupCodes) return;
    navigator.clipboard.writeText(backupCodes.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Passkey-only accounts: nothing to add. Say why rather than hiding the card.
  if (!user.hasPassword) {
    return (
      <Card className="bg-card/40 border border-emerald-500/25 shadow-xl overflow-hidden backdrop-blur-md animate-fade-in pt-0">
        <CardHeader className="border-b border-emerald-500/20 bg-emerald-500/10 pt-6">
          <CardTitle className="flex items-center gap-2 text-xl font-bold">
            <Fingerprint className="w-5 h-5 text-emerald-400" />
            <span>Two-Factor Authentication</span>
          </CardTitle>
          <CardDescription className="text-xs leading-relaxed mt-1">
            Your account signs in with a passkey, which is already two factors — a device you hold plus
            the biometric or PIN that unlocks it — and it can't be phished. There's nothing to add here.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 sm:p-6">
          <div className="flex items-start gap-2.5 text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3">
            <ShieldCheck className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>Passkey protection is active. If you later add a password, set up 2FA to match it.</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const enabled = !!user.twoFactorEnabled;
  const accent = enabled ? "emerald" : "amber";

  return (
    <Card
      className={`bg-card/40 border shadow-xl overflow-hidden backdrop-blur-md animate-fade-in pt-0 ${
        enabled ? "border-emerald-500/25" : "border-amber-500/40"
      }`}
    >
      <CardHeader className={`border-b pt-6 ${enabled ? "border-emerald-500/20 bg-emerald-500/10" : "border-amber-500/20 bg-amber-500/10"}`}>
        <CardTitle className="flex items-center gap-2 text-xl font-bold">
          {enabled ? (
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
          ) : (
            <ShieldAlert className="w-5 h-5 text-amber-400" />
          )}
          <span>Two-Factor Authentication</span>
        </CardTitle>
        <CardDescription className="text-xs leading-relaxed mt-1">
          {enabled
            ? `Active — signing in needs your password plus a code from ${
                user.twoFactorMethod === "totp" ? "your authenticator app" : "your email"
              }.`
            : "Your account is protected by a password alone. Add a second factor so a leaked password isn't enough to get in."}
        </CardDescription>
      </CardHeader>

      <CardContent className="p-4 sm:p-6 space-y-4">
        {error && (
          <div className="p-2.5 bg-destructive/10 border border-destructive/20 text-destructive text-[11px] rounded-xl flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        {notice && step !== "idle" && (
          <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[11px] rounded-xl flex items-start gap-2">
            <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>{notice}</span>
          </div>
        )}

        {/* ---- Recovery codes (shown once, after enabling or regenerating) ---- */}
        {step === "codes" && backupCodes && (
          <div className="space-y-3">
            <div className="p-3 bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[11px] rounded-xl flex items-start gap-2">
              <KeyRound className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>
                <strong>Save these recovery codes now.</strong> Each works once, and they're the only way
                back in if you lose your device. This is the only time they're shown.
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 font-mono text-[12px] bg-background/60 border border-input rounded-xl p-3">
              {backupCodes.map(c => (
                <span key={c} className="tracking-wider">{c}</span>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={copyCodes} variant="outline" className="h-9 rounded-lg text-xs gap-2">
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? "Copied" : "Copy codes"}
              </Button>
              <Button onClick={reset} className="h-9 rounded-lg text-xs bg-emerald-600 hover:bg-emerald-700 text-white">
                I've saved them
              </Button>
            </div>
          </div>
        )}

        {/* ---- TOTP enrolment ---- */}
        {step === "totp-confirm" && setupData && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Scan this with Authy, Google or Microsoft Authenticator, 1Password, Apple Passwords — any
              TOTP app — then enter the 6-digit code it shows.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 items-center">
              <div
                className="bg-white p-2 rounded-xl flex-shrink-0 [&>svg]:w-[168px] [&>svg]:h-[168px]"
                dangerouslySetInnerHTML={{ __html: setupData.qrSvg }}
              />
              <div className="space-y-2 min-w-0 flex-1">
                <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Or enter this key manually
                </Label>
                <code className="block text-[11px] font-mono bg-background/60 border border-input rounded-lg p-2 break-all">
                  {setupData.formatted}
                </code>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                6-digit code
              </Label>
              <Input
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="h-11 rounded-xl font-mono tracking-[0.4em] text-center text-lg"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={confirmTotp} disabled={loading || code.length !== 6} className="h-10 rounded-lg text-xs bg-emerald-600 hover:bg-emerald-700 text-white gap-2">
                {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Verify & enable
              </Button>
              <Button onClick={reset} variant="ghost" className="h-10 rounded-lg text-xs">Cancel</Button>
            </div>
          </div>
        )}

        {/* ---- Email code enrolment ---- */}
        {step === "email-confirm" && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Enter the 6-digit code we just emailed you.</p>
            <Input
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              inputMode="numeric"
              autoComplete="one-time-code"
              className="h-11 rounded-xl font-mono tracking-[0.4em] text-center text-lg"
            />
            <div className="flex flex-wrap gap-2">
              <Button onClick={confirmEmail} disabled={loading || code.length !== 6} className="h-10 rounded-lg text-xs bg-emerald-600 hover:bg-emerald-700 text-white gap-2">
                {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Verify & enable
              </Button>
              <Button onClick={startEmail} variant="outline" disabled={loading} className="h-10 rounded-lg text-xs">Resend</Button>
              <Button onClick={reset} variant="ghost" className="h-10 rounded-lg text-xs">Cancel</Button>
            </div>
          </div>
        )}

        {/* ---- Password-confirmed actions ---- */}
        {(step === "disable" || step === "regen") && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {step === "disable"
                ? "Confirm your password to turn off two-factor authentication."
                : "Confirm your password to generate a new set of recovery codes. The old ones stop working."}
            </p>
            <Input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Current password"
              autoComplete="current-password"
              className="h-11 rounded-xl"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={step === "disable" ? doDisable : doRegen}
                disabled={loading || !password}
                className={`h-10 rounded-lg text-xs text-white gap-2 ${
                  step === "disable" ? "bg-destructive hover:bg-destructive/90" : "bg-indigo-600 hover:bg-indigo-700"
                }`}
              >
                {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {step === "disable" ? "Turn off 2FA" : "Generate new codes"}
              </Button>
              <Button onClick={reset} variant="ghost" className="h-10 rounded-lg text-xs">Cancel</Button>
            </div>
          </div>
        )}

        {/* ---- Idle: choose a method, or manage an active one ---- */}
        {step === "idle" && !enabled && (
          <div className="grid sm:grid-cols-2 gap-3">
            <button
              onClick={startTotp}
              disabled={loading}
              className="text-left p-4 rounded-xl border border-input bg-background/40 hover:bg-background/70 transition-colors space-y-1.5"
            >
              <div className="flex items-center gap-2 font-semibold text-sm">
                <Smartphone className="w-4 h-4 text-indigo-400" />
                Authenticator app
                <span className="text-[9px] uppercase tracking-wide text-emerald-400 font-bold">Recommended</span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Codes generated on your device — works offline and can't be intercepted in transit.
              </p>
            </button>
            <button
              onClick={startEmail}
              disabled={loading || !emailAvailable}
              className="text-left p-4 rounded-xl border border-input bg-background/40 hover:bg-background/70 transition-colors space-y-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-center gap-2 font-semibold text-sm">
                <Mail className="w-4 h-4 text-amber-400" />
                Email codes
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {emailAvailable
                  ? "A 6-digit code sent to your inbox at each sign-in. Simpler, but only as safe as your email."
                  : "Unavailable — this server has no SMTP configured."}
              </p>
            </button>
          </div>
        )}

        {step === "idle" && enabled && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="px-2 py-1 rounded-lg bg-emerald-500/15 text-emerald-400 font-semibold flex items-center gap-1.5">
                {user.twoFactorMethod === "totp" ? <Smartphone className="w-3.5 h-3.5" /> : <Mail className="w-3.5 h-3.5" />}
                {user.twoFactorMethod === "totp" ? "Authenticator app" : "Email codes"}
              </span>
              <span className="text-muted-foreground">
                {user.backupCodesRemaining ?? 0} recovery code{(user.backupCodesRemaining ?? 0) === 1 ? "" : "s"} left
              </span>
            </div>
            {(user.backupCodesRemaining ?? 0) <= 2 && (
              <div className="p-2.5 bg-amber-500/10 border border-amber-500/25 text-amber-300 text-[11px] rounded-xl flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <span>You're low on recovery codes — generate a fresh set so you don't get locked out.</span>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setStep("regen")} variant="outline" className="h-9 rounded-lg text-xs gap-2">
                <KeyRound className="w-3.5 h-3.5" /> New recovery codes
              </Button>
              {user.twoFactorMethod !== "totp" && (
                <Button onClick={startTotp} variant="outline" className="h-9 rounded-lg text-xs gap-2">
                  <Smartphone className="w-3.5 h-3.5" /> Switch to authenticator app
                </Button>
              )}
              <Button
                onClick={() => setStep("disable")}
                variant="ghost"
                className="h-9 rounded-lg text-xs text-destructive hover:bg-destructive/10"
              >
                Turn off
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
