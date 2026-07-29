# Protocol 001 — Open Assistant 2.0 Interaction Corpus

**Status: submitted, awaiting review**
**Submitted 29 July 2026 · Reviewed under [CHARTER.md](CHARTER.md)**

| Field | Value |
|---|---|
| Project | Open Assistant 2.0 — crowdsourced AI interaction corpus |
| Lead | *[project lead]* |
| Institution | LAION gemeinnütziger e.V., Hamburg (VR 25085) |
| Data collection | Ongoing since July 2026 |
| Intended output | Public dataset releases under CC-BY 4.0; datasets & benchmarks paper (NeurIPS 2027 target) |
| Related documents | [Terms](../frontend/legal/terms.md) · [Privacy Policy](../frontend/legal/privacy.md) · [Datasheet](../DATASHEET.md) |

---

## 1. Purpose and expected benefit

Interaction data — prompts, follow-ups, images, agent traces — is the scarcest
public input for training and evaluating open models, and is held almost
entirely by a handful of private companies. The project collects such data from
volunteers who choose to contribute it, and publishes it openly so that open-model
research is not dependent on corporate goodwill.

The benefit is to the research community and, indirectly, to anyone who relies
on open models. It does not accrue primarily to contributors, which makes the
voluntariness of participation (§4) the central ethical question rather than a
formality.

## 2. Participants

Self-selected adults (16+) who create an account. Predominantly developers and
open-source enthusiasts; the corpus is explicitly **not** a representative
sample and must not be described as one. No recruitment of vulnerable groups, no
payment, no institutional or employment pressure to participate. Participation
has no effect on access to the platform's core functionality other than the
publication of contributed data.

## 3. Data collected

Per the [Privacy Policy](../frontend/legal/privacy.md) §2: account data;
interaction content (prompts, responses, attached images) with model name,
platform, conversation identifier, token count and timestamp; feedback messages;
and standard web-server logs.

**Special categories (Art. 9 GDPR) are not a target of collection.** They cannot
be excluded with certainty, because prompts are free text and people write about
their own health, beliefs and relationships unprompted. The mitigations in §5
are designed on that assumption rather than on a hope that it will not happen.

## 4. Consent

- **Terms and privacy acceptance** is required to hold an account; the accepted
  document version and timestamp are recorded per user.
- **Consent to publication is separate, unbundled, and off by default.** It
  names the licence (CC-BY 4.0), states that filtering and PII removal precede
  release, and states plainly that **an already-published release cannot be
  recalled**. Bundling it into the terms would make it non-freely-given under
  Art. 7(4) GDPR, and would also be untrue to how the platform behaves.
- **Withdrawal** is one click in Settings, and removes the contributor from all
  future releases.
- Every grant and withdrawal is appended to an audit table with the document
  version, timestamp and origin. A release can therefore be traced to the
  consents that permit it.
- A bump of the consent-document version **invalidates** prior consent rather
  than carrying it forward.

**Residual issue for the committee.** Consent cannot be truly informed about a
future release's contents, because contributors consent before knowing what they
will later type. The mitigation is that consent is revocable and deletion is
self-service — but the committee should decide whether that is sufficient, or
whether contributors should be re-prompted periodically.

## 5. Risks and mitigations

| Risk | Mitigation | Residual |
|---|---|---|
| Personal data about the contributor is published | On-device redaction before upload; server-side filtering before release; contributors warned that prompts are free text | Real. Redaction is statistical; some PII will survive |
| Personal data about **third parties** named in prompts | Terms forbid it; redaction covers names/contacts; filtering before release | Real, and the third party never consented — the sharpest issue in this protocol |
| Re-identification of contributors from writing style | Account identifiers replaced with pseudonymous participant ids; usernames and emails never released | Stylometric re-identification remains possible in principle |
| Secrets or credentials in agent traces | Terms forbid submission; contributors select conversations individually before upload | Real; filtering for secrets should be strengthened |
| Employer-confidential material in agent traces | Terms require contributors to warrant they have the right to submit | Rests on the contributor's judgement |
| Contributor regret after publication | Withdrawal and deletion are self-service and immediate for future releases | **Irreversible for published releases.** Stated before consent, but it cannot be undone |
| Downstream misuse of released data | CC-BY names the licensor; datasheet documents intended and unintended uses | Not controllable after release |

## 6. Data minimisation, retention, security

Collection is limited to what the platform needs to function and to what the
corpus is for. Releases carry no account identifiers; conversation identifiers
are pseudonymised because trace-import ids can embed local file paths. Data is
held on rented infrastructure in Helsinki, Finland (EU), under an Art. 28
processing agreement. Passwords are hashed, passkeys are the recommended
authentication, 2FA is available. Contributors can delete individual
contributions, all contributions, or their whole account, without asking anyone.

## 7. What the committee is being asked to decide

1. Is the separation of terms acceptance from publication consent adequate for
   consent to be considered freely given?
2. Is the treatment of **third-party personal data appearing in prompts**
   acceptable, given that those people never consented? Should more be required
   before release than the current redaction plus filtering?
3. Is the irreversibility of publication adequately communicated *before*
   consent, and is periodic re-prompting warranted?
4. Should a per-instance record of whether client-side redaction ran be
   published with the corpus? *(Implemented; the committee should confirm that
   publishing it is right — it is useful provenance, and it also marks which
   instances are more likely to contain PII.)*
5. Is release under CC-BY 4.0, with commercial reuse permitted, consistent with
   what contributors reasonably expect?

## 8. Conditions the project proposes to accept

- No release without a documented filtering pass, reported in the datasheet.
- No release of raw, unfiltered logs, ever.
- Annual re-review while collection continues.
- Any new purpose, recipient category, or licence change requires fresh consent,
  not an amended notice.
- A named contact for contributor concerns, answered within one month.

---

## Decision record

*To be completed by the committee. Conflicts must be declared before
deliberation; a member materially involved in this project may present it but
may not vote (CHARTER §3).*

| Member | Role | Conflict declared | Vote | Signature / date |
|---|---|---|---|---|
| | Chair | | | |
| | Data protection | | | |
| | Independent | | | |

**Decision:** ☐ Approve ☐ Approve with conditions ☐ Revise and resubmit ☐ Reject

**Conditions / reasons:**

**Dissent (if any):**

**Next scheduled review:**
