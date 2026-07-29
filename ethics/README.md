# Research ethics

Ethics review for LAION research that involves data contributed by people.

| Document | What it is |
|---|---|
| [CHARTER.md](CHARTER.md) | Constitutes LAION's internal Research Ethics Committee: scope, composition, conflict-of-interest rules, quorum, procedure |
| [PROTOCOL-001-interaction-corpus.md](PROTOCOL-001-interaction-corpus.md) | Review protocol for the Open Assistant 2.0 interaction corpus, with the decision record to be signed |
| [PROTOCOL-TEMPLATE.md](PROTOCOL-TEMPLATE.md) | Blank protocol for future studies |

## How to describe this in a paper

**Not** "IRB approved". LAION operates no accredited IRB and holds no
federal-wide assurance, and German law requires no ethics review for
non-medical research of this kind. Claiming otherwise would misrepresent the
review.

The accurate wording is along these lines:

> This work was reviewed and approved by LAION's internal Research Ethics
> Committee (protocol 001), which operates under a published charter requiring
> that a majority of voting members on any decision be independent of the work
> under review. LAION is a nonprofit research association and does not operate
> an accredited institutional review board; the charter, protocol and decision
> record are public at `ethics/` in the project repository.

Publishing the charter and the signed decision — including any dissent — is what
makes that sentence checkable rather than a claim.

## Before a decision is signed

Two things in [CHARTER.md](CHARTER.md) §2 have to be true, not aspirational:

- at least one voting member with **no stake** in the corpus, external to LAION
  where feasible; and
- a **majority of unconflicted voting members** on the decision itself.

If the people signing are the same people writing the paper, the review does not
carry weight, and reviewers are right to discount it. Recruiting one external
reviewer is the difference.
