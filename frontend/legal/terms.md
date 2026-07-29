# Terms of Service

**Version 1.1 — effective 29 July 2026**

These terms govern your use of Open Assistant 2.0 ("the Service"), operated by
**LAION gemeinnütziger e.V.**, Marlowring 26, 22525 Hamburg, Germany (see the
[Impressum](/impressum)). By creating an account you agree to them.

How your data is handled is described in the [Privacy Policy](/privacy), which
forms part of these terms.

---

## 1. What the Service is

Open Assistant 2.0 is a non-commercial research platform run by a nonprofit
association. It lets you chat with AI models through an endpoint of your
choosing, route external tools through a logging proxy, and import agent
traces — so that the resulting interaction data can, with your consent, become
an openly published dataset for training and evaluating open AI models.

The Service is provided free of charge. There is no contract for paid services
and no guarantee of availability.

## 2. Who may use it

You must be **at least 18 years old**. One account per person; accounts are
personal and must not be shared or transferred. You are responsible for
everything that happens under your account, and for keeping your credentials,
passkeys, recovery codes and API keys secure.

## 3. Acceptable use

You agree not to:

- submit content that is unlawful under German or applicable law, including
  content that infringes copyright or other third-party rights;
- **knowingly submit personal data about other people** — do not paste other
  people's names, contact details, health information or similar into prompts or
  uploaded traces. Section 4.2 covers what to do about the ones that slip
  through, which is a different matter from doing it deliberately;
- upload traces whose sharing is restricted by the terms of the tool or provider
  they came from (section 4.1);
- submit credentials, API keys, access tokens or other secrets;
- attempt to disrupt, overload, probe or circumvent the Service, its rate
  limits or its authentication;
- use the Service to generate content designed to harass, defraud, or harm
  others, or to build systems for those purposes;
- resell, proxy or otherwise expose the Service to third parties as if it were
  your own.

We may suspend or delete accounts that break these rules, and remove content
that does. Where the breach is minor and fixable we will normally say so first.
Section 4 sets out what we ask you to check before uploading, and what follows
if something slips through — the answer differs sharply between § 4.1 and § 4.2.

## 4. What you check before you upload, and what we check after

Two different things are covered here, and they carry deliberately different
consequences.

Whether you are **allowed** to share a trace at all is something only you can
establish, and getting it wrong is serious (§ 4.1). Whether the content still
contains **personal data** is something we help with and check again ourselves,
and a miss there is a thing to fix, not a thing to punish (§ 4.2).

### 4.1 Third-party terms — yours to check, and we cannot do it for you

Traces you import come from someone else's product — Claude Code, GitHub
Copilot, opencode, Codex CLI, Antigravity, your employer's internal tools, an
inference provider you pay for. Each of those has its own terms of service, and
some restrict what you may do with the outputs, the logs, or the tool's own
prompts.

**You warrant that, before uploading, you have checked the current terms of
every third-party service a trace came from, and that sharing that trace with us
— and its publication in an open dataset if you have consented to that — is
permitted by those terms.**

We do not and cannot perform this check for you. We are not a party to your
agreement with those providers, we have no visibility into which plan or licence
you hold, and reviewing every trace against every provider's current terms is
not something we are able to do at any scale. If you are not sure a trace may be
shared, do not upload it. This is the one obligation here whose breach can cost
you your account — see § 4.4.

### 4.2 Personal data — please double-check; we check again too

Before uploading, please review the conversations for personal data — yours and
other people's — and remove what you find. Four eyes see more than two, and
yours are the only ones that know the context.

We do not rely on that alone. There are two further stages:

- the optional on-device redaction tool, which runs in your browser before
  anything is sent to us (§ 4.3);
- **a further automated redaction and filtering pass that we run over the corpus
  before any public release.** Something you miss is therefore not automatically
  something that gets published.

None of these three stages is perfect, which is exactly why there are three of
them. Missing something is not treated as a breach of these terms and has no
consequence for your account. If you notice personal data in something you have
already uploaded, delete it — individual conversations in "My Uploads", or
everything at once in Settings, both one click and no request to us.

### 4.3 On-device redaction is an offer, not a guarantee

We provide the local PII redaction tool because it is genuinely useful. It runs a
statistical model in your browser. **It is offered as an aid and comes with no
warranty of any kind: it will miss personal data, and a redacted upload is not a
clean upload.** The same is true of our pre-release pass. Use the tool, and still
look at the result yourself.

### 4.4 If something goes wrong

**Breach of § 4.1 (third-party terms).** We will normally contact you first and
remove the material. Uploading material you were not permitted to share — and in
particular continuing to do so after we have raised it — leads to **permanent
deletion of your account and all of your contributions.**

