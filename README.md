<p align="center">
  <img src="frontend/src/logo.svg" alt="Open Assistant 2.0" width="120" />
</p>

<h1 align="center">Open Assistant 2.0</h1>

<p align="center">
  <strong>Crowdsource AI interaction data for open frontier models.</strong><br/>
  A community-driven platform by <a href="https://laion.ai">LAION</a> — the people behind the original Open Assistant.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License" /></a>
  <a href="https://github.com/LAION-AI/Open-Assistant-2.0/graphs/contributors"><img src="https://img.shields.io/github/contributors/LAION-AI/Open-Assistant-2.0?label=code%20contributors&color=blue" alt="Code contributors" /></a>
</p>

<p align="center">
  <em>Live from <a href="https://oa.laion.ai">oa.laion.ai</a>:</em><br/>
  <a href="https://oa.laion.ai"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Foa.laion.ai%2Fapi%2Fstats%2Fbadge%2Fcontributors&label=data%20contributors" alt="Data contributors" /></a>
  <a href="https://oa.laion.ai"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Foa.laion.ai%2Fapi%2Fstats%2Fbadge%2Ftraces" alt="Traces collected" /></a>
  <a href="https://oa.laion.ai"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Foa.laion.ai%2Fapi%2Fstats%2Fbadge%2Ftokens" alt="Tokens collected" /></a>
</p>

---

## Why This Exists

User interaction data — the prompts you type, the follow-ups you send, the images you upload — is one of the most valuable resources for training better AI models. Today, that data is almost entirely locked inside proprietary systems at OpenAI, Anthropic, Google, and others.

**Open Assistant 2.0** flips that model. It gives users a browser-based chat interface that connects to any OpenAI v1-compatible API endpoint. Every conversation is logged (with consent) into an open dataset that can be used to train future open-source frontier models.

