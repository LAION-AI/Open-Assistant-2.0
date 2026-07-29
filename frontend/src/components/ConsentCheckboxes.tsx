import { useEffect, useState } from "react";

interface ConsentState {
  acceptedTerms: boolean;
  datasetConsent: boolean;
  showInLeaderboard: boolean;
}

interface ConsentCheckboxesProps {
  value: ConsentState;
  onChange: (next: ConsentState) => void;
  disabled?: boolean;
}

/**
 * The consent checkboxes shown on every signup path.
 *
 * They are deliberately separate controls: accepting the terms is required to
 * hold an account, while publishing your interactions and showing your username
 * on the leaderboard are optional and revocable. Pre-ticking either optional
 * box, or folding it into the first, would make it consent that was never
 * freely given — so both start empty and stay empty unless actively ticked.
 */
export function ConsentCheckboxes({ value, onChange, disabled }: ConsentCheckboxesProps) {
  const [consentText, setConsentText] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/legal")
      .then(r => (r.ok ? r.json() : null))
      .then(d => d && setConsentText(d.datasetConsentText))
      .catch(() => {
        // Fall back to the inline wording below; a failed fetch must not leave
        // the checkbox unlabelled.
      });
  }, []);

  return (
    <div className="space-y-3 pt-1">
      <label className="flex items-start gap-2.5 cursor-pointer group">
        <input
          type="checkbox"
          checked={value.acceptedTerms}
          disabled={disabled}
          onChange={e => onChange({ ...value, acceptedTerms: e.target.checked })}
          className="mt-0.5 h-3.5 w-3.5 rounded border-input accent-indigo-600 cursor-pointer"
        />
        <span className="text-[11px] leading-relaxed text-muted-foreground group-hover:text-foreground transition-colors">
          I have read and accept the{" "}
          <a href="/terms" target="_blank" className="text-indigo-400 hover:underline">
            Terms of Service
          </a>{" "}
          and{" "}
          <a href="/privacy" target="_blank" className="text-indigo-400 hover:underline">
            Privacy Policy
          </a>
          . I am at least 18 years old. <span className="text-muted-foreground/70">(required)</span>
        </span>
      </label>

      <label className="flex items-start gap-2.5 cursor-pointer group">
        <input
          type="checkbox"
          checked={value.datasetConsent}
          disabled={disabled}
          onChange={e => onChange({ ...value, datasetConsent: e.target.checked })}
          className="mt-0.5 h-3.5 w-3.5 rounded border-input accent-emerald-600 cursor-pointer"
        />
        <span className="text-[11px] leading-relaxed text-muted-foreground group-hover:text-foreground transition-colors">
          {consentText ??
            "I consent to my interactions being published as part of an open dataset under the CC-BY 4.0 licence, after filtering and PII removal."}{" "}
          <span className="text-muted-foreground/70">(optional — you can change this any time in Settings)</span>
        </span>
      </label>

      <label className="flex items-start gap-2.5 cursor-pointer group">
        <input
          type="checkbox"
          checked={value.showInLeaderboard}
          disabled={disabled}
          onChange={e => onChange({ ...value, showInLeaderboard: e.target.checked })}
          className="mt-0.5 h-3.5 w-3.5 rounded border-input accent-amber-600 cursor-pointer"
        />
        <span className="text-[11px] leading-relaxed text-muted-foreground group-hover:text-foreground transition-colors">
          Publish my username on the public leaderboard, alongside how much I
          have contributed.{" "}
          <span className="text-muted-foreground/70">(optional — off unless you tick it)</span>
        </span>
      </label>
    </div>
  );
}

export const EMPTY_CONSENT: ConsentState = {
  acceptedTerms: false,
  datasetConsent: false,
  showInLeaderboard: false,
};
export type { ConsentState };
