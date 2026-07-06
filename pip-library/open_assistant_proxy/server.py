import json
import asyncio
import hashlib
import collections
import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import StreamingResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from .config import load_config, ensure_proxy_api_key, rotate_proxy_api_key
from .redactor import load_classifier, redact_messages

app = FastAPI(title="Open Assistant local completions proxy")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

config = load_config()
classifier = None

# Runtime stats
stats = {
    "uploads_ok": 0,
    "uploads_failed": 0,
    "redacting": 0,   # count of in-flight redactions
}

# LRU cache of previously redacted conversation histories (avoids re-redacting multi-turn threads)
_REDACTED_CACHE_MAX = 100
_redacted_cache: collections.OrderedDict = collections.OrderedDict()

def _conversation_fingerprint(messages: list) -> str:
    """Stable fingerprint of a message list based on role + content."""
    key = [{"role": m.get("role", ""), "content": m.get("content") or ""} for m in messages]
    return hashlib.sha256(json.dumps(key, sort_keys=True, ensure_ascii=True).encode()).hexdigest()

def _cache_get(fp: str):
    if fp in _redacted_cache:
        _redacted_cache.move_to_end(fp)
        return _redacted_cache[fp]
    return None

def _cache_set(fp: str, value: list) -> None:
    _redacted_cache[fp] = value
    _redacted_cache.move_to_end(fp)
    if len(_redacted_cache) > _REDACTED_CACHE_MAX:
        _redacted_cache.popitem(last=False)

@app.on_event("startup")
def startup_event():
    global classifier
    ensure_proxy_api_key()
    try:
        classifier = load_classifier()
        print("On-device PII redactor loaded successfully.")
    except Exception as e:
        print(f"Warning: Could not load redactor model on startup. It will load lazily later: {e}")

