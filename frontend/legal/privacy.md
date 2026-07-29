# Privacy Policy

**Version 1.1 — effective 29 July 2026**

This notice explains what personal data Open Assistant 2.0 processes, why, on
what legal basis, and what rights you have. It is provided under Articles 13
and 14 GDPR (DSGVO).

Open Assistant 2.0 exists to build an **openly published dataset of AI
interactions**. Publication is the point of the project, not an optional extra —
so please read section 5 carefully before you sign up. Two things protect you
there: you decide what to contribute at all, and **nothing you contribute can be
published until it has been on the platform for 30 days**, which is your window
to remove anything you did not mean to send.

---

## 1. Controller

**LAION gemeinnütziger e.V.**\
Marlowring 26, 22525 Hamburg, Germany\
Email: [contact@laion.ai](mailto:contact@laion.ai)

Full company details are in the [Impressum](/impressum).

We have not appointed a Data Protection Officer; there is no statutory
obligation to do so for an association of this size. Data protection enquiries
go to the address above.

## 2. What we process

### 2.1 Account data

Username; email address (only if you register with email, or add one later);
a password *hash* (Argon2 — never the password itself); public keys and
metadata for any passkeys you register; two-factor settings (TOTP secret,
hashed recovery codes) if you enable them; your credit balance; whether you
appear on the public leaderboard; onboarding state; administrator flag; and
your consent records (see section 5).

### 2.2 Interaction data

When you chat in the browser, route a tool through the V1 proxy, or import a
local agent trace, we store: the prompt and response content (including any
images you attach), the model name, the platform the interaction came from
(`chat`, `claude-code`, `opencode`, …), a conversation identifier, a token
count, a timestamp, and your user ID.

**Prompts and responses are free text. Whatever you type into them is stored** —
including anything personal you mention about yourself or about other people.
This is why we provide on-device redaction (section 4).

### 2.3 Feedback

If you send feedback through the app, we store the message, a category, and
your user ID.

### 2.4 Technical logs

Our web server records requests (IP address, timestamp, requested path, user
agent, response status) in the system journal. These logs exist to operate and
secure the service, and rotate out of the journal in the ordinary course. IP
addresses used for login rate-limiting are held in memory only and are never
written to a database.

### 2.5 What we do *not* do

No advertising, no profiling, no analytics or tracking services, no third-party
cookies. The only cookie we set is the session cookie that keeps you logged in;
it is strictly necessary, so no cookie banner is required.

## 3. Legal bases and purposes

| Purpose | Data | Legal basis |
|---|---|---|
| Operating your account, authentication, 2FA | §2.1 | Art. 6(1)(b) GDPR — performance of a contract |
| Providing chat, the proxy and trace import; showing you your own history | §2.2 | Art. 6(1)(b) GDPR |
| Security, abuse prevention, rate limiting, keeping the service running | §2.4, §2.1 | Art. 6(1)(f) GDPR — legitimate interest in a secure service |
| Public leaderboard display of your username and contribution totals | §2.1 | Art. 6(1)(a) GDPR — consent. **Off unless you switch it on**, at signup or later in Settings, and revocable at any time |
| **Publishing your interactions in an open dataset** | §2.2 | **Art. 6(1)(b) GDPR — performance of the contract you entered into.** Producing an open dataset is the service itself, not a side purpose; see §5.1 |
| Processing feedback you send us | §2.3 | Art. 6(1)(f) GDPR |
| Meeting legal obligations | as required | Art. 6(1)(c) GDPR |

Where processing rests on consent — leaderboard visibility — you may withdraw it
at any time with effect for the future (Art. 7(3) GDPR), and withdrawal does not
affect the lawfulness of processing carried out beforehand. Publication does not
rest on consent; §5.1 explains why, and §5.2–5.3 set out the control you have
instead.

## 4. On-device PII redaction

You can redact names, emails, phone numbers and similar identifiers **in your
browser, before anything is sent to us** — in chat and before uploading traces.
The redaction model runs locally via Transformers.js (WebGPU or WASM).

Two points of honesty about this feature:

- The model file itself is downloaded from the Hugging Face CDN
  (`huggingface.co`) the first time you use it. That download is a request to a
  third party and will expose your IP address to them. Your *text* is never
  sent there.
- Automatic redaction is a statistical model, **not a guarantee**. It is offered
  as an aid and will miss things. Look at the result yourself before uploading —
  the [Terms](/terms) § 4.2 ask you to, on the plain reasoning that four eyes see
  more than two.

Redaction on your device is the first of three stages, not the only one: we run a
further automated redaction and filtering pass over the corpus before any public
release (§ 5.2), and anything reported afterwards is removed (§ 5.3). None of the
three is perfect, which is why there are three.

If you find personal data in something you have already uploaded, delete it
straight away ("My Uploads", or Settings for everything at once). If you find
someone else's personal data anywhere in the Service or in a release, tell us at
[contact@laion.ai](mailto:contact@laion.ai) and we will act on it.

## 5. Dataset publication — the important part

### 5.1 What we publish, and on what basis

Interaction data you contribute (section 2.2) may be included in publicly
released datasets under the **Creative Commons Attribution 4.0 International
(CC-BY 4.0)** licence. Anyone worldwide may then use, modify and redistribute the
released data, including commercially, provided they give attribution.

Released data is intended for training and evaluating open AI models and for
academic research, including a planned dataset and benchmark publication.

**Why this is contract and not consent.** Building an open dataset is the entire
service on offer here — it is what you sign up *for*, in the same way that
publishing your post is the service a public forum provides. Publishing
contributed data is therefore necessary to perform that contract (Art. 6(1)(b)
GDPR), and accepting it is a condition of holding an account. We deliberately do
**not** dress this up as consent: consent that you cannot refuse without losing
the service would not be freely given (Art. 7(4) GDPR), and calling it consent
anyway would misdescribe what is happening.

