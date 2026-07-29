# LAION Research Ethics Committee — Charter

**Status: draft, pending adoption by the LAION e.V. board**
**Version 0.1 — drafted 29 July 2026**

---

## 0. What this is, and what it is not

This charter constitutes an internal **Research Ethics Committee (REC)** for
LAION gemeinnütziger e.V.

It is **not** an Institutional Review Board in the regulatory sense. LAION is
not a university, a hospital, or a medical research institution; it operates no
accredited IRB, holds no US federal-wide assurance, and is not a
*Ethikkommission* under state medical-association law. German law imposes no
statutory ethics-review requirement on non-medical, non-interventional research
of the kind LAION conducts.

Publications and datasheets arising from LAION research must therefore describe
review by this committee as **"reviewed by LAION's internal Research Ethics
Committee"**, and never as "IRB approved". Overstating the standing of this body
would misrepresent the review to reviewers, participants, and readers. Where a
venue or partner requires accredited review, LAION seeks it from a partner
institution instead — see §7.

Within those limits, the committee exists to do something real: to make sure
that research involving data contributed by people is examined, before it
starts, by named individuals who have to sign their name to the decision.

## 1. Scope

The committee reviews any LAION activity that:

- collects data from identifiable people, or data they authored;
- publishes a dataset derived from such data;
- evaluates models on human-contributed data in a way that could re-identify
  contributors; or
- any project where a committee member, the board, or a project lead asks for
  review.

Purely technical work on synthetic or already-public, properly licensed data
does not require review, though anyone may ask for it.

## 2. Composition

The committee has **at least three voting members**:

1. A **chair**, appointed by the board for a two-year renewable term.
2. At least one member with **data-protection or legal expertise**.
3. At least one member who is **independent of the project under review** —
   holding no authorship, funding interest, or line-management relationship to
   its leads. Where feasible this member is **external to LAION** (an academic
   ethics reviewer, a data-protection professional, or a community
   representative).

Board members of LAION e.V. may serve. **A majority of the voting members on
any given decision may not be authors of, or otherwise materially involved in,
the work under review.** This is the provision that makes the review worth
anything: a committee composed solely of a project's own authors is
self-approval, and both this charter and any resulting publication must be
honest that it would be.

A lay member without a machine-learning background should be recruited where
possible; contributors are not ML researchers, and a reviewer who reads the
consent text as a normal person would catches what specialists miss.

## 3. Conflict of interest

Members declare conflicts at the start of every review. A conflicted member:

- **must** declare the conflict on the record;
- **may** present the project, answer questions, and provide documents;
- **must not** vote, and must not be counted towards quorum for that decision;
- **must not** be present for the deliberation and vote.

If conflicts leave fewer than three unconflicted voting members, the committee
**must** co-opt an external reviewer before deciding. It may not proceed by
waiving this requirement.

## 4. Quorum and decisions

Quorum is three unconflicted voting members, including the chair or a
chair-designated deputy.

Decisions are one of:

- **Approve** — the protocol may proceed as described.
- **Approve with conditions** — specified changes must be made; the chair
  verifies them before work starts.
- **Revise and resubmit** — substantive concerns; the committee reviews again.
- **Reject** — the work may not proceed in the form proposed.

Decisions are by simple majority of unconflicted members present. Dissent is
recorded in the decision record, with reasons. A member may require that their
dissent be reproduced in any publication describing the review.

## 5. Procedure

1. **Submission.** The project lead submits a protocol (template:
   [`PROTOCOL-TEMPLATE.md`](PROTOCOL-TEMPLATE.md)) to the chair.
2. **Completeness check.** The chair returns incomplete submissions within five
   working days.
3. **Review.** Members review independently, then meet (in person or
   asynchronously in writing).
4. **Decision.** Recorded in the protocol's decision record, signed by each
   voting member, with conflicts and recusals named.
5. **Publication.** Approved protocols and their decision records are committed
   to this repository. Redact only what genuinely must stay private; the default
   is public.
6. **Amendment.** Any material change to an approved protocol — new data
   category, new purpose, new recipients, changed consent wording — requires a
   fresh review. Non-material changes are noted by the chair without a meeting.
7. **Ongoing review.** Approvals for continuing collection are reviewed at least
   **annually**, and immediately after any data-protection incident.

## 6. Records

Protocols, decisions, dissents, amendments and annual reviews live in this
directory under version control. Nothing is edited in place after a decision is
signed: corrections are appended as amendments, so the record of what was
decided, by whom, and when, stays intact.

## 7. Escalation to external review

The committee refers a project to an external ethics body, or declines to be the
sole reviewer, when the work involves:

- vulnerable participants (minors, people who cannot freely consent);
- special-category data under Art. 9 GDPR (health, biometrics, sexual
  orientation, religious or political belief) as a *target* of collection;
- deception, or withholding material information from participants;
- foreseeable risk of serious harm to participants or third parties; or
- a venue, funder, or partner that requires accredited review.

## 8. Contact

Concerns about a LAION study, or about this committee, go to
[contact@laion.ai](mailto:contact@laion.ai) marked for the Research Ethics
Committee. Contributors may also raise concerns with the competent supervisory
authority, as described in the [Privacy Policy](../frontend/legal/privacy.md).

---

## Adoption

| Role | Name | Signature / date |
|---|---|---|
| Chair | *[to be appointed]* | |
| Data-protection member | *[to be appointed]* | |
| Independent member | *[to be appointed — see §2]* | |
| For the board (LAION e.V.) | *[to be signed]* | |
