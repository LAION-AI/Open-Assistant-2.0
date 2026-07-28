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
Germany (VR 25085), with contributions from volunteers. *[TO CONFIRM: grant or
compute funding to acknowledge.]*

## Composition

**What do the instances represent?**
One instance is a conversation: an ordered exchange between a person and an AI
model, with the model name, the originating platform, a token count, a
timestamp, and a pseudonymous contributor identifier. Instances arrive by three
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

**Were contributors informed and did they consent?**
Yes, and the two are recorded separately:

- **Terms + privacy acceptance** is required to create an account. The accepted
  document version and timestamp are stored per user.
- **Dataset-release consent** is a distinct, unbundled opt-in, presented with
  the licence named (CC-BY 4.0) and with an explicit statement that published
  releases cannot be recalled. It is off unless actively granted, revocable at
  any time in Settings, and every grant and withdrawal is written to a
  `consent_events` audit table with the document version and timestamp.

Contributors can view and delete their own contributions at any time ("My
Uploads"), and can request full account deletion.

**Ethical review.** No institutional review board process was undertaken; the
platform is operated by a nonprofit association rather than a university.
*[TO CONFIRM before submission: whether the target venue expects an IRB
statement, and whether a partner institution should provide one.]*

## Preprocessing / cleaning / labeling

Before any public release:

- interactions from non-consenting contributors are excluded;
- account identifiers are replaced with pseudonymous participant identifiers;
- automated PII detection runs over the content;
- *[pending first release: exact filter versions, thresholds, and the fraction
  of instances removed at each stage.]*

Contributors may additionally redact PII **on their own device** before data
ever reaches the server, using a local Transformers.js model
([`rampart`](https://huggingface.co/nationaldesignstudio/rampart) by default,
`openai/privacy-filter` optional). Whether that ran is a property of the
contributor's session, not of the instance — *[TO DECIDE: record a per-instance
flag for whether client-side redaction was applied, which reviewers are likely
to ask about.]*

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
Withdrawal of consent and deletion requests remove the data from the working
corpus and from all subsequent releases. Already-published releases cannot be
recalled — contributors are told this before consenting, and it is stated in
[the Privacy Policy](frontend/legal/privacy.md) §5.3.

**Will older releases keep being supported?**
*[TO DECIDE: whether superseded releases stay downloadable, and for how long.]*

---

## Related documents

- [Terms of Service](frontend/legal/terms.md)
- [Privacy Policy](frontend/legal/privacy.md)
- [Impressum](frontend/legal/impressum.md)
