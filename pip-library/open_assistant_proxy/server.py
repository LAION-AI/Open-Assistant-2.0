import re
import json
import time
import asyncio
import hashlib
import collections
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import StreamingResponse, HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from .config import (
    load_config,
    load_config_cached,
    ensure_proxy_api_key,
    rotate_proxy_api_key,
)
from .redactor import load_classifier, redact_messages
from .adapters import ADAPTERS

# How long to wait on the upstream. Streaming (agentic/reasoning) turns can run
# for minutes, so give the read a generous ceiling while still bounding a stall.
STREAM_TIMEOUT = httpx.Timeout(300.0, connect=15.0)
NONSTREAM_TIMEOUT = httpx.Timeout(120.0, connect=15.0)

# Bound on the async upload queue; if the model can't keep up we drop rather
# than grow memory without limit.
UPLOAD_QUEUE_MAX = 200
# Per-message redaction cache (fingerprint -> redacted message).
MSG_CACHE_MAX = 4000

classifier = None

# Runtime stats surfaced on the dashboard.
stats = {
    "uploads_ok": 0,
    "uploads_failed": 0,
    "dropped": 0,
}

# Recent upload outcomes so failures are visible instead of only printed.
_recent_uploads: collections.deque = collections.deque(maxlen=20)

_upload_queue: "asyncio.Queue | None" = None
_worker_task: "asyncio.Task | None" = None
_msg_cache: "collections.OrderedDict" = collections.OrderedDict()


# --------------------------------------------------------------------------- #
# Lifespan: start the background upload worker and warm the redactor
# --------------------------------------------------------------------------- #

@asynccontextmanager
async def lifespan(app: FastAPI):
    global classifier, _upload_queue, _worker_task
    ensure_proxy_api_key()
    _upload_queue = asyncio.Queue(maxsize=UPLOAD_QUEUE_MAX)
    _worker_task = asyncio.create_task(_upload_worker())
    try:
        classifier = await asyncio.to_thread(load_classifier)
        print("On-device PII redactor loaded successfully.")
    except Exception as e:
        print(f"Warning: Could not load redactor model on startup. It will load lazily later: {e}")
    try:
        yield
    finally:
        if _worker_task:
            _worker_task.cancel()
            try:
                await _worker_task
            except (asyncio.CancelledError, Exception):
                pass


app = FastAPI(title="Open Assistant local completions proxy", lifespan=lifespan)

# Requests come from server-side agent tools (no browser origin), so credentials
# aren't needed. `*` + credentials is spec-invalid anyway; keep origins open but
# drop credentials so the config is valid.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# Upstream routing / auth
# --------------------------------------------------------------------------- #

def upstream_url_for(base: str, path: str) -> str:
    """Reconstruct the upstream URL for an incoming request path.

    The configured ``upstream_url`` is treated as a base; we strip any endpoint
    and version suffix to get the API root, then re-append the exact path the
    client called. This makes the proxy transparent across chat/responses/
    messages endpoints for whichever provider the base points at.
    """
    base = (base or "").strip().rstrip("/")
    base = re.sub(r"/(chat/completions|responses|messages)$", "", base)
    base = re.sub(r"/(v1beta|v1)$", "", base)
    return base + path


def _build_upstream_headers(adapter, cfg: dict, incoming) -> dict:
    headers = {"Content-Type": "application/json"}
    key = cfg.get("upstream_key")
    if adapter.auth == "anthropic":
        headers["anthropic-version"] = incoming.get("anthropic-version") or "2023-06-01"
        if incoming.get("anthropic-beta"):
            headers["anthropic-beta"] = incoming["anthropic-beta"]
        if key:
            headers["x-api-key"] = key
        elif incoming.get("x-api-key"):
            headers["x-api-key"] = incoming["x-api-key"]
        elif incoming.get("authorization"):
            headers["Authorization"] = incoming["authorization"]
    else:
        if key:
            headers["Authorization"] = f"Bearer {key}"
        elif incoming.get("authorization"):
            headers["Authorization"] = incoming["authorization"]
    return headers


