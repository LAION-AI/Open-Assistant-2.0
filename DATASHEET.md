# Datasheet — Open Assistant 2.0 Interaction Corpus

Following [Datasheets for Datasets](https://arxiv.org/abs/1803.09010)
(Gebru et al.). This document describes the corpus collected by the Open
Assistant 2.0 platform and is maintained alongside the code that produces it,
so that a release can be documented from the same source of truth that governs
collection.

**Status: pre-release.** Collection is live; no public release has been cut yet.
Fields marked *[pending first release]* are filled in when one is.

---

## Motivation

**For what purpose was the dataset created?**
Interaction data — prompts, follow-ups, attached images, agent traces — is one
of the most valuable inputs for training and evaluating AI models, and it sits
almost entirely inside proprietary systems. This corpus exists to make an
openly licensed alternative available to researchers and to the open-model
community, as the successor to OpenAssistant/OASST1.

**Who created it and who funded it?**
LAION gemeinnütziger e.V., a nonprofit association registered in Hamburg,
Germany (VR 25085), with contributions from volunteers. Collection
infrastructure runs on rented servers in Helsinki, Finland (EU).
*[TO CONFIRM: grant or compute funding to acknowledge.]*

## Composition

**What do the instances represent?**
One instance is a conversation: an ordered exchange between a person and an AI
model, with the model name, the originating platform, a token count, a
timestamp, a pseudonymous contributor identifier, a flag for whether on-device
redaction ran, and the consent-document version it was released under. Instances arrive by three
routes:

1. **Browser chat** — conversations held in the platform's own UI.
2. **V1 proxy** — traffic from external tools (VS Code Copilot, Claude Code,
   opencode, and other OpenAI-v1-compatible clients) routed through a logging
   proxy with a personal API key.
3. **Imported traces** — existing local agent sessions uploaded by the
   contributor (Claude Code, VS Code Copilot Chat, OpenCode, Codex CLI, Google
   Antigravity), parsed in the browser with per-conversation selection.

**How many instances are there?** *[pending first release]*

**Does it contain all instances or a sample?**
A filtered subset. Only interactions from contributors who granted
dataset-release consent are eligible, and eligible data passes a filtering
pipeline before release (see Preprocessing).

**Is any information missing?**
Yes, by design: account identifiers, email addresses and usernames are not
released. Contributions carry a pseudonymous participant identifier.

**Does the dataset contain confidential or sensitive data?**
Prompts are free text, so despite the safeguards below it is realistic to
assume residual personal data survives in some instances. The terms forbid
submitting third-party personal data or secrets, redaction runs on-device
before upload, and a filtering pass runs before release — none of which is a
guarantee. Researchers using this corpus should treat it as potentially
containing residual PII and handle it accordingly.

Agent traces additionally may contain source code, file paths and project
structure from contributors' own machines. Contributors choose which
conversations to include, and are warned before upload.

## Collection Process

**How was the data acquired?**
Directly from the people who produced it, through the platform's own
interfaces. Nothing is scraped, purchased, or obtained from third parties.

**Who was involved?**
Volunteer contributors with accounts on the platform. No payment is made.

**Over what timeframe?**
Collection began with the v0.1.0 deployment in July 2026 and is ongoing.

**Were contributors informed, and on what legal basis is publication done?**
Informed at signup, in two separately-ticked, separately-recorded acceptances —
both required, because a platform whose purpose is an open dataset has nothing to
offer an account that opts out of publication:

- **Terms + privacy acceptance**, with the accepted document version and
  timestamp stored per user.
- **The publication term**, presented with the licence named (CC-BY 4.0), the
  30-day window stated, and the non-recall limit stated. Every acceptance is
  written to a `consent_events` audit table with document version, timestamp and
  origin.

Publication rests on **Art. 6(1)(b) GDPR (performance of the contract)**, not on
consent. This is deliberate and is documented as such in the privacy policy §5.1:
consent that a user cannot decline without losing access to the service would not
be freely given (Art. 7(4) GDPR), so describing it as consent would misstate what
is happening. Researchers reusing this corpus should cite the basis accurately —
contributors accepted publication as the platform's purpose, and were protected
by the controls below rather than by an opt-out.

**The 30-day publication window.** No instance is exportable until it has existed
for 30 days, enforced in the release query (`PublicationEmbargo` in
`backend/export.go`), not by review. Deletion within that window means an instance
is never publishable at all — the safeguard for material uploaded by mistake.

Contributors can erase their contributions at any time — individually ("My
Uploads"), all at once, or by deleting their account entirely, all self-service
in the app. Erased data leaves the working corpus and every subsequent release.

**Ethical review.** No institutional review board review was sought or obtained.
LAION is a nonprofit research association, not a medical or clinical institution,
and German law imposes no ethics-review requirement on non-medical,
non-interventional research of this kind; the project is not US-federally funded
and so falls outside 45 CFR 46.

Participant protection rests instead on measures that are documented and
checkable rather than on a review body: participation is voluntary and
self-selected among adults; publication requires separate, unbundled, revocable
consent recorded with its document version; contributors can erase their
contributions or their whole account themselves at any time; releases carry
pseudonymous identifiers rather than account identifiers; and no interaction is
released without a consent record permitting it — enforced by the export query,
not by review.

## Preprocessing / cleaning / labeling

Before any public release:

- instances younger than 30 days are excluded outright (see Collection Process);
- interactions from contributors without a current recorded acceptance are
  excluded — enforced in the export query itself, which joins against the
  acceptance record and drops anyone whose acceptance is absent or attached to a
  superseded document version. There is no code path that exports unfiltered rows;
- each instance carries a stable pseudonymous **instance identifier**, so a
  specific published row can be reported and withdrawn after release (see
  Maintenance);
- account identifiers are replaced with pseudonymous participant identifiers
  (domain-separated SHA-256, stable per contributor so their instances stay
  linkable — note this is a hash of the account id, not a keyed MAC, so it
  resists casual inspection rather than a determined guessing attack against a
  known account id);
- conversation identifiers are pseudonymised the same way, because ids
  originating from imported agent traces can embed local file paths or machine
  names;
- each instance carries the consent document version it was released under;
- automated PII detection runs over the content;
- *[pending first release: exact filter versions, thresholds, and the fraction
  of instances removed at each stage.]*

Contributors may additionally redact PII **on their own device** before data
ever reaches the server, using a local Transformers.js model
([`rampart`](https://huggingface.co/nationaldesignstudio/rampart) by default,
`openai/privacy-filter` optional).

Whether that ran is recorded **per instance** and released as `clientRedacted`.
It is set when a conversation was redacted before upload, and also when a
contributor redacts a stored conversation afterwards. Two cautions for anyone
using the field:

- It records that redaction **ran**, not that the instance is clean. The model
  is statistical, `true` is not a guarantee, and the terms are explicit that it
  is offered as an aid rather than a warranty.
- By the same token `false` marks instances more likely to contain residual PII.
  That is useful for filtering and for reporting coverage, but it also makes
  those instances easier to single out — weigh that before using the field to
  prioritise anything other than further cleaning.

Raw, unfiltered logs are not published.

## Uses

**What is the dataset intended for?**
Training and evaluating open AI models; research on human–AI interaction and on
agentic coding workflows; a planned datasets-and-benchmarks publication
(targeting NeurIPS 2027).

**What should it not be used for?**
Re-identifying contributors, or any attempt to link instances back to
individuals. Do not treat the corpus as PII-free. It is not a representative
sample of any population: contributors are self-selected, skew toward
developers and open-source enthusiasts, and the agent-trace portion is heavily
weighted toward software engineering.

## Distribution

**How will it be distributed?**
As public dataset releases. *[pending first release: hosting location, formats,
DOI.]*

**Under what licence?**
[CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) — reuse and
redistribution allowed, including commercially, with attribution. Contributors
are told this licence by name in the consent text before they consent.

**Are there IP or other restrictions?**
Model outputs are generated by third-party models whose copyright status is
unsettled; the CC-BY grant runs from the contributor and cannot cure that
uncertainty for the model-generated portion. Downstream users should form their
own view.

## Maintenance

**Who maintains it?**
LAION gemeinnütziger e.V. — [contact@laion.ai](mailto:contact@laion.ai).

**Will it be updated?**
Yes; collection is continuous and further releases are expected. Each release
is versioned, and this datasheet is updated with it.

**How are erasure requests handled?**
Withdrawal of consent and deletion — both self-service — remove the data from the
working corpus and from all subsequent releases.

For data already published, reports are handled by instance identifier: the
instance is tagged, pulled from the copies we distribute, and excluded from every
later revision. Reports go to [contact@laion.ai](mailto:contact@laion.ai) and the
route stays open for the life of the dataset. Copies already downloaded by third
parties are outside our reach, and the consent text says so before anyone
consents — downstream users of a release should re-pull rather than treat any
snapshot as final. Already-published releases cannot be
recalled — contributors are told this before consenting, and it is stated in
[the Privacy Policy](frontend/legal/privacy.md) §5.3.

**Will older releases keep being supported?**
*[TO DECIDE: whether superseded releases stay downloadable, and for how long.]*

---

## Related documents

- [Terms of Service](frontend/legal/terms.md)
- [Privacy Policy](frontend/legal/privacy.md)
- [Impressum](frontend/legal/impressum.md)
