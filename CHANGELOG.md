# Changelog

All notable changes to Open Assistant 2.0 are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