def _check_proxy_auth(request: Request, cfg: dict) -> None:
    proxy_api_key = cfg.get("proxy_api_key")
    if not proxy_api_key:
        return
    auth_header = request.headers.get("Authorization", "") or request.headers.get("x-api-key", "")
    provided = auth_header.removeprefix("Bearer ").strip()
    if provided != proxy_api_key:
        raise HTTPException(status_code=401, detail="Invalid proxy API key")


def _conversation_id(messages: list) -> str:
    """Stable id anchored on the first user+assistant exchange of a session.

    Both anchors are available from the very first turn — the assistant turn is
    the reply we just captured — and neither changes as the client replays the
    (growing) history on later turns, so the server upserts one row per
    conversation instead of accumulating one per turn.

    Anchoring on the first *exchange* rather than just the first user message
    means a collision would require two genuinely different conversations to
    share an identical opening prompt AND an identical first reply — practically
    impossible for agent traffic, whose first user turn already carries unique
    environment context (cwd, git state, timestamps). The system prompt is
    deliberately excluded from the anchor so a per-turn-changing system message
    (e.g. an embedded clock) can't fork the id mid-conversation.
    """
    first_user = next((m for m in messages if m.get("role") == "user"), None)
    first_assistant = next((m for m in messages if m.get("role") == "assistant"), None)
    parts = []
    if first_user is not None:
        parts.append("u:" + (first_user.get("content") or "")[:4000])
    if first_assistant is not None:
        parts.append("a:" + (first_assistant.get("content") or "")[:4000])
    if not parts:
        # Degenerate case (no user/assistant text, e.g. tool-only): fall back to
        # the whole first message so we still get a deterministic id.
        parts.append(json.dumps(messages[:1], sort_keys=True, default=str) if messages else "")
    seed = "\n".join(parts)
    return "pip-" + hashlib.sha256(seed.encode("utf-8", "ignore")).hexdigest()[:24]


# --------------------------------------------------------------------------- #
# Background upload worker
# --------------------------------------------------------------------------- #

def _enqueue(request_messages: list, assistant: dict, model: str) -> None:
    if _upload_queue is None:
        return
    try:
        _upload_queue.put_nowait((request_messages, assistant, model))
    except asyncio.QueueFull:
        stats["dropped"] += 1
        print("Upload queue full; dropping interaction.")


async def _upload_worker() -> None:
    while True:
        job = await _upload_queue.get()
        try:
            await _process_job(job)
        except Exception as e:
            print(f"Upload worker error: {e}")
        finally:
            _upload_queue.task_done()


async def _process_job(job) -> None:
    global classifier
    request_messages, assistant, model = job

    if not (assistant and (assistant.get("content") or assistant.get("tool_calls"))):
        return  # nothing meaningful to store

    if classifier is None:
        try:
            classifier = await asyncio.to_thread(load_classifier)
        except Exception as e:
            _record_upload(False, f"redactor unavailable: {e}")
            return

    full = list(request_messages) + [assistant]
    # Derived here (not at enqueue time) because the id anchors on the first
    # assistant reply, which only exists once the turn has completed.
    conversation_id = _conversation_id(full)

    try:
        # Redaction is CPU-bound model inference — run it off the event loop so
        # live proxied requests are never blocked.
        redacted = await asyncio.to_thread(
            redact_messages, full, classifier, True, _msg_cache
        )
    except Exception as e:
        _record_upload(False, f"redaction failed: {e}")
        return
    _trim_cache()

    await _upload_trace(redacted, model, conversation_id)


def _trim_cache() -> None:
    while len(_msg_cache) > MSG_CACHE_MAX:
        _msg_cache.popitem(last=False)