That makes the safeguards in §5.2 and §5.3 the substance of your control, rather
than a checkbox: what you contribute is up to you, and nothing is publishable for
30 days.

### 5.2 What we do before publishing

**The 30-day publication window.** An instance becomes eligible for release only
once it has been on the platform for 30 days. Delete it before then and it is
never published at all — this is enforced in the release query itself, not by
someone remembering to check. Anything younger than 30 days is simply not
exportable.

Released data is also filtered before release: **a further automated PII detection
and redaction pass over the whole corpus** — independent of whatever redaction you ran
on your own device — removal of account identifiers (releases use pseudonymous
participant identifiers, not your username or email), and exclusion of any
interaction whose contributor has not consented. Each released instance carries a
stable identifier so it can be reported and pulled later (§ 5.3). **We do not
publish raw, unfiltered conversation logs.**

### 5.3 Removal, correction after release, and the honest limit

You can delete individual uploads under "My Uploads", all of your interaction data
at once in Settings, or your entire account. Within the 30-day window that
prevents publication outright; afterwards it removes the data from the working
corpus, from every later release and from the copies we distribute.

You may also object to processing based on our legitimate interests (Art. 21
GDPR) and, for the publication itself, exercise your rights under Art. 16–18 GDPR
— in practice, deleting the data achieves the same result immediately.

**Reporting something in a release that has already gone out.** Every instance we
publish carries a stable instance identifier. If personal data is found in a
published release, tell us and quote that identifier: we tag the instance, pull it
from the copies we distribute, and exclude it from every later revision of the
dataset. The same applies to a whole contributor's data on withdrawal. This is a
route that stays open indefinitely, not only before the first release — write to
[contact@laion.ai](mailto:contact@laion.ai).

**The limit, stated plainly: a release that is already public cannot be
recalled.** Once a corpus is out under CC-BY 4.0, other people hold copies, and
nothing we do reaches those. We can stop distributing an instance and keep it out
of everything that follows; we cannot make a downloaded copy disappear. Please
weigh that before you consent — it is why consent is asked separately rather than
bundled into the terms.

### 5.4 Recipients and international transfers

Published datasets are, by their nature, available to recipients worldwide,
including in countries without a GDPR adequacy decision. This transfer follows
from your explicit consent to publication (Art. 49(1)(a) GDPR).

## 6. Other recipients

- **The inference endpoint you choose.** If you use "Bring Your Own Endpoint",
  your prompts are sent to the provider you configure (for example OpenAI,
  a hosted service, or your own local server). That provider's own terms and
  privacy policy govern what it does with them. We have no control over it.
- **Email delivery.** Verification, password-reset and 2FA emails are sent
  through our SMTP provider.
- **Hosting.** The service runs on infrastructure rented from **Hetzner Online
  GmbH**, Industriestr. 25, 91710 Gunzenhausen, Germany. The server itself is
  located in Hetzner's **Helsinki, Finland** data centre — inside the EU, so no
  transfer to a third country is involved in hosting. Hetzner acts as a
  processor on our behalf under a data processing agreement pursuant to
  Art. 28 GDPR.

We do not sell personal data, and we do not share it with third parties beyond
what is described here.

## 7. Retention

| Data | Retention |
|---|---|
| Account data | Until you delete your account, which you can do yourself in Settings |
| Interaction data | Until you delete it — individually in "My Uploads", all at once in Settings, or with the account |
| Consent records | Kept while the account exists as evidence that consent was validly obtained (Art. 7(1) GDPR), and deleted with the account |
| Technical logs | Rotated out of the system journal in the ordinary course |
| Uploaded but not yet publishable | The first 30 days after upload, during which deletion prevents publication entirely |
| Published dataset releases | Permanent — see section 5.3 |

## 8. Your rights

You have the right to: access your data (Art. 15), correct it (Art. 16), have
it erased (Art. 17), restrict processing (Art. 18), receive it in a portable
format (Art. 20), object to processing based on legitimate interest (Art. 21),
and withdraw consent at any time (Art. 7(3)).

You can exercise most of these yourself, immediately, without asking us:

- **View and delete individual contributions** — "My Uploads".
- **Delete all your interaction data at once** — Settings → Danger Zone. Your
  account stays, the data goes.
- **Delete your account entirely** — Settings → Danger Zone. This erases your
  account record, credentials, passkeys, two-factor secrets, consent records
  and every interaction you have contributed. It is immediate and irreversible.
- **Turn leaderboard visibility on or off** — Settings. This one *is* consent
  (Art. 6(1)(a)) and it is off unless you switch it on.

For a **data export**, or anything the app does not cover, email
[contact@laion.ai](mailto:contact@laion.ai) — we act within one month, as
Art. 12(3) GDPR requires.

You also have the right to complain to a supervisory authority. The competent
one for us is:

> Der Hamburgische Beauftragte für Datenschutz und Informationsfreiheit
> Ludwig-Erhard-Str. 22, 20459 Hamburg, Germany

## 9. Age limit

This service is for adults: you must be at least 18 to hold an account. We do
not knowingly process data of anyone under 18; if you believe we have, contact us
and we will delete it.

The threshold is deliberately above the 16-year floor that Art. 8 GDPR sets for
Germany. Contributing here means consenting to permanent publication of your own
words under an open licence, and that is a decision we would rather only adults
make.

## 10. Changes

We will publish any change here with a new version number. If a change
materially affects how we use your interaction data, we will ask you to review
it when you next sign in, and where the change concerns publication we will ask
for fresh consent rather than assuming the old one carries over.
