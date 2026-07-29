# Changelog

All notable changes to Open Assistant 2.0 are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.15.0] — 2026-07-29

Legal foundation and consent plumbing: everything needed to collect data
defensibly and to publish it without guessing what contributors agreed to.

### Added

**Legal documents** — served in-app at `/impressum`, `/privacy` and `/terms`,
readable without an account, from Markdown in `frontend/legal/` so the repository
and the running site share one source of truth.
- **Impressum** under § 5 DDG / § 18 MStV with LAION e.V.'s registered details.
- **Privacy Policy** (DSGVO Art. 13) covering all three ingestion routes, the
  BYOE endpoint your prompts travel to, the Hugging Face CDN request the
  redaction model makes, and Hetzner as host with the server in Helsinki.
- **Terms of Service**, including § 4: a *warranty* that the uploader has checked
  the third-party terms covering every imported trace, and a *request* — no
  account consequence — that they review each upload for personal data.
- **[DATASHEET.md](DATASHEET.md)** following *Datasheets for Datasets*, for the
  planned NeurIPS submission.

**Publication model**
- Accepting the terms and the publication term is required to create an account.
  Publication rests on Art. 6(1)(b) GDPR — producing an open dataset is the
  service — and the policy states why it is deliberately not called consent.
- **A 30-day window before anything is publishable**, enforced as a predicate in
  the release query. Delete an upload inside its window and it is never published.
- A header countdown, on every page, showing when the soonest contribution
  crosses that line.
- Versioned acceptance records plus an append-only `consent_events` audit trail
  (version, timestamp, origin), so a release can be traced to what permitted it.

**Dataset export** (admin) — JSONL gated on both rules above, with pseudonymous
participant, conversation and instance identifiers instead of account ids, and a
per-instance flag recording whether on-device redaction ran. Instance identifiers
exist so a published row can be reported and withdrawn later.

**Erasure**
- Self-service: delete all contributions, or the entire account with
  credentials, 2FA secrets and consent records. Interaction data goes first, so
  an account row can never outlive its logs.
- Admins can delete accounts from the users table, with typed confirmation.

**Repository**
- Live badges for code contributors, data contributors, traces and tokens.

### Changed

- **Registration is passkey-first.** Email + password is a link underneath,
  labelled with what it costs: a second factor before the first upload — now
  enforced on both the session and API-key upload paths, not just stated.
- **Leaderboard visibility is opt-in**, off by default, with a one-shot migration
  switching existing accounts off. It is the one thing here that genuinely is consent.
- Minimum age raised from 16 to 18.

### Fixed

- The deploy rsync deleted podman's container store on every run — it lived
  inside the sync target — which took the site down mid-release. `/containers*`
  is now excluded alongside `/data`.

## [0.1.0] — 2026-07-28

First tagged release: the platform is deployed, end-to-end functional, and
running at [oa.laion.ai](https://oa.laion.ai).

### Added

**Accounts & security**
- Passkey authentication (WebAuthn) as the recommended sign-in method.
- Email + password login with SMTP verification and password reset, plus account
  linking in both directions — add a passkey to a password account or a password
  to a passkey account.
- **Two-factor authentication** for password logins: TOTP (Authy, Google and
  Microsoft Authenticator, 1Password, Apple Passwords) or emailed 6-digit codes,
  with ten single-use recovery codes. Implemented on `node:crypto` — no
  third-party dependency handles authentication secrets. Not offered for
  passkeys, which are already phishing-resistant multi-factor.
- A persistent warning banner that links straight to setup when a password
  account has no second factor.

**Onboarding**
- A six-step first-run walkthrough covering chat, the proxy, trace import,
  on-device privacy and account security. Skippable at any point, and replayable
  — completion is stored server-side, so it doesn't reappear on every device.

**Chat & data collection**
- Streaming browser chat with image upload, Markdown + math (KaTeX) and a
  collapsible reasoning view.
- Conversation history with reliable grouping; follow-up turns append rather than
  creating duplicates.
- Per-message model switching from the endpoint's `/v1/models`.
- BYOE: bring any OpenAI v1-compatible endpoint.
- V1 Proxy: a personal API key so external tools (VS Code Copilot, Claude Code,
  opencode, Codex) route through the logging proxy, plus an "Add to VS Code"
  helper using VS Code's secure secret-storage flow.
- Local trace import for Claude Code, VS Code Copilot Chat, OpenCode, Codex CLI
  and Google Antigravity, including protobuf extraction for Antigravity's payloads.
- My Uploads (Chat / V1 Proxy / Local traces) with preview and delete.
- Admin dashboard with category filters and server-side pagination.
- Feedback submission with an admin view and a bearer-token API for agents.

**Privacy**
- On-device PII redaction via Transformers.js (WebGPU with WASM fallback), in
  chat and before trace upload. Defaults to the lightweight `rampart` model
  (~15 MB); `openai/privacy-filter` is selectable in Settings.
- Parse-aware redaction of verbatim source envelopes, so scrubbed trace files
  stay valid JSON/JSONL.

**Deployment**
- Docker Compose, Podman quadlet, and rootless Podman install paths, all
  bind-mounting state under `data/`.
- `deploy.sh`: one command to test, sync, rebuild, restart and verify the live
  site, aborting on any failure. Databases are never in the sync path.

### Security

- Session and challenge cookies are now `Secure` (derived from the
  browser-facing scheme via `X-Forwarded-Proto`, since TLS terminates at Caddy)
  and `SameSite=Lax`. They previously carried neither.
- The server **refuses to start in production** without a unique `JWT_SECRET`.
  The development fallback is published in this repository, so any deployment
  using it had forgeable sessions.
- Rate limiting on authentication: password login is throttled per account and
  per source IP, and two-factor verification per user. Without the latter, a
  6-digit code was brute-forceable within the 10-minute challenge window by an
  attacker who already had the password.
- API keys and recovery codes are stored only as SHA-256 hashes; password hashes,
  TOTP secrets and recovery-code hashes are never serialized to the browser.
- No session cookie is issued until the second factor succeeds.

### Fixed

- `/api/ingest` could be permanently disabled on a fresh deployment: the backend
  opened the credential store once at startup, before the frontend had created
  `user.db`, and never retried. It now opens lazily on first use.
- Very large conversations (100k+ turns) crashed the UI; the thread view now
  renders in windows with incremental loading.
- Passkey verification failed behind a TLS-terminating proxy because the server
  saw an `http` origin; `X-Forwarded-Proto`/`-Host` are now honoured.
- OpenCode traces were missed after its move to SQLite storage.
- Antigravity trace extraction leaked protobuf framing into message text.
- The feedback modal could render off-screen inside a `backdrop-blur` ancestor.

[0.1.0]: https://github.com/LAION-AI/Open-Assistant-2.0/releases/tag/v0.1.0
