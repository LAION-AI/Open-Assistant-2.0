import json
import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import StreamingResponse
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

@app.on_event("startup")
def startup_event():
    global classifier
    try:
        classifier = load_classifier()
        print("On-device PII redactor loaded successfully.")
    except Exception as e:
        print(f"Warning: Could not load redactor model on startup. It will load lazily later: {e}")

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
    try:
        redacted_messages = redact_messages(history, classifier)
    except Exception as e:
        print(f"PII Redaction failed: {e}")
        return
        
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
                print(f"Successfully uploaded redacted trace to Open Assistant ({len(redacted_messages)} turns).")
            else:
                print(f"Failed to upload trace: Server responded with status {res.status_code}: {res.text}")
    except Exception as e:
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