**Personal data that slipped through.** No account consequence. We remove the
material, from the working corpus and from later releases, and you can remove it
yourself at any time.

**After a release has gone out.** Every instance in a release carries a stable
instance identifier. If you — or anyone — reports personal data in a published
release, quoting that identifier, we will tag the instance, remove it from the
copies we distribute and exclude it from every later revision of the dataset.
What we cannot do is reach into copies that other people have already downloaded
(§ 6.4 and § 5.3 of the [Privacy Policy](/privacy)).

Report anything of this kind to
[contact@laion.ai](mailto:contact@laion.ai).

## 5. Your endpoints and third-party services

When you use "Bring Your Own Endpoint", your prompts travel to whichever
provider you configure, under **that provider's** terms and privacy policy. You
are responsible for having the right to use that endpoint and for any costs it
incurs. We are not a party to that relationship and cannot control what the
provider does with your data.

## 6. Your content, and the licence you grant us

You keep ownership of everything you submit. Nothing here transfers your
copyright.

**6.1 Licence to operate the Service.** You grant LAION a non-exclusive,
worldwide, royalty-free licence to store, reproduce and process your submitted
content for the purpose of running the Service and showing your own history
back to you. This licence lasts as long as the content is stored, and ends when
you delete it.

**6.2 Licence to publish — only with separate consent.** Publication of your
interaction data as part of an open dataset happens **only** if you give
dataset-release consent, which is asked for separately from these terms and can
be withdrawn at any time in Settings. If you give it, you grant everyone a
licence to the released data under the
[Creative Commons Attribution 4.0 International licence (CC-BY 4.0)](https://creativecommons.org/licenses/by/4.0/),
and you grant LAION the right to distribute it on that basis.

**6.3 What you promise when you consent.** That the content is yours to license
— that you wrote it (or hold the rights), that you have complied with section 4,
and that you have not knowingly included other people's personal data or
confidential material belonging to someone else, such as an employer.

**6.4 Withdrawal.** Withdrawing consent removes your data from all future
releases and you may delete your uploads at any time. It cannot recall a
dataset release that is already public. Section 5.3 of the
[Privacy Policy](/privacy) explains this in full; please make sure you have
understood it before consenting.

**6.5 Model outputs.** Responses come from third-party models. We make no claim
of ownership over them and give no assurance about their copyright status. They
may be inaccurate — do not rely on them for legal, medical, financial or other
professional decisions.

## 7. Software licence

The Open Assistant 2.0 source code is published under the Apache License 2.0.
These terms govern the hosted Service, not your use of the source code.

## 8. Availability and changes

This is a research platform, developed in the open and sometimes deployed
mid-experiment. We may change, suspend or discontinue any part of it at any
time, and we do not promise any level of uptime, retention or backup. Export or
keep your own copy of anything you need.

## 9. Liability

We provide the Service free of charge, "as is", without warranty of any kind.

LAION is liable without limitation for damage caused intentionally or through
gross negligence, for injury to life, body or health, and where liability is
mandatory under the German Product Liability Act. For slight negligence, LAION
is liable only for breach of an essential contractual obligation (a duty whose
fulfilment makes proper performance possible and on which you may reasonably
rely), and then only for foreseeable, typical damage. All further liability is
excluded. Your statutory rights as a consumer are unaffected.

## 10. Ending your use

You may stop using the Service at any time. Settings → Danger Zone lets you
delete all of your interaction data, or your entire account, yourself — no
request and no waiting. We may terminate accounts that breach
section 3, and will terminate accounts that breach section 4.1, or discontinue
the Service entirely.

Deleting your account erases your account record, credentials, consent records
and stored interaction data, immediately and irreversibly. It does not recall
already-published dataset releases (section 6.4).

## 11. Changes to these terms

We may update these terms. Material changes will be published here with a new
version number, and you will be asked to accept the new version the next time
you sign in. Changes that concern dataset publication require **fresh consent**
— we will not treat an old consent as covering a new purpose.

## 12. Governing law and jurisdiction

German law applies, excluding the UN Convention on Contracts for the
International Sale of Goods. If you are a consumer, this choice of law does not
deprive you of the protection of mandatory provisions of the law of your
country of habitual residence, and you may bring proceedings in your local
courts. For merchants, the place of jurisdiction is Hamburg.

## 13. Severability

If any provision of these terms is or becomes invalid, the remaining provisions
stay in force.

---

**Contact:** LAION gemeinnütziger e.V., Marlowring 26, 22525 Hamburg, Germany —
[contact@laion.ai](mailto:contact@laion.ai)
