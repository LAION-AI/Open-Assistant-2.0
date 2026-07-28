import { useState } from "react";
import { Button } from "./ui/button";
import { ScrollText } from "lucide-react";

/**
 * Shown when the terms a user accepted are no longer the current version.
 *
 * A version bump means the stored acceptance does not cover the document as it
 * now stands, so it has to be asked again rather than assumed — silently
 * carrying an old acceptance forward is precisely what makes a consent record
 * worthless. Accounts predating the consent system land here too, since they
 * have no recorded acceptance at all.
 */
export function TermsUpdateBanner({
  user,
  onAccepted,
}: {
  user: { termsCurrent?: boolean } | null;
  onAccepted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user || user.termsCurrent) return null;

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/user/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "terms", granted: true }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Could not record your acceptance");
      onAccepted();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 text-amber-300 text-[11px] flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
      <ScrollText className="w-3.5 h-3.5 flex-shrink-0" />
      <span>
        Our{" "}
        <a href="/terms" target="_blank" className="underline hover:text-amber-200">
          Terms of Service
        </a>{" "}
        and{" "}
        <a href="/privacy" target="_blank" className="underline hover:text-amber-200">
          Privacy Policy
        </a>{" "}
        have been updated. Please review and accept them to continue contributing.
      </span>
      {error && <span className="text-destructive">{error}</span>}
      <Button
        size="sm"
        onClick={accept}
        disabled={busy}
        className="h-6 px-2.5 text-[10px] bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 border border-amber-500/30"
      >
        {busy ? "Saving…" : "I accept"}
      </Button>
    </div>
  );
}
