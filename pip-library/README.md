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

## Lossless source capture

Each upload also carries the **exact wire request** (as a "source envelope"),
so the stored trace can be converted back to the original provider format —
nothing is lost in normalization. The raw copy is deep-redacted on-device with
the same two layers before upload: every prose string is scrubbed (structural
fields like ids, roles and model names are preserved so the reconstructed
request stays machine-readable), and redaction is fingerprint-cached per
message, so multi-turn sessions only pay to redact the newest turns.

To upload only the normalized, redacted messages instead, set
`"upload_raw_source": false` in `~/.open_assistant/config.json`.

## Upload saved sessions: `oa-proxy upload`

Besides live capture, the CLI can parse and upload sessions the agents already
saved to disk:

```bash
# Preview what would be uploaded (nothing leaves the machine)
oa-proxy upload --dry-run ~/.claude/projects ~/.codex/sessions

# Redact on-device, then upload
oa-proxy upload ~/.pi/agent/sessions myproject/.crush/crush.db ~/.hermes/state.db
```

Understood formats (files or whole folders; noise like `node_modules` and
config files is skipped automatically):

| Agent | Location |
|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| OpenAI Codex | `~/.codex/sessions/**/rollout-*.jsonl` |
| command-code | `~/.command-code/projects/**/*.jsonl` |
| pi | `~/.pi/agent/sessions/**/*.jsonl` |
| Crush | `<project>/.crush/crush.db` |
| Hermes Agent | `~/.hermes/state.db` |
| OpenCode | `~/.local/share/opencode/opencode.db` |
| OpenAI-style JSON | `{"model", "messages": [...]}` / message arrays |

Each conversation is uploaded with its normalized messages **and** the
verbatim source (lossless back-conversion), both redacted on-device first
(`--no-redact` to skip, `--platform <name>` to filter). Conversation ids are
derived deterministically from the session, so re-running the command updates
existing rows instead of duplicating them.

## Agent setup: Claude Code & Codex

Both agents work through the proxy — including "yolo" (no-approval) mode —
with the quirks from the
[Unsloth Claude Code](https://unsloth.ai/docs/basics/claude-code) and
[Codex](https://unsloth.ai/docs/basics/codex) guides handled for you.

### Claude Code (Anthropic Messages API)

Claude Code speaks the Anthropic API, so point `ANTHROPIC_BASE_URL` at the
proxy **without** a `/v1` suffix (Claude Code appends `/v1/messages` itself):

```bash
export ANTHROPIC_BASE_URL="http://localhost:2048"
export ANTHROPIC_AUTH_TOKEN="<your proxy_api_key>"   # shown on the dashboard
export ANTHROPIC_API_KEY=""                          # so no cloud-key prompt
claude                                                # add --dangerously-skip-permissions for yolo mode
```

**KV-cache quirk (90% slower local inference), handled proxy-side:** Claude
Code prepends an `x-anthropic-billing-header: …` line to the system prompt
whose value changes on *every* request, which invalidates the upstream KV
cache each turn — and would also defeat this proxy's per-message redaction
cache. The proxy strips that line before forwarding and capture (even for
older Claude Code builds that ignore `CLAUDE_CODE_ATTRIBUTION_HEADER=0`).
Setting the env var too is still good practice:

```bash
claude --settings '{"env":{"CLAUDE_CODE_ATTRIBUTION_HEADER":"0"}}'
```

For extra cache reuse on local models, launch with
`--bare --exclude-dynamic-system-prompt-sections` (smaller, stabler prompt
prefix). To opt out of the proxy-side strip, set
`"strip_attribution_header": false` in `~/.open_assistant/config.json`.

### Codex (OpenAI Responses API)

Codex now uses the Responses API **exclusively** (`wire_api = "chat"` is
rejected). The proxy captures `/v1/responses` natively — including reasoning
summaries, `function_call` and `custom_tool_call`/`apply_patch` items. In
`~/.codex/config.toml`:

```toml
[model_providers.open_assistant]
name                 = "Open Assistant proxy"
base_url             = "http://localhost:2048/v1"
env_key              = "OPEN_ASSISTANT_PROXY_KEY"
wire_api             = "responses"
requires_openai_auth = false     # skips the "Sign in with ChatGPT" screen

[profiles.open_assistant]
model_provider = "open_assistant"
model          = "<model id from GET http://localhost:2048/v1/models>"
```

```bash
export OPEN_ASSISTANT_PROXY_KEY="<your proxy_api_key>"
codex --profile open_assistant       # add --dangerously-bypass-approvals-and-sandbox for yolo mode
```

A `Model metadata for … not found` warning for non-OpenAI model ids is
harmless; silence it with `model_context_window = 131072` (your model's real
context size) at the top of `config.toml`.

Both endpoints are forwarded to your configured `upstream_url` as-is, so the
upstream must actually serve them — recent `llama-server` builds serve
`/v1/messages` and `/v1/responses` alongside `/v1/chat/completions`.

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