> This is the spiritual successor to [Open Assistant](https://github.com/LAION-AI/Open-Assistant), rebuilt from scratch with a modern stack.

> **Your privacy matters.** You can redact personally identifiable information (PII) **on your own device** — directly in the chat and before uploading traces — using a local model that never sends your text anywhere. All collected interaction data also goes through a filtering pipeline before any public release. We will never publish raw, unfiltered conversation logs.

---

## Features

| Feature | Status | Description |
|---|---|---|
| 🔐 Passkey Authentication | ✅ Done | Passwordless login via [SimpleWebAuthn](https://simplewebauthn.dev/) — phishing-resistant, no passwords to leak |
| 📧 Email + Password Login | ✅ Done | Alternative to passkeys, with SMTP verification and password reset. Accounts can hold both and link either way |
| 🔒 Two-Factor Authentication | ✅ Done | TOTP (Authy, Google/Microsoft Authenticator, 1Password, Apple Passwords) or emailed 6-digit codes, with single-use recovery codes. Offered for password logins — passkeys already are multi-factor |
| 👋 Guided Onboarding | ✅ Done | A six-step first-run walkthrough of chat, the proxy, trace import, privacy and account security — skippable, replayable |
| 💬 Browser Chat | ✅ Done | Streaming chat with image upload, Markdown + math (KaTeX), and a collapsible reasoning/"thinking" view |
| 🗂️ Conversation History | ✅ Done | Sidebar of past chats — resume any conversation and follow-up turns append to it |
| 🔀 On-the-fly Model Switching | ✅ Done | Pick any model from your endpoint's `/v1/models` per message |
| 🔌 BYOE (Bring Your Own Endpoint) | ✅ Done | Add any OpenAI v1-compatible endpoint (key optional for local servers) — donate interaction data **and** compute |
| 🛰️ V1 Proxy for External Tools | ✅ Done | A personal API key + OpenAI-compatible endpoint so VS Code Copilot, opencode, Claude Code, etc. route through the logging proxy |
| 🧩 "Add to VS Code" | ✅ Done | One-click setup helper that lists your models and walks through the secure VS Code custom-endpoint flow |
| 📥 Local Trace Import | ✅ Done | Import existing agent sessions — Claude Code, VS Code Copilot Chat, OpenCode, Codex CLI and Google Antigravity — with local parsing, preview & per-conversation select |
| 🛡️ On-Device PII Redaction | ✅ Done | Redact names/emails/phones/etc. locally via [Transformers.js](https://github.com/huggingface/transformers.js) (WebGPU/WASM) — in chat and before trace upload. Defaults to the lightweight [`rampart`](https://huggingface.co/nationaldesignstudio/rampart) model (~15 MB); [`openai/privacy-filter`](https://huggingface.co/openai/privacy-filter) selectable in Settings |
| 📦 My Uploads | ✅ Done | Per-user view of your contributions (Chat / V1 Proxy / Local traces) with preview and delete |
| 🛡️ Admin Dashboard | ✅ Done | Users + conversations with category filters and pagination |
| 🌗 Theme Toggle | ✅ Done | System → dark → light |
| 📊 Open Dataset Export | 📋 Planned | Anonymized, exportable interaction logs for model training |

---

## Architecture

The system is a reverse-proxy gateway with a React frontend and a Go backend, stitched together by Caddy. Both layers use an **adapter pattern** so the storage backend (SQLite today, Postgres/Neon tomorrow) can be swapped without touching business logic.

| Layer | Technology | Storage (MVP) | Notes |
|---|---|---|---|
| **Frontend** | Bun + React + Shadcn + Tailwind | SQLite via `bun:sqlite` + Drizzle ORM | User accounts, passkey credentials, credits |
| **Backend** | Go (`net/http`) | SQLite via `modernc.org/sqlite` | Interaction logging, proxy request/response capture |
| **Gateway** | Caddy | — | TLS termination, routing to frontend & backend |

```
┌─────────────────────────────────────────────────┐
│                    Caddy                        │
│              (TLS + Reverse Proxy)              │
└──────────┬──────────────────┬───────────────────┘
           │                  │
     ┌─────▼─────┐     ┌─────▼─────┐
     │  Frontend  │     │  Backend  │
     │  Bun+React │     │  Go Proxy │
     │            │     │           │
     │  user.db   │     │  logs.db  │
     └────────────┘     └───────────┘
```

<details>
<summary><strong>Directory Structure</strong></summary>

```
.
├── start-dev.sh              # Starts backend (8080) + frontend (3000) together
├── backend/                  # Go proxy & interaction logger
│   ├── db/
│   │   ├── repository.go     # Database adapter interface
│   │   └── sqlite_adapter.go # SQLite implementation (logs, pagination, redaction updates)
│   ├── main.go               # HTTP server & log/admin endpoints
│   └── proxy/                # OpenAI v1 stream proxy (logging, tool-call capture)
├── frontend/                 # Bun + React + Shadcn app
│   ├── src/
│   │   ├── App.tsx           # Shell, tabs (Chat / Uploads / BYOE / Admin), theme
│   │   ├── index.ts          # Bun HTTP server: auth, chat proxy, V1 proxy, traces
│   │   ├── db/               # Drizzle schema + swappable storage adapters
│   │   ├── lib/
│   │   │   ├── chat.ts        # Conversation grouping / reconstruction
│   │   │   ├── traces.ts      # Trace parsing (Claude Code / VS Code / OpenCode)
│   │   │   └── redact.ts      # On-device PII redaction (Transformers.js)
│   │   └── components/        # ChatPanel, UploadsPanel, AdminPanel, TraceUpload, …
│   └── package.json
├── LICENSE                   # Apache 2.0
└── README.md
```

</details>

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) ≥ 1.0
- [Go](https://go.dev/) ≥ 1.21

### Run everything (recommended)

From the repo **root**:

```sh
git clone https://github.com/LAION-AI/Open-Assistant-2.0.git
cd Open-Assistant-2.0
sh start-dev.sh
```

`start-dev.sh` starts **everything you need**: it builds & launches the Go proxy backend (port **8080**) and the Bun frontend dev server (port **3000**) together, and stops both on `Ctrl+C`. Then open **http://localhost:3000**.

> **macOS note:** the first time, approve the system **"Local Network"** prompt for the backend so it can reach LAN model servers (e.g. `192.168.x.x`). Without it you'll see `502 / no route to host` on chat even though "fetch models" works.

### Run the frontend only

If you just want the UI (e.g. against an already-running backend):

```sh
cd frontend
bun install
bun dev
```

The dev server starts at `http://localhost:3000` with hot module reloading.

### Production deployment

All options run Caddy (automatic HTTPS) → frontend → backend, with every piece of
state bind-mounted under `data/` — no named volumes, nothing to lose on a rebuild.

| Option | Use when | Command |
|---|---|---|
| **Docker Compose** | Docker is available | `docker compose up -d --build` |
| **Podman quadlets** | Podman **≥ 4.4** (quadlet ships with it) | [`deploy/install-quadlet.sh`](deploy/install-quadlet.sh) |
| **Podman rootless** | Older podman, or a kernel without `CONFIG_CGROUP_BPF` | [`deploy/install-rootless.sh`](deploy/install-rootless.sh) |

Configuration lives in `.env` (DOMAIN, ACME_EMAIL, ALLOWED_HOSTS, SMTP) and
`frontend.env` (JWT_SECRET, FEEDBACK_TOKEN). Two requirements are enforced at
startup rather than failing mysteriously later:

- **`JWT_SECRET` must be set in production.** The development fallback is
  published in this repo, so sessions signed with it would be forgeable. Generate
  one with `openssl rand -base64 48`.
- **`ALLOWED_HOSTS` must equal your domain.** It is the WebAuthn relying-party id;
  a mismatch breaks passkey login. Compose expands `${DOMAIN}` for you, but systemd
  does not, so set it explicitly.

#### Pushing an update

From a checkout, [`deploy.sh`](deploy.sh) runs the tests, syncs the tree, rebuilds
and restarts on the server, and verifies the live site — aborting if any step
fails. Databases are never in the sync path.

```sh
bash deploy.sh              # test, sync, rebuild, restart, verify
bash deploy.sh --skip-tests # skip the local test gate
```

---

## Roadmap

### Phase 1 — Foundation
- [x] Project scaffolding (Bun + React + Shadcn)
- [x] Passkey registration & login (SimpleWebAuthn)
- [x] Browser chat UI (streaming, image upload, Markdown + math, reasoning view)
- [x] SQLite user store with Drizzle ORM
- [x] Go backend with interaction logging

### Phase 2 — Endpoint Donation *(current)*
- [x] User-provided v1-compatible endpoint configuration (BYOE)
- [x] Proxy layer streams through user endpoints
- [x] On-the-fly model selection from `/v1/models`
- [x] Conversation history & resume
- [x] V1 Proxy + personal API keys for external tools (VS Code, opencode, Claude Code…)
- [x] Local trace import (Claude Code, VS Code Copilot, OpenCode SQLite)
- [x] On-device PII redaction (Transformers.js)
- [x] Admin dashboard (category filters + pagination) and per-user "My Uploads"

### Phase 3 — Hosted Access
- [ ] Credit system for API access
- [ ] Hosted v1-compatible endpoint with API tokens
- [ ] Donation-funded compute pool
- [ ] Dataset export & publishing pipeline

---

## Contributing

This is an early-stage project and contributions are very welcome — whether that's code, design, documentation, or ideas.

1. Fork the repo and create a feature branch
2. Make your changes
3. Open a pull request with a clear description

If you're unsure where to start, look for issues labeled `good first issue` or open a discussion.

---

## License

[Apache 2.0](LICENSE) — use it, fork it, build on it.