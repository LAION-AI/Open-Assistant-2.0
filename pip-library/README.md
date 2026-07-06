# Open Assistant Proxy

A pip-installable python client library and local completions proxy for Open Assistant 2.0. Runs entirely on-device to redact PII (Personal Identifiable Information) before uploading interaction logs to the Open Assistant server.

## Installation

```bash
pip install open-assistant-proxy
```

## Quick Start

1. Register an account on the Open Assistant website (`https://oa.laion.ai`) and get your API key from the Settings panel.
2. Configure your local proxy settings:
   ```bash
   oa-proxy config
   ```
3. Initialize the PII redactor (downloads the `openai/privacy-filter` Hugging Face model on-device):
   ```bash
   oa-proxy setup
   ```
4. Start the completions proxy server:
   ```bash
   oa-proxy start
   ```

Point any standard OpenAI client or agent tool (e.g. Claude Code, Cursor, Copilot) to `http://localhost:1010/v1` to donate redacted traces.
