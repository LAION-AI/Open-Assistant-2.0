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

**These drafts have not been reviewed by a lawyer.** They were prepared from
the LAION e.V. Impressum data and the actual behaviour of this codebase, and
they are written to be accurate about what the software does — but accuracy
about the code is not the same as legal sufficiency. Before relying on them in
production, have counsel review them, and resolve the `[TO CONFIRM]` markers in
`privacy.md` (hosting provider and Art. 28 processing agreement) and in
[`../../DATASHEET.md`](../../DATASHEET.md).