def _record_upload(ok: bool, detail: str) -> None:
    if ok:
        stats["uploads_ok"] += 1
    else:
        stats["uploads_failed"] += 1
    _recent_uploads.appendleft({"ok": ok, "detail": detail, "ts": time.time()})


async def _upload_trace(redacted_messages: list, model: str, conversation_id: str) -> None:
    cfg = load_config_cached()
    api_key = cfg.get("api_key")
    if not api_key:
        _record_upload(False, "no Open Assistant API key configured")
        print("Warning: No Open Assistant API Key configured. Redacted trace was NOT uploaded.")
        return

    server_url = cfg.get("server_url", "https://oa.laion.ai/").rstrip("/")
    ingest_path = cfg.get("ingest_path", "/proxy/api/ingest")
    upload_url = f"{server_url}{ingest_path}"
    payload = {
        "traces": [
            {
                "model": model,
                "platform": "pip-library",
                "conversation_id": conversation_id,
                "messages": redacted_messages,
            }
        ]
    }
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}

    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(upload_url, json=payload, headers=headers, timeout=15.0)
        if res.status_code == 200:
            _record_upload(True, f"{len(redacted_messages)} turns")
            print(f"Uploaded redacted trace to Open Assistant ({len(redacted_messages)} turns).")
        else:
            _record_upload(False, f"HTTP {res.status_code}: {res.text[:200]}")
            print(f"Failed to upload trace: {res.status_code}: {res.text}")
    except Exception as e:
        _record_upload(False, str(e))
        print(f"Error uploading trace to Open Assistant: {e}")


# --------------------------------------------------------------------------- #
# Proxy core (shared by every supported endpoint)
# --------------------------------------------------------------------------- #

def _process_sse_line(line: str, collector) -> None:
    line = line.strip()
    if not line.startswith("data:"):
        return
    payload = line[len("data:"):].strip()
    if not payload or payload == "[DONE]":
        return
    try:
        collector.feed(json.loads(payload))
    except Exception:
        pass


async def _proxy(request: Request, path: str):
    adapter = ADAPTERS[path]
    cfg = load_config_cached()
    _check_proxy_auth(request, cfg)

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    model = body.get("model", cfg.get("upstream_model", ""))
    upstream_url = upstream_url_for(cfg.get("upstream_url", ""), path)
    headers = _build_upstream_headers(adapter, cfg, request.headers)

    request_messages = adapter.normalize_request(body)

    if body.get("stream", False):
        collector = adapter.stream_collector()

        async def stream_generator():
            buffer = ""
            client = httpx.AsyncClient()
            try:
                async with client.stream("POST", upstream_url, json=body,
                                         headers=headers, timeout=STREAM_TIMEOUT) as response:
                    if response.status_code != 200:
                        yield await response.aread()
                        return
                    async for chunk in response.aiter_text():
                        yield chunk  # transparent passthrough to the client
                        # Reassemble SSE lines across chunk boundaries before parsing.
                        buffer += chunk
                        while "\n" in buffer:
                            line, buffer = buffer.split("\n", 1)
                            _process_sse_line(line, collector)
                    if buffer.strip():
                        _process_sse_line(buffer, collector)
            except Exception as e:
                print(f"Error proxying stream: {e}")
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
                return
            finally:
                await client.aclose()
            _enqueue(request_messages, collector.finish(), model)

        return StreamingResponse(stream_generator(), media_type="text/event-stream")

    # Non-streaming
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(upstream_url, json=body, headers=headers, timeout=NONSTREAM_TIMEOUT)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Upstream request failed: {e}")

    if response.status_code != 200:
        raise HTTPException(status_code=response.status_code, detail=response.text)

    data = response.json()
    _enqueue(request_messages, adapter.parse_response(data), model)
    return JSONResponse(content=data)


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    return await _proxy(request, "/v1/chat/completions")


@app.post("/v1beta/chat/completions")
async def chat_completions_v1beta(request: Request):
    return await _proxy(request, "/v1beta/chat/completions")