@app.get("/", response_class=HTMLResponse)
async def status_page():
    cfg = load_config()
    proxy_key = cfg.get("proxy_api_key") or ensure_proxy_api_key()
    api_key = cfg.get("api_key", "")
    redacted_key = "(set in the Open Assistant app)" if not api_key else f"{api_key[:4]}{'*' * (len(api_key) - 4)}"
    rows = [
        ("Open Assistant Server URL", cfg.get("server_url", "")),
        ("Open Assistant API Key", redacted_key),
        ("Upstream API Base URL", cfg.get("upstream_url", "")),
        ("Upstream Default Model", cfg.get("upstream_model", "")),
        ("Upstream API Key", "***" if cfg.get("upstream_key") else "(not set)"),
        ("Local Proxy Port", str(cfg.get("port", 2048))),
        ("Local Proxy Host", cfg.get("host", "127.0.0.1")),
    ]
    rows_html = "".join(
        f"<tr><td>{label}</td><td><code>{value}</code></td></tr>"
        for label, value in rows
    )
    port = cfg.get("port", 2048)
    host = cfg.get("host", "127.0.0.1")
    upstream_model = cfg.get("upstream_model", "")
    base_url = f"http://{host}:{port}/v1"

    redacting = stats["redacting"] > 0
    redacting_badge = (
        '<span class="badge badge-busy">redacting&hellip;</span>' if redacting else ""
    )
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Open Assistant Proxy</title>
  {'<meta http-equiv="refresh" content="3">' if redacting else ''}
  <style>
    body {{ font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 16px; color: #1a1a1a; }}
    h1 {{ font-size: 1.4rem; margin-bottom: 4px; }}
    p.sub {{ color: #555; margin-top: 0; font-size: 0.9rem; }}
    table {{ border-collapse: collapse; width: 100%; margin-top: 24px; }}
    th, td {{ text-align: left; padding: 10px 12px; border-bottom: 1px solid #e5e5e5; font-size: 0.9rem; }}
    th {{ color: #555; font-weight: 600; }}
    code {{ background: #f3f3f3; padding: 2px 6px; border-radius: 4px; font-size: 0.85em; }}
    .badge {{ display: inline-block; color: #fff; font-size: 0.75rem;
              padding: 2px 8px; border-radius: 99px; vertical-align: middle; margin-left: 8px; }}
    .badge-running {{ background: #22c55e; }}
    .badge-busy {{ background: #f59e0b; }}
    .stats {{ display: flex; gap: 24px; margin-top: 28px; }}
    .stat {{ background: #f9f9f9; border: 1px solid #e5e5e5; border-radius: 8px;
             padding: 12px 20px; flex: 1; text-align: center; }}
    .stat-num {{ font-size: 1.6rem; font-weight: 700; }}
    .stat-ok .stat-num {{ color: #22c55e; }}
    .stat-fail .stat-num {{ color: #ef4444; }}
    .stat-busy .stat-num {{ color: #f59e0b; }}
    .stat-label {{ font-size: 0.78rem; color: #666; margin-top: 2px; }}
    .endpoint-card {{ background: #f0f7ff; border: 1px solid #bfdbfe; border-radius: 10px;
                      padding: 16px 20px; margin-top: 28px; }}
    .endpoint-card h2 {{ font-size: 0.95rem; font-weight: 700; margin: 0 0 12px 0; color: #1e40af; }}
    .endpoint-row {{ display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px;
                     font-size: 0.88rem; flex-wrap: wrap; }}
    .endpoint-row label {{ color: #555; min-width: 110px; flex-shrink: 0; }}
    .endpoint-row code {{ background: #dbeafe; color: #1e3a8a; word-break: break-all; }}
    .endpoint-card .hint {{ font-size: 0.78rem; color: #64748b; margin-top: 12px; border-top: 1px solid #bfdbfe; padding-top: 10px; }}
    .endpoint-card .hint code {{ background: #e0f2fe; }}
    .btn {{ display: inline-block; margin-top: 14px; padding: 7px 16px; background: #3b82f6;
            color: #fff; border: none; border-radius: 6px; font-size: 0.85rem; cursor: pointer;
            font-family: inherit; transition: background 0.15s; }}
    .btn:hover {{ background: #2563eb; }}
    .btn:disabled {{ background: #93c5fd; cursor: default; }}
    .btn-sm {{ display: inline-block; padding: 2px 9px; background: #e2e8f0; color: #334155;
               border: 1px solid #cbd5e1; border-radius: 5px; font-size: 0.78rem; cursor: pointer;
               font-family: inherit; transition: background 0.15s; margin-left: 6px; }}
    .btn-sm:hover {{ background: #cbd5e1; }}
    .btn-sm:disabled {{ opacity: 0.5; cursor: default; }}
    .test-result {{ margin-top: 10px; font-size: 0.82rem; padding: 8px 12px; border-radius: 6px;
                    display: none; word-break: break-all; }}
    .test-result.ok {{ background: #dcfce7; color: #166534; border: 1px solid #86efac; }}
    .test-result.err {{ background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }}
  </style>
</head>
<body>
  <h1>Open Assistant Proxy
    <span class="badge badge-running">running</span>
    {redacting_badge}
  </h1>
  <p class="sub">OpenAI-compatible endpoint: <code>/v1/chat/completions</code></p>

  <div class="endpoint-card">
    <h2>OpenAI-compatible endpoint settings</h2>
    <div class="endpoint-row">
      <label>Base URL</label>
      <code>{base_url}</code>
    </div>
    <div class="endpoint-row">
      <label>API Key</label>
      <code id="proxy-key-display">{proxy_key}</code>
      <button class="btn-sm" id="rotate-btn" onclick="rotateKey()" title="Generate a new proxy API key">&#x21bb; Rotate</button>
    </div>
    <div class="endpoint-row">
      <label>Model</label>
      <code>{upstream_model}</code>
    </div>
    <div class="hint">
      <strong>Claude Code:</strong>
      <code>claude --openai-base-url {base_url} --openai-api-key {proxy_key}</code><br>
      <br>
      <strong>Environment variables:</strong><br>
      <code>OPENAI_BASE_URL={base_url}</code><br>
      <code>OPENAI_API_KEY={proxy_key}</code>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;">
      <button class="btn" id="test-btn" onclick="testEndpoint()">Test endpoint through proxy</button>
      <button class="btn" id="test-upstream-btn" style="background:#6366f1;" onclick="testUpstream()">Test upstream directly</button>
    </div>
    <div id="test-result" class="test-result"></div>
    <div id="test-upstream-result" class="test-result"></div>
  </div>

  <div class="stats">
    <div class="stat stat-ok">
      <div class="stat-num">{stats['uploads_ok']}</div>
      <div class="stat-label">traces uploaded</div>
    </div>
    <div class="stat stat-busy">
      <div class="stat-num">{stats['redacting']}</div>
      <div class="stat-label">processing</div>
    </div>
    <div class="stat stat-fail">
      <div class="stat-num">{stats['uploads_failed']}</div>
      <div class="stat-label">upload failures</div>
    </div>
  </div>
  <table>
    <thead><tr><th>Setting</th><th>Value</th></tr></thead>
    <tbody>{rows_html}</tbody>
  </table>
  <p style="margin-top:24px;font-size:0.8rem;color:#888;">
    Run <code>oa-proxy config</code> to change these settings.
  </p>
  <script>
    async function testEndpoint() {{
      const btn = document.getElementById('test-btn');
      const result = document.getElementById('test-result');
      btn.disabled = true;
      btn.textContent = 'Testing\u2026';
      result.style.display = 'none';
      try {{
        const res = await fetch('/v1/chat/completions', {{
          method: 'POST',
          headers: {{ 'Content-Type': 'application/json', 'Authorization': 'Bearer {proxy_key}' }},
          body: JSON.stringify({{
            model: '{upstream_model}',
            messages: [{{ role: 'user', content: 'Reply with just the word PONG.' }}],
            max_tokens: 16,
            stream: false
          }})
        }});
        const data = await res.json();
        if (!res.ok) {{
          throw new Error(data.detail || data.error?.message || 'HTTP ' + res.status);
        }}
        const text = data.choices?.[0]?.message?.content ?? JSON.stringify(data);
        result.className = 'test-result ok';
        result.textContent = '\u2713 Upstream replied: ' + text.trim();
      }} catch (e) {{
        result.className = 'test-result err';
        result.textContent = '\u2717 ' + e.message;
      }} finally {{
        result.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Test endpoint through proxy';
      }}
    }}
    async function testUpstream() {{
      const btn = document.getElementById('test-upstream-btn');
      const result = document.getElementById('test-upstream-result');
      btn.disabled = true;
      btn.textContent = 'Testing\u2026';
      result.style.display = 'none';
      try {{
        const res = await fetch('/test-upstream', {{ method: 'POST' }});
        const data = await res.json();
        if (data.ok) {{
          result.className = 'test-result ok';
          result.textContent = '\u2713 Upstream replied: ' + data.reply;
        }} else {{
          result.className = 'test-result err';
          result.textContent = '\u2717 ' + data.error;
        }}
      }} catch (e) {{
        result.className = 'test-result err';
        result.textContent = '\u2717 ' + e.message;
      }} finally {{
        result.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Test upstream directly';
      }}
    }}
    async function rotateKey() {{
      if (!confirm('Generate a new proxy API key? You will need to update all clients that use the current key.')) return;
      const btn = document.getElementById('rotate-btn');
      btn.disabled = true;
      try {{
        const res = await fetch('/rotate-proxy-key', {{ method: 'POST' }});
        const data = await res.json();
        document.getElementById('proxy-key-display').textContent = data.proxy_api_key;
      }} catch (e) {{
        alert('Failed to rotate key: ' + e.message);
      }} finally {{
        btn.disabled = false;
      }}
    }}
  </script>
</body>
</html>"""
    return HTMLResponse(content=html)


async def upload_interaction(prompt_messages: list, assistant_response: str, model: str):
    global classifier
    if not classifier:
        try:
            classifier = load_classifier()
        except Exception as e:
            print(f"Warning: Could not load PII redactor. Interaction was NOT uploaded: {e}")
            return

    if not prompt_messages:
        return

    def _to_history_msg(m: dict) -> dict:
        return {
            "role": m.get("role", "user"),
            "content": m.get("content") or "",
            "reasoning_content": m.get("reasoning_content") or m.get("reasoning") or "",
        }

    # For multi-turn conversations the client sends the full message history each request.
    # We cache the redacted history keyed by a fingerprint of prior turns, so we only
    # need to redact the newest user+assistant pair each time.
    prev_raw = prompt_messages[:-1]  # All turns already seen in previous requests
    new_history = [_to_history_msg(prompt_messages[-1])]  # The new user message
    if assistant_response:
        new_history.append({"role": "assistant", "content": assistant_response})

    cached_redacted = None
    if prev_raw:
        cached_redacted = _cache_get(_conversation_fingerprint(prev_raw))

    stats["redacting"] += 1
    try:
        if cached_redacted is not None:
            # Only redact the new messages; prepend already-redacted history
            new_redacted = redact_messages(new_history, classifier)
            redacted_messages = list(cached_redacted) + new_redacted
        else:
            # New or uncached conversation — redact the full history
            full_history = [_to_history_msg(m) for m in prompt_messages]
            if assistant_response:
                full_history.append({"role": "assistant", "content": assistant_response})
            redacted_messages = redact_messages(full_history, classifier)
    except Exception as e:
        print(f"PII Redaction failed: {e}")
        return
    finally:
        stats["redacting"] = max(0, stats["redacting"] - 1)

    # Cache the full redacted conversation so the next turn can reuse it
    cache_key_msgs = list(prompt_messages) + ([{"role": "assistant", "content": assistant_response}] if assistant_response else [])
    _cache_set(_conversation_fingerprint(cache_key_msgs), redacted_messages)

    api_key = config.get("api_key")
    if not api_key:
        print("Warning: No Open Assistant API Key configured. Redacted trace was NOT uploaded.")
        return

    server_url = config.get("server_url", "https://oa.laion.ai/").rstrip("/")
    upload_url = f"{server_url}/api/traces/upload"

    payload = {
        "traces": [
            {
                "model": model,
                "platform": "pip-library",
                "messages": redacted_messages,
            }
        ]
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }

    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(upload_url, json=payload, headers=headers, timeout=15.0)
            if res.status_code == 200:
                stats["uploads_ok"] += 1
                print(f"Successfully uploaded redacted trace to Open Assistant ({len(redacted_messages)} turns).")
            else:
                stats["uploads_failed"] += 1
                print(f"Failed to upload trace: Server responded with status {res.status_code}: {res.text}")
    except Exception as e:
        stats["uploads_failed"] += 1
        print(f"Error uploading trace to Open Assistant: {e}")

@app.post("/v1/chat/completions")
async def proxy_completions(request: Request):
    global config
    config = load_config() # Reload config on each request in case it was changed

    # Validate proxy API key
    proxy_api_key = config.get("proxy_api_key")
    if proxy_api_key:
        auth_header = request.headers.get("Authorization", "")
        provided_key = auth_header.removeprefix("Bearer ").strip()
        if provided_key != proxy_api_key:
            raise HTTPException(status_code=401, detail="Invalid proxy API key")

    body = await request.json()
    messages = body.get("messages", [])
    model_requested = body.get("model", config["upstream_model"])
    
    headers = {
        "Content-Type": "application/json",
    }
    if config["upstream_key"]:
        headers["Authorization"] = f"Bearer {config['upstream_key']}"
        
    upstream_url = config["upstream_url"]
    if not upstream_url.endswith("/chat/completions"):
        upstream_url = upstream_url.rstrip("/") + "/chat/completions"
        
    client = httpx.AsyncClient()
    
    if body.get("stream", False):
        async def stream_generator():
            assistant_response = ""
            try:
                async with client.stream("POST", upstream_url, json=body, headers=headers, timeout=60.0) as response:
                    if response.status_code != 200:
                        error_text = await response.aread()
                        yield error_text
                        return
                    async for chunk in response.aiter_text():
                        yield chunk
                        # Extract SSE content chunks
                        for line in chunk.split("\n"):
                            if line.startswith("data: "):
                                data_str = line[6:].strip()
                                if data_str == "[DONE]":
                                    continue
                                try:
                                    data = json.loads(data_str)
                                    delta = data.get("choices", [{}])[0].get("delta", {})
                                    content = delta.get("content", "")
                                    assistant_response += content
                                except Exception:
                                    pass
            except Exception as e:
                print(f"Error proxying stream: {e}")
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
                return
            finally:
                await client.aclose()
            # Fire-and-forget: upload after stream completes without holding the connection open
            asyncio.create_task(upload_interaction(messages, assistant_response, model_requested))
            
        return StreamingResponse(stream_generator(), media_type="text/event-stream")
    else:
        try:
            async with client:
                response = await client.post(upstream_url, json=body, headers=headers, timeout=60.0)
                if response.status_code != 200:
                    raise HTTPException(status_code=response.status_code, detail=response.text)
                
                res_data = response.json()
                assistant_response = res_data.get("choices", [{}])[0].get("message", {}).get("content", "")
                asyncio.create_task(upload_interaction(messages, assistant_response, model_requested))
                return res_data
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

@app.get("/v1/models")
async def list_models(request: Request):
    global config
    config = load_config()

    proxy_api_key = config.get("proxy_api_key")
    if proxy_api_key:
        auth_header = request.headers.get("Authorization", "")
        provided_key = auth_header.removeprefix("Bearer ").strip()
        if provided_key != proxy_api_key:
            raise HTTPException(status_code=401, detail="Invalid proxy API key")

    upstream_url = config["upstream_url"]
    base_url = upstream_url.replace("/chat/completions", "")
    models_url = base_url.rstrip("/") + "/models"
    
    headers = {}
    if config["upstream_key"]:
        if "googleapis.com" in models_url:
            separator = "&" if "?" in models_url else "?"
            models_url = f"{models_url}{separator}key={config['upstream_key']}"
        else:
            headers["Authorization"] = f"Bearer {config['upstream_key']}"
            
    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(models_url, headers=headers, timeout=10.0)
            if res.status_code == 200:
                res_data = res.json()
                if "models" in res_data and "googleapis.com" in models_url:
                    openai_models = []
                    for m in res_data["models"]:
                        name = m.get("name", "").replace("models/", "")
                        if name:
                            openai_models.append({
                                "id": name,
                                "object": "model",
                                "owned_by": "google"
                            })
                    return {"object": "list", "data": openai_models}
                return res_data
    except Exception:
        pass
        
    return {"object": "list", "data": [{"id": config["upstream_model"], "object": "model", "owned_by": "custom"}]}


@app.post("/rotate-proxy-key")
async def do_rotate_proxy_key():
    new_key = rotate_proxy_api_key()
    return {"proxy_api_key": new_key}


@app.post("/test-upstream")
async def test_upstream_direct():
    cfg = load_config()
    upstream_url = cfg["upstream_url"]
    if not upstream_url.endswith("/chat/completions"):
        upstream_url = upstream_url.rstrip("/") + "/chat/completions"

    headers = {"Content-Type": "application/json"}
    if cfg.get("upstream_key"):
        headers["Authorization"] = f"Bearer {cfg['upstream_key']}"

    body = {
        "model": cfg["upstream_model"],
        "messages": [{"role": "user", "content": "Reply with just the word PONG."}],
        "max_tokens": 16,
        "stream": False,
    }

    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(upstream_url, json=body, headers=headers, timeout=30.0)
            if res.status_code != 200:
                return {"ok": False, "error": f"HTTP {res.status_code}: {res.text[:400]}"}
            data = res.json()
            reply = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            return {"ok": True, "reply": reply.strip()}
    except Exception as e:
        return {"ok": False, "error": str(e)}
