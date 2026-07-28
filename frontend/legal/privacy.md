# Privacy Policy

**Version 1.0 — effective 29 July 2026**

This notice explains what personal data Open Assistant 2.0 processes, why, on
what legal basis, and what rights you have. It is provided under Articles 13
and 14 GDPR (DSGVO).

Open Assistant 2.0 exists to build an **openly published dataset of AI
interactions**. Publication is the point of the project — so please read
section 5 carefully. Publication only ever happens with your separate,
explicit, revocable consent.

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
| **Publishing your interactions in an open dataset** | §2.2 | **Art. 6(1)(a) GDPR — your separate, explicit consent** |
| Processing feedback you send us | §2.3 | Art. 6(1)(f) GDPR |
| Meeting legal obligations | as required | Art. 6(1)(c) GDPR |

Where processing rests on consent, you may withdraw it at any time with effect
for the future (Art. 7(3) GDPR). Withdrawal does not affect the lawfulness of
processing carried out beforehand — and, for data already published, please
read section 5.3.

## 4. On-device PII redaction

You can redact names, emails, phone numbers and similar identifiers **in your
browser, before anything is sent to us** — in chat and before uploading traces.
The redaction model runs locally via Transformers.js (WebGPU or WASM).

Two points of honesty about this feature:

- The model file itself is downloaded from the Hugging Face CDN
  (`huggingface.co`) the first time you use it. That download is a request to a
  third party and will expose your IP address to them. Your *text* is never
  sent there.
- Automatic redaction is a statistical model, not a guarantee. Review the
  result before you upload. We also filter data again before any public
  release, but neither step is perfect.

## 5. Dataset publication — the important part

### 5.1 What consent covers

If, and only if, you give dataset-release consent, we may include your
interaction data (section 2.2) in publicly released datasets under the
**Creative Commons Attribution 4.0 International (CC-BY 4.0)** licence. That
means anyone worldwide may use, modify and redistribute the released data,
including commercially, provided they give attribution.

Released data is intended for training and evaluating open AI models and for
academic research, including a planned dataset and benchmark publication.

### 5.2 What we do before publishing

Released data is filtered before release: automated PII detection, removal of
account identifiers (releases use pseudonymous participant identifiers, not
your username or email), and exclusion of any interaction whose contributor has
not consented. **We do not publish raw, unfiltered conversation logs.**

### 5.3 Withdrawal, and its limits

You can withdraw dataset consent at any time in Settings. From that moment your
data is excluded from all future releases, and you can delete individual
uploads yourself under "My Uploads".

**A dataset release that has already been published cannot be recalled.** Once
a corpus is public under CC-BY 4.0, copies exist beyond our control. We will
remove your data from the working corpus and from subsequent releases, but we
cannot retract copies other people already hold. Please take this into account
before you consent — it is the reason consent is asked separately rather than
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
- **Grant or withdraw dataset consent**, and **turn leaderboard visibility on
  or off** — Settings.

For a **data export**, or anything the app does not cover, email
[contact@laion.ai](mailto:contact@laion.ai) — we act within one month, as
Art. 12(3) GDPR requires.

You also have the right to complain to a supervisory authority. The competent
one for us is:

> Der Hamburgische Beauftragte für Datenschutz und Informationsfreiheit
> Ludwig-Erhard-Str. 22, 20459 Hamburg, Germany

## 9. Age limit

This service is not intended for people under 16. We do not knowingly process
data of children under 16; if you believe we have, contact us and we will
delete it.

## 10. Changes

We will publish any change here with a new version number. If a change
materially affects how we use your interaction data, we will ask you to review
it when you next sign in, and where the change concerns publication we will ask
for fresh consent rather than assuming the old one carries over.
