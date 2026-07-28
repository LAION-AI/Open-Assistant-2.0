import { readFileSync } from "fs";
import { join } from "path";

/**
 * Legal documents and the consent versions tied to them.
 *
 * The Markdown in ../../legal is the single source of truth: it is what the
 * repository shows, what /api/legal serves, and what these versions refer to.
 * Bump a version only for a *material* change — the version is what we store
 * against each user's acceptance, so bumping it invalidates every stored
 * acceptance and asks everyone again. A typo fix should not do that.
 */

/** Bumping this asks existing users to accept the terms again at next sign-in. */
export const TERMS_VERSION = "1.0";

/** Bumping this invalidates prior dataset consent — never reuse a consent for a new purpose. */
export const DATASET_CONSENT_VERSION = "1.0";

export interface LegalDoc {
  slug: string;
  title: string;
  /** Undefined for documents that carry no consent (the Impressum). */
  version?: string;
  markdown: string;
}

const DOCS: Record<string, { title: string; file: string; version?: string }> = {
  impressum: { title: "Impressum", file: "impressum.md" },
  privacy: { title: "Privacy Policy", file: "privacy.md", version: TERMS_VERSION },
  terms: { title: "Terms of Service", file: "terms.md", version: TERMS_VERSION },
};

// Resolved from this file rather than the process CWD: the container starts in
// /app but nothing guarantees that, and a legal page failing to load because of
// a working-directory assumption would be a bad way to breach § 5 DDG.
const LEGAL_DIR = join(import.meta.dir, "../../legal");

// Small enough to hold in memory, and immutable for the life of the process —
// the files ship inside the image, so a reread per request buys nothing.
const cache = new Map<string, LegalDoc>();

export function getLegalDoc(slug: string): LegalDoc | null {
  const meta = DOCS[slug];
  if (!meta) return null;

  const cached = cache.get(slug);
  if (cached) return cached;

  try {
    const markdown = readFileSync(join(LEGAL_DIR, meta.file), "utf8");
    const doc: LegalDoc = { slug, title: meta.title, version: meta.version, markdown };
    cache.set(slug, doc);
    return doc;
  } catch (err) {
    console.error(`Failed to read legal document '${slug}':`, err);
    return null;
  }
}

export const LEGAL_SLUGS = Object.keys(DOCS);

/**
 * The consent text shown next to the dataset checkbox. It lives here rather
 * than in the component because it is the wording a user actually consented
 * to, and it has to stay in lockstep with DATASET_CONSENT_VERSION.
 */
export const DATASET_CONSENT_TEXT =
  "I consent to my interactions (prompts, responses and uploaded traces) being " +
  "published as part of an open dataset under the CC-BY 4.0 licence, after " +
  "filtering and PII removal. I understand this is optional, that I can " +
  "withdraw it at any time in Settings, and that withdrawal cannot recall a " +
  "release that has already been published.";
