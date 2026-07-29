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
export const TERMS_VERSION = "1.1";

/**
 * Version of the publication term a user accepted.
 *
 * 2.0 is a different thing from 1.0, which is why it is a new number rather than
 * a bump: 1.0 was an optional, revocable consent to publication; 2.0 is
 * acceptance of publication as part of the service (Art. 6(1)(b)), required to
 * hold an account, paired with the 30-day window before anything is publishable.
 * Acceptances recorded under 1.0 do not carry over — the export filters on an
 * exact version match, so a 1.0 row stays unpublishable until its owner accepts
 * the current terms.
 */
export const DATASET_CONSENT_VERSION = "2.0";

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
 * The wording shown next to the publication checkbox at signup. It lives here
 * rather than in the component because it is what a user actually accepted, and
 * it has to stay in lockstep with DATASET_CONSENT_VERSION.
 *
 * The 30 days are stated because they are the substance of the deal: publication
 * is not optional, the window is what makes that fair. The number is enforced by
 * PublicationEmbargo in backend/export.go — change one and you must change both.
 */
export const DATASET_CONSENT_TEXT =
  "I understand that my interactions (prompts, responses and uploaded traces) " +
  "may be published as part of an open dataset under the CC-BY 4.0 licence, " +
  "after filtering and PII removal — this is what the platform is for. Nothing " +
  "I contribute becomes publishable until it has been here for 30 days, so I can " +
  "delete anything I did not mean to upload before it can be released. Once a " +
  "release is public it cannot be recalled.";
