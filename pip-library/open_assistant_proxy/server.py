import json
import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import StreamingResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from .config import load_config
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

@app.on_event("startup")
def startup_event():
    global classifier
    try:
        classifier = load_classifier()
        print("On-device PII redactor loaded successfully.")
    except Exception as e:
        print(f"Warning: Could not load redactor model on startup. It will load lazily later: {e}")

@app.get("/", response_class=HTMLResponse)
async def status_page():
    cfg = load_config()
    api_key = cfg.get("api_key", "")
    redacted_key = "(set in the Open Assistant app)" if not api_key else f"{api_key[:4]}{'*' * (len(api_key) - 4)}"
    rows = [
        ("Open Assistant Server URL", cfg.get("server_url", "")),
        ("Open Assistant API Key", redacted_key),
        ("Upstream API Base URL", cfg.get("upstream_url", "")),
        ("Upstream Default Model", cfg.get("upstream_model", "")),
        ("Upstream API Key", "***" if cfg.get("upstream_key") else "(not set)"),
        ("Local Proxy Port", str(cfg.get("port", 2048))),
    ]
    rows_html = "".join(
        f"<tr><td>{label}</td><td><code>{value}</code></td></tr>"
        for label, value in rows
    )
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
    code {{ background: #f3f3f3; padding: 2px 6px; border-radius: 4px; }}
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
  </style>
</head>
<body>
  <h1>Open Assistant Proxy
    <span class="badge badge-running">running</span>
    {redacting_badge}
  </h1>
  <p class="sub">OpenAI-compatible endpoint: <code>/v1/chat/completions</code></p>
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
            
    # Reconstruct the conversation history
    history = []
    for m in prompt_messages:
        history.append({
            "role": m.get("role", "user"),
            "content": m.get("content") or "",
            "reasoning_content": m.get("reasoning_content") or m.get("reasoning") or ""
        })
    if assistant_response:
        history.append({
            "role": "assistant",
            "content": assistant_response,
        })
        
    # Redact PII on-device
    stats["redacting"] += 1
    try:
        redacted_messages = redact_messages(history, classifier)
    except Exception as e:
        print(f"PII Redaction failed: {e}")
        stats["redacting"] -= 1
        return
    finally:
        stats["redacting"] = max(0, stats["redacting"] - 1)
        
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
                "messages": redacted_messages
            }
        ]
    }
    
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}"
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
            # Upload trace asynchronously after streaming finishes
            await upload_interaction(messages, assistant_response, model_requested)
            
        return StreamingResponse(stream_generator(), media_type="text/event-stream")
    else:
        try:
            async with client:
                response = await client.post(upstream_url, json=body, headers=headers, timeout=60.0)
                if response.status_code != 200:
                    raise HTTPException(status_code=response.status_code, detail=response.text)
                
                res_data = response.json()
                assistant_response = res_data.get("choices", [{}])[0].get("message", {}).get("content", "")
                await upload_interaction(messages, assistant_response, model_requested)
                return res_data
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

@app.get("/v1/models")
async def list_models():
    global config
    config = load_config()
    
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
