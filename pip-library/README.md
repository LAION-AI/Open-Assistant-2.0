# Open Assistant Proxy

A pip-installable local completions proxy for Open Assistant 2.0. It sits between
your coding agent and your model provider, transparently forwarding requests
while capturing the conversation, **redacting PII and secrets entirely on-device**,
and uploading the cleaned trace to the Open Assistant server.

## Supported formats

The proxy captures every request shape a modern agent might speak, for whichever
provider your upstream points at:

| Endpoint | Used by |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible clients, Claude Code (OpenAI mode), Cursor, opencode |
| `POST /v1beta/chat/completions` | Google Gemini OpenAI-compat clients |
| `POST /v1/responses` | OpenAI Responses API clients (Codex) |
| `POST /v1/messages` | Anthropic Messages API clients (Claude Code native) |

All four normalize into one trace schema, including tool calls, tool results and
reasoning — not just prose.

## Redaction

Two on-device layers run before anything leaves the machine:

1. **Secret scanning** — deterministic patterns for API keys (OpenAI, Anthropic,
   AWS, Google, GitHub, Slack), JWTs, bearer tokens, private-key blocks and
   `KEY=value` style credentials. These are exactly what dev tools leak and a
   PII model won't catch.
2. **PII NER** — the `openai/privacy-filter` Hugging Face model redacts names,
   emails, phone numbers, etc.

Redaction covers message content, reasoning, **tool-call arguments** and **tool
results**. It runs off the request path in a background worker, so proxied
requests are never blocked by model inference.

## Installation

```bash
pip install "git+https://github.com/LAION-AI/Open-Assistant-2.0.git@first-poc#subdirectory=pip-library"
```

## Quick Start

1. Register an account on the Open Assistant website (`https://oa.laion.ai`) and get your API key from the Settings panel.
2. Configure your local proxy settings (upstream provider, keys, port):
   ```bash
   oa-proxy config
   ```
3. Initialize the on-device redactor (downloads the `openai/privacy-filter` Hugging Face model):
   ```bash
   oa-proxy setup
   ```
4. Start the completions proxy server:
   ```bash
   oa-proxy start
   ```

Point any standard OpenAI/Anthropic client or agent tool (e.g. Claude Code, Cursor, Codex, opencode) to `http://localhost:2048/v1` to donate redacted traces. Visit `http://localhost:2048/` for a live status dashboard.

```bash
# Example: Claude Code via the OpenAI-compatible endpoint
claude --openai-base-url http://localhost:2048/v1 --openai-api-key <proxy-key>
```

Multi-turn sessions are deduplicated server-side via a stable conversation id, so a growing chat updates one record instead of piling up one row per turn.
