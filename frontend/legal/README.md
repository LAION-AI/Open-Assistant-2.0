# Legal documents

These are the documents the app serves at `/impressum`, `/privacy` and
`/terms`. They are plain Markdown so that the repository and the running site
share one source of truth: `/api/legal/:slug` reads these files, and the
version each user accepted is recorded against the constants in
[`src/lib/legal.ts`](../src/lib/legal.ts).

| File | Route | Consent recorded |
|---|---|---|
| `impressum.md` | `/impressum` | none — statutory disclosure only |
| `privacy.md` | `/privacy` | accepted together with the terms at signup |
| `terms.md` | `/terms` | `terms_version` + `terms_accepted_at` on the user |
| — (consent text lives in the UI) | signup / Settings | `dataset_consent*` + a row in `consent_events` |

## Changing a document

1. Edit the Markdown.
2. Bump the matching version in `src/lib/legal.ts` **only if the change is
   material.** Fixing a typo should not invalidate everyone's acceptance;
   changing what we may do with their data must.
3. A bumped `TERMS_VERSION` makes the app ask existing users to accept the new
   version at next sign-in. A bumped `DATASET_CONSENT_VERSION` invalidates
   prior dataset consent and asks for it again — never treat an old consent as
   covering a new purpose (GDPR Art. 7; see `privacy.md` §10).

## Review status

Reviewed by counsel at version 1.0.

**Changed since that review:** version 1.1 adds terms § 4 and the matching
paragraphs in privacy § 4 and § 5.2–5.3. Two things there are worth counsel's
specific attention:

- § 4.1 is a **warranty** (third-party terms of service) whose breach costs the
  account, while § 4.2 is a **request** (personal data) with no account
  consequence. That asymmetry is deliberate — it should survive editing.
- § 4.4 and the liability clause in § 9 are the clauses most exposed to § 307 /
  § 309 BGB for consumers.

Privacy § 5.3 also now promises post-release withdrawal by instance identifier.
That is a commitment with an operational tail: releases must keep carrying
`instanceId` (see `backend/export.go`) for it to be keepable.

Keep the rule: a material edit to any of these documents — anything that changes
what we may do with contributors' data, or what we require of them — needs review
before it ships, not just a version bump.

Open items tracked elsewhere: the `[TO CONFIRM]` / `[TO DECIDE]` markers in
[`../../DATASHEET.md`](../../DATASHEET.md), which concern the dataset release
rather than these documents.