@app.post("/v1/responses")
async def responses(request: Request):
    return await _proxy(request, "/v1/responses")


@app.post("/v1/messages")
async def messages(request: Request):
    return await _proxy(request, "/v1/messages")


@app.get("/v1/models")
async def list_models(request: Request):
    cfg = load_config_cached()
    _check_proxy_auth(request, cfg)

    base_url = re.sub(r"/(chat/completions|responses|messages)$", "", (cfg.get("upstream_url") or "").rstrip("/"))
    models_url = base_url.rstrip("/") + "/models"

    headers = {}
    if cfg.get("upstream_key"):
        if "googleapis.com" in models_url:
            separator = "&" if "?" in models_url else "?"
            models_url = f"{models_url}{separator}key={cfg['upstream_key']}"
        else:
            headers["Authorization"] = f"Bearer {cfg['upstream_key']}"

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
                        openai_models.append({"id": name, "object": "model", "owned_by": "google"})
                return {"object": "list", "data": openai_models}
            return res_data
    except Exception:
        pass

    return {"object": "list", "data": [{"id": cfg["upstream_model"], "object": "model", "owned_by": "custom"}]}


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "queue_depth": _upload_queue.qsize() if _upload_queue else 0,
        "redactor_loaded": classifier is not None,
        "uploads_ok": stats["uploads_ok"],
        "uploads_failed": stats["uploads_failed"],
        "dropped": stats["dropped"],
    }


@app.post("/rotate-proxy-key")
async def do_rotate_proxy_key():
    return {"proxy_api_key": rotate_proxy_api_key()}


@app.post("/test-upstream")
async def test_upstream_direct():
    cfg = load_config_cached()
    upstream_url = upstream_url_for(cfg.get("upstream_url", ""), "/v1/chat/completions")
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


# --------------------------------------------------------------------------- #
# Status dashboard
# --------------------------------------------------------------------------- #

