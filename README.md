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
</p>

---

## Why This Exists

User interaction data — the prompts you type, the follow-ups you send, the images you upload — is one of the most valuable resources for training better AI models. Today, that data is almost entirely locked inside proprietary systems at OpenAI, Anthropic, Google, and others.

**Open Assistant 2.0** flips that model. It gives users a browser-based chat interface that connects to any OpenAI v1-compatible API endpoint. Every conversation is logged (with consent) into an open dataset that can be used to train future open-source frontier models.

> This is the spiritual successor to [Open Assistant](https://github.com/LAION-AI/Open-Assistant), rebuilt from scratch with a modern stack.

> **Your privacy matters.** All collected interaction data goes through a filtering pipeline before any public release — personally identifiable information (PII) and legally non-compliant content are removed. We will never publish raw, unfiltered conversation logs.

---

## Features

| Feature | Status | Description |
|---|---|---|
| 🔐 Passkey Authentication | 🚧 In Progress | Passwordless login via [SimpleWebAuthn](https://simplewebauthn.dev/) — phishing-resistant, no passwords to leak |
| 💬 Browser Chat | 🚧 In Progress | Simple Q&A chat with image upload support |
| 🔌 BYOE (Bring Your Own Endpoint) | 📋 Planned | Users add their own v1-compatible endpoint — donating both interaction data **and** compute |
| 🎟️ Hosted API Access | 📋 Planned | API token + hosted endpoint for users who contribute credits or donations |
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
├── backend/                  # Go proxy & interaction logger
│   ├── db/
│   │   ├── repository.go     # Database adapter interface
│   │   └── sqlite_adapter.go # SQLite implementation
│   ├── main.go               # HTTP server & initializer
│   └── proxy/                # OpenAI v1 stream proxy logic
├── frontend/                 # Bun + React + Shadcn app
│   ├── src/
│   │   ├── App.tsx           # Main application component
│   │   ├── index.ts          # Bun HTTP server with HMR
│   │   ├── db/
│   │   │   ├── schema.ts     # Drizzle schema (users, credentials)
│   │   │   ├── client.ts     # Database client instantiation
│   │   │   └── adapters/     # Swappable storage backends
│   │   └── components/       # Shadcn UI components
│   └── package.json
├── LICENSE                   # Apache 2.0
└── README.md
```

</details>

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) ≥ 1.0
- [Go](https://go.dev/) ≥ 1.21 (for backend, when implemented)

### Run the Frontend

```sh
git clone https://github.com/LAION-AI/Open-Assistant-2.0.git
cd Open-Assistant-2.0/frontend
bun install
bun dev
```

The dev server starts at `http://localhost:3000` with hot module reloading.

---

## Roadmap

### Phase 1 — Foundation *(current)*
- [x] Project scaffolding (Bun + React + Shadcn)
- [ ] Passkey registration & login (SimpleWebAuthn)
- [ ] Browser chat UI (text + image upload)
- [ ] SQLite user store with Drizzle ORM
- [ ] Go backend with interaction logging

### Phase 2 — Endpoint Donation
- [ ] User-provided v1-compatible endpoint configuration
- [ ] Proxy layer streams through user endpoints
- [ ] Interaction data capture & consent flow

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