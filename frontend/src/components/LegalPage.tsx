import { useEffect, useState } from "react";
import { Markdown } from "./Markdown";
import { Button } from "./ui/button";
import { ArrowLeft } from "lucide-react";

interface LegalDoc {
  slug: string;
  title: string;
  version?: string;
  markdown: string;
}

/**
 * Full-page view of a legal document, rendered from the Markdown the server
 * serves. Reachable without an account — § 5 DDG requires the Impressum to be
 * available to anyone, and someone deciding whether to sign up needs to read
 * the terms before they have credentials.
 */
export function LegalPage({ slug, onBack }: { slug: string; onBack: () => void }) {
  const [doc, setDoc] = useState<LegalDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setError(null);
    fetch(`/api/legal/${slug}`)
      .then(async r => {
        if (!r.ok) throw new Error("That document could not be found.");
        return r.json();
      })
      .then(d => !cancelled && setDoc(d))
      .catch(e => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return (
    <div className="min-h-screen w-full overflow-y-auto relative z-10">
      <div className="max-w-3xl mx-auto px-5 py-10">
        <Button
          variant="ghost"
          onClick={onBack}
          className="mb-6 -ml-2 h-8 text-xs text-muted-foreground hover:text-foreground gap-1.5"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back
        </Button>

        {error && (
          <div className="p-4 bg-destructive/10 border border-destructive/20 text-destructive text-sm rounded-xl">
            {error}
          </div>
        )}

        {!doc && !error && (
          <div className="text-xs text-muted-foreground">Loading…</div>
        )}

        {doc && (
          <article className="bg-card/40 backdrop-blur-md border border-border/60 rounded-2xl p-6 sm:p-8">
            {doc.version && (
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/70 mb-4">
                Version {doc.version}
              </p>
            )}
            <Markdown>{doc.markdown}</Markdown>
          </article>
        )}

        <LegalFooter className="mt-8" />
      </div>
    </div>
  );
}

/** Impressum / Privacy / Terms links. Statutory pages must be reachable from every view. */
export function LegalFooter({ className = "" }: { className?: string }) {
  return (
    <nav className={`flex items-center justify-center gap-3 text-[10px] text-muted-foreground/70 ${className}`}>
      <a href="/impressum" className="hover:text-foreground transition-colors">
        Impressum
      </a>
      <span aria-hidden>·</span>
      <a href="/privacy" className="hover:text-foreground transition-colors">
        Privacy
      </a>
      <span aria-hidden>·</span>
      <a href="/terms" className="hover:text-foreground transition-colors">
        Terms
      </a>
    </nav>
  );
}