@app.get("/", response_class=HTMLResponse)
async def status_page():
    cfg = load_config()
    proxy_key = cfg.get("proxy_api_key") or ensure_proxy_api_key()
    api_key = cfg.get("api_key", "")
    redacted_key = "(set in the Open Assistant app)" if not api_key else f"{api_key[:4]}{'*' * max(0, len(api_key) - 4)}"
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
        f"<tr><td>{label}</td><td><code>{value}</code></td></tr>" for label, value in rows
    )
    port = cfg.get("port", 2048)
    host = cfg.get("host", "127.0.0.1")
    upstream_model = cfg.get("upstream_model", "")
    base_url = f"http://{host}:{port}/v1"
    queue_depth = _upload_queue.qsize() if _upload_queue else 0

    def _fmt_recent():
        if not _recent_uploads:
            return '<div class="hint">No uploads yet.</div>'
        items = []
        for r in list(_recent_uploads)[:8]:
            icon = "✓" if r["ok"] else "✗"
            cls = "ok" if r["ok"] else "err"
            when = time.strftime("%H:%M:%S", time.localtime(r["ts"]))
            items.append(f'<div class="recent-row {cls}"><span>{icon}</span> <span>{when}</span> <span>{r["detail"]}</span></div>')
        return "".join(items)

    endpoints = ["/v1/chat/completions", "/v1beta/chat/completions", "/v1/responses", "/v1/messages"]
    endpoints_html = " ".join(f"<code>{e}</code>" for e in endpoints)

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Open Assistant Proxy</title>
  {'<meta http-equiv="refresh" content="4">' if queue_depth else ''}
  <style>
    body {{ font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 16px; color: #1a1a1a; }}
    h1 {{ font-size: 1.4rem; margin-bottom: 4px; }}
    p.sub {{ color: #555; margin-top: 0; font-size: 0.9rem; }}
    table {{ border-collapse: collapse; width: 100%; margin-top: 24px; }}
    th, td {{ text-align: left; padding: 10px 12px; border-bottom: 1px solid #e5e5e5; font-size: 0.9rem; }}
    th {{ color: #555; font-weight: 600; }}
    code {{ background: #f3f3f3; padding: 2px 6px; border-radius: 4px; font-size: 0.85em; }}
    .badge {{ display: inline-block; color: #fff; font-size: 0.75rem; padding: 2px 8px; border-radius: 99px; vertical-align: middle; margin-left: 8px; }}
    .badge-running {{ background: #22c55e; }}
    .badge-busy {{ background: #f59e0b; }}
    .stats {{ display: flex; gap: 16px; margin-top: 28px; }}
    .stat {{ background: #f9f9f9; border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px 16px; flex: 1; text-align: center; }}
    .stat-num {{ font-size: 1.6rem; font-weight: 700; }}
    .stat-ok .stat-num {{ color: #22c55e; }}
    .stat-fail .stat-num {{ color: #ef4444; }}
    .stat-busy .stat-num {{ color: #f59e0b; }}
    .stat-label {{ font-size: 0.78rem; color: #666; margin-top: 2px; }}
    .endpoint-card {{ background: #f0f7ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 16px 20px; margin-top: 28px; }}
    .endpoint-card h2 {{ font-size: 0.95rem; font-weight: 700; margin: 0 0 12px 0; color: #1e40af; }}
    .endpoint-row {{ display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; font-size: 0.88rem; flex-wrap: wrap; }}
    .endpoint-row label {{ color: #555; min-width: 110px; flex-shrink: 0; }}
    .endpoint-row code {{ background: #dbeafe; color: #1e3a8a; word-break: break-all; }}
    .endpoint-card .hint {{ font-size: 0.78rem; color: #64748b; margin-top: 12px; border-top: 1px solid #bfdbfe; padding-top: 10px; }}
    .endpoint-card .hint code {{ background: #e0f2fe; }}
    .recent {{ margin-top: 24px; }}
    .recent h2 {{ font-size: 0.9rem; color: #555; }}
    .recent-row {{ font-size: 0.8rem; padding: 4px 0; display: flex; gap: 10px; border-bottom: 1px solid #f0f0f0; }}
    .recent-row.ok span:first-child {{ color: #22c55e; }}
    .recent-row.err span:first-child {{ color: #ef4444; }}
    .btn {{ display: inline-block; margin-top: 14px; padding: 7px 16px; background: #3b82f6; color: #fff; border: none; border-radius: 6px; font-size: 0.85rem; cursor: pointer; font-family: inherit; }}
    .btn:hover {{ background: #2563eb; }}
    .btn:disabled {{ background: #93c5fd; cursor: default; }}
    .btn-sm {{ display: inline-block; padding: 2px 9px; background: #e2e8f0; color: #334155; border: 1px solid #cbd5e1; border-radius: 5px; font-size: 0.78rem; cursor: pointer; font-family: inherit; margin-left: 6px; }}
    .btn-sm:hover {{ background: #cbd5e1; }}
    .test-result {{ margin-top: 10px; font-size: 0.82rem; padding: 8px 12px; border-radius: 6px; display: none; word-break: break-all; }}
    .test-result.ok {{ background: #dcfce7; color: #166534; border: 1px solid #86efac; }}
    .test-result.err {{ background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }}
  </style>
</head>
<body>
  <h1>Open Assistant Proxy
    <span class="badge badge-running">running</span>
    {'<span class="badge badge-busy">processing&hellip;</span>' if queue_depth else ''}
  </h1>
  <p class="sub">Captures & redacts: {endpoints_html}</p>

  <div class="endpoint-card">
    <h2>OpenAI-compatible endpoint settings</h2>
    <div class="endpoint-row"><label>Base URL</label><code>{base_url}</code></div>
    <div class="endpoint-row">
      <label>API Key</label>
      <code id="proxy-key-display">{proxy_key}</code>
      <button class="btn-sm" id="rotate-btn" onclick="rotateKey()" title="Generate a new proxy API key">&#x21bb; Rotate</button>
    </div>
    <div class="endpoint-row"><label>Model</label><code>{upstream_model}</code></div>
    <div class="hint">
      <strong>Claude Code:</strong>
      <code>claude --openai-base-url {base_url} --openai-api-key {proxy_key}</code><br><br>
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
    <div class="stat stat-ok"><div class="stat-num">{stats['uploads_ok']}</div><div class="stat-label">traces uploaded</div></div>
    <div class="stat stat-busy"><div class="stat-num">{queue_depth}</div><div class="stat-label">queued</div></div>
    <div class="stat stat-fail"><div class="stat-num">{stats['uploads_failed']}</div><div class="stat-label">upload failures</div></div>
  </div>

  <div class="recent">
    <h2>Recent uploads</h2>
    {_fmt_recent()}
  </div>

  <table>
    <thead><tr><th>Setting</th><th>Value</th></tr></thead>
    <tbody>{rows_html}</tbody>
  </table>
  <p style="margin-top:24px;font-size:0.8rem;color:#888;">Run <code>oa-proxy config</code> to change these settings.</p>
  <script>
    async function testEndpoint() {{
      const btn = document.getElementById('test-btn');
      const result = document.getElementById('test-result');
      btn.disabled = true; btn.textContent = 'Testing…'; result.style.display = 'none';
      try {{
        const res = await fetch('/v1/chat/completions', {{
          method: 'POST',
          headers: {{ 'Content-Type': 'application/json', 'Authorization': 'Bearer {proxy_key}' }},
          body: JSON.stringify({{ model: '{upstream_model}', messages: [{{ role: 'user', content: 'Reply with just the word PONG.' }}], max_tokens: 16, stream: false }})
        }});
        const data = await res.json();
        if (!res.ok) {{ throw new Error(data.detail || data.error?.message || 'HTTP ' + res.status); }}
        const text = data.choices?.[0]?.message?.content ?? JSON.stringify(data);
        result.className = 'test-result ok'; result.textContent = '✓ Upstream replied: ' + text.trim();
      }} catch (e) {{
        result.className = 'test-result err'; result.textContent = '✗ ' + e.message;
      }} finally {{ result.style.display = 'block'; btn.disabled = false; btn.textContent = 'Test endpoint through proxy'; }}
    }}
    async function testUpstream() {{
      const btn = document.getElementById('test-upstream-btn');
      const result = document.getElementById('test-upstream-result');
      btn.disabled = true; btn.textContent = 'Testing…'; result.style.display = 'none';
      try {{
        const res = await fetch('/test-upstream', {{ method: 'POST' }});
        const data = await res.json();
        if (data.ok) {{ result.className = 'test-result ok'; result.textContent = '✓ Upstream replied: ' + data.reply; }}
        else {{ result.className = 'test-result err'; result.textContent = '✗ ' + data.error; }}
      }} catch (e) {{
        result.className = 'test-result err'; result.textContent = '✗ ' + e.message;
      }} finally {{ result.style.display = 'block'; btn.disabled = false; btn.textContent = 'Test upstream directly'; }}
    }}
    async function rotateKey() {{
      if (!confirm('Generate a new proxy API key? You will need to update all clients that use the current key.')) return;
      const btn = document.getElementById('rotate-btn'); btn.disabled = true;
      try {{
        const res = await fetch('/rotate-proxy-key', {{ method: 'POST' }});
        const data = await res.json();
        document.getElementById('proxy-key-display').textContent = data.proxy_api_key;
      }} catch (e) {{ alert('Failed to rotate key: ' + e.message); }} finally {{ btn.disabled = false; }}
    }}
  </script>
</body>
</html>"""
    return HTMLResponse(content=html)
