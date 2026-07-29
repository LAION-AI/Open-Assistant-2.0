import { useState } from "react";
import { ShieldAlert, ArrowRight, X } from "lucide-react";

// Dismissal is per-tab on purpose: an unprotected password account should be
// nagged again next visit, but not repeatedly within one session.
const DISMISS_KEY = "oa-2fa-warning-dismissed";

interface Props {
  user: { hasPassword?: boolean; twoFactorEnabled?: boolean };
  onNavigate: (tab: string) => void;
}

export function SecurityBanner({ user, onNavigate }: Props) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  // Only password logins need a second factor; passkeys already are one.
  if (!user.hasPassword || user.twoFactorEnabled || dismissed) return null;

  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {}
    setDismissed(true);
  };

  return (
    <div className="w-full bg-amber-500/10 border-b border-amber-500/25 flex-shrink-0">
      <div className="w-full px-3 sm:px-4 py-2 flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-amber-300">
        <ShieldAlert className="w-4 h-4 flex-shrink-0" />
        <span className="min-w-0 flex-1 leading-relaxed">
          <strong className="font-semibold">Two-factor authentication is off.</strong>{" "}
          <span className="hidden sm:inline text-amber-300/85">
            Your account is protected by a password alone — add a second factor so a leaked password
            isn't enough to sign in.
          </span>
        </span>
        <button
          onClick={() => onNavigate("settings-security")}
          className="font-semibold hover:underline flex items-center gap-1 flex-shrink-0"
        >
          Set up 2FA <ArrowRight className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={dismiss}
          title="Dismiss for this session"
          className="p-1 rounded-md hover:bg-amber-500/15 flex-shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
