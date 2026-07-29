import { useEffect, useState } from "react";
import { Clock, Database } from "lucide-react";

interface Status {
  pending: number;
  publishable: number;
  /** Unix seconds when the oldest pending contribution becomes publishable; 0 if none. */
  nextEligibleAt: number;
  embargoDays: number;
}

/**
 * The running clock on the 30-day publication window.
 *
 * The window is the whole counterweight to publication being a required term
 * rather than an opt-out, and a safeguard nobody can see is not much of a
 * safeguard. So this sits in the header on every page once a contributor has
 * uploaded anything, saying how long they still have to change their mind.
 *
 * Hidden entirely for an account that has contributed nothing — there is no
 * deadline to warn about, and a chip reading "0" would be noise.
 */
export function PublicationCountdown({
  refreshKey,
  onNavigate,
}: {
  /** Bump to re-read after an upload or a deletion. */
  refreshKey?: number;
  onNavigate?: (tab: string) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/user/publication-status")
      .then(r => (r.ok ? r.json() : null))
      .then(d => !cancelled && d && !d.error && setStatus(d))
      .catch(() => {
        // Informational only — stay silent rather than alarm anyone over a chip.
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (!status) return null;
  const { pending, publishable, nextEligibleAt, embargoDays } = status;
  if (pending === 0 && publishable === 0) return null;

  // Round up: with 12 hours left, "1 day" is the honest thing to say, and it is
  // the reading that leaves someone least likely to miss their window.
  const daysLeft =
    nextEligibleAt > 0
      ? Math.max(0, Math.ceil((nextEligibleAt * 1000 - Date.now()) / 86_400_000))
      : 0;

  const inWindow = pending > 0;
  const label = inWindow
    ? daysLeft <= 1
      ? `${pending} upload${pending === 1 ? "" : "s"} join${pending === 1 ? "s" : ""} the dataset within a day`
      : `${pending} upload${pending === 1 ? "" : "s"} join${pending === 1 ? "s" : ""} the dataset in ${daysLeft} days`
    : `${publishable} contribution${publishable === 1 ? "" : "s"} in the rolling dataset`;

  const title = inWindow
    ? `Uploads become eligible for a public release ${embargoDays} days after upload. ` +
      `Delete them before then — in My Uploads — and they are never published. ` +
      (publishable > 0 ? `${publishable} of your contributions are already past the window.` : "")
    : `All of your contributions have passed the ${embargoDays}-day window and may appear in a public release. ` +
      `Deleting them now removes them from future releases.`;

  return (
    <button
      type="button"
      onClick={() => onNavigate?.("uploads")}
      title={title}
      className={`hidden md:flex items-center gap-1.5 h-7 px-2.5 rounded-lg border text-[10px] font-semibold transition-colors cursor-pointer ${
        inWindow
          ? "bg-amber-500/10 border-amber-500/25 text-amber-300/90 hover:bg-amber-500/20"
          : "bg-emerald-500/10 border-emerald-500/25 text-emerald-300/90 hover:bg-emerald-500/20"
      }`}
    >
      {inWindow ? <Clock className="w-3 h-3" /> : <Database className="w-3 h-3" />}
      <span>{label}</span>
    </button>
  );
}
