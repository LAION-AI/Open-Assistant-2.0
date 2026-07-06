import re
import sys
import json
import hashlib
from typing import Any, Dict, List, MutableMapping, Optional
import torch
from transformers import pipeline
from huggingface_hub import snapshot_download

MODEL_ID = "openai/privacy-filter"

# --------------------------------------------------------------------------- #
# Secret scanning
#
# The NER model catches names/emails/phones but not machine secrets, which are
# exactly what coding agents leak (API keys, tokens, .env values, private keys).
# We run these deterministic patterns *before* the NER pass so the placeholders
# survive it.
# --------------------------------------------------------------------------- #

_SECRET_PLACEHOLDER = "[REDACTED_SECRET]"

# (pattern, mode) where mode is "whole" (replace whole match), "assign" (keep
# key + separator, replace the value) or "bearer" (keep the Bearer keyword).
_SECRET_PATTERNS = [
    (re.compile(
        r"(?im)\b([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|PWD|TOKEN|API[_-]?KEY|"
        r"ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?)[A-Z0-9_]*)(\s*[:=]\s*)"
        r"(\"[^\"]{4,}\"|'[^']{4,}'|[^\s,;}#]{6,})"), "assign"),
    (re.compile(
        r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----"), "whole"),
    (re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{20,}"), "whole"),
    (re.compile(r"\bsk-[A-Za-z0-9]{20,}"), "whole"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "whole"),
    (re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b"), "whole"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"), "whole"),
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"), "whole"),
    (re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"), "whole"),
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{20,}"), "bearer"),
]


def redact_secrets(text: str) -> str:
    if not text:
        return text

    def _assign(m: "re.Match") -> str:
        return f"{m.group(1)}{m.group(2)}{_SECRET_PLACEHOLDER}"

    for pat, mode in _SECRET_PATTERNS:
        if mode == "assign":
            text = pat.sub(_assign, text)
        elif mode == "bearer":
            text = pat.sub("Bearer " + _SECRET_PLACEHOLDER, text)
        else:
            text = pat.sub(_SECRET_PLACEHOLDER, text)
    return text


def _as_text(value: Any) -> str:
    """Coerce any content value to a string so it can be scanned safely."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)

def get_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"

def setup_model() -> None:
    """Downloads the redactor model showing tqdm progress bar."""
    print("Initializing Open Assistant on-device redactor model setup...")
    try:
        # snapshot_download uses tqdm under the hood to show progress bar;
        # ignore large ONNX and original weights that are not used by standard PyTorch
        snapshot_download(repo_id=MODEL_ID, ignore_patterns=["onnx/*", "original/*"])
        print("PI ready")
    except Exception as e:
        print(f"Error during model setup: {e}", file=sys.stderr)
        raise e

def load_classifier() -> Any:
    """Loads the Hugging Face token-classification pipeline on the fastest device."""
    device = get_device()
    print(f"Loading redactor model on device: {device}...")
    try:
        classifier = pipeline(
            "token-classification",
            model=MODEL_ID,
            device=device,
        )
        return classifier
    except Exception as e:
        # Fallback to CPU if device-specific loading fails
        if device != "cpu":
            print(f"Failed to load on {device}, falling back to cpu...", file=sys.stderr)
            return pipeline(
                "token-classification",
                model=MODEL_ID,
                device="cpu",
            )
        raise e

def placeholder_for(group: str) -> str:
    g = group or ""
    g = re.sub(r"^private[_-]?", "", g, flags=re.IGNORECASE)
    g = g.upper()
    g = re.sub(r"[^A-Z0-9]+", "_", g)
    return f"[REDACTED_{g or 'PII'}]"

def apply_redaction(text: str, entities: List[Dict[str, Any]]) -> str:
    if not text or not entities:
        return text
    
    # Sort entities in descending order by start offset to avoid offset shifting issues
    sorted_entities = sorted(entities, key=lambda e: e.get("start", 0), reverse=True)
    
    out = text
    last_start = float("inf")
    for e in sorted_entities:
        start = e.get("start")
        end = e.get("end")
        group = e.get("entity_group") or e.get("entity") or "PII"
        
        if start is None or end is None:
            continue
        if start >= end:
            continue
        if end > last_start:
            # Skip overlapping entities
            continue
            
        placeholder = placeholder_for(group)
        out = out[:start] + placeholder + out[end:]
        last_start = start
        
    return out

def chunk_text(text: str, max_len: int = 1500) -> List[str]:
    if len(text) <= max_len:
        return [text]
    chunks = []
    i = 0
    while i < len(text):
        end = min(i + max_len, len(text))
        if end < len(text):
            # Prefer line boundaries
            nl = text.rfind("\n", i, end)
            if nl > i + int(max_len * 0.5):
                end = nl + 1
        chunks.append(text[i:end])
        i = end
    return chunks

def redact_text(text: Any, classifier: Any, secret_scan: bool = True) -> str:
    text = _as_text(text)
    if not text or not text.strip():
        return text
    if secret_scan:
        text = redact_secrets(text)
    chunks = chunk_text(text)
    out = ""
    for chunk in chunks:
        try:
            entities = classifier(chunk, aggregation_strategy="simple")
        except Exception:
            entities = []
        out += apply_redaction(chunk, entities)
    return out


def _msg_fingerprint(m: Dict[str, Any]) -> str:
    key = {
        "role": m.get("role", ""),
        "content": _as_text(m.get("content")),
        "reasoning": _as_text(m.get("reasoning") or m.get("reasoning_content")),
        "tool_calls": m.get("tool_calls"),
        "tool_call_id": m.get("tool_call_id"),
    }
    return hashlib.sha256(
        json.dumps(key, sort_keys=True, ensure_ascii=True, default=str).encode()
    ).hexdigest()


def _redact_one(m: Dict[str, Any], classifier: Any, secret_scan: bool) -> Dict[str, Any]:
    """Redact a single normalized message, including tool-call arguments and
    tool results — not just the prose ``content`` field."""
    out: Dict[str, Any] = {"role": m.get("role", "user")}
    out["content"] = redact_text(m.get("content"), classifier, secret_scan)

    reasoning = m.get("reasoning") or m.get("reasoning_content")
    if reasoning:
        out["reasoning"] = redact_text(reasoning, classifier, secret_scan)

    if m.get("tool_calls"):
        redacted_calls = []
        for tc in m["tool_calls"]:
            if not isinstance(tc, dict):
                continue
            fn = tc.get("function") or {}
            redacted_calls.append({
                "id": tc.get("id", ""),
                "type": tc.get("type", "function"),
                "function": {
                    "name": fn.get("name", ""),
                    "arguments": redact_text(fn.get("arguments") or "", classifier, secret_scan),
                },
            })
        out["tool_calls"] = redacted_calls

    if m.get("tool_call_id"):
        out["tool_call_id"] = m["tool_call_id"]
    if m.get("name"):
        out["name"] = m["name"]
    return out


def redact_messages(
    messages: List[Dict[str, Any]],
    classifier: Any,
    secret_scan: bool = True,
    cache: Optional[MutableMapping[str, Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Redact every message in a conversation history.

    Redacts ``content``, ``reasoning``, tool-call ``arguments`` and tool
    results. When ``cache`` (a fingerprint -> redacted-message map) is supplied,
    unchanged prior turns are reused instead of being re-run through the model,
    so multi-turn threads only pay to redact the newest messages.
    """
    redacted = []
    for m in messages:
        if not isinstance(m, dict):
            continue
        if cache is not None:
            fp = _msg_fingerprint(m)
            hit = cache.get(fp)
            if hit is not None:
                redacted.append(hit)
                continue
            rm = _redact_one(m, classifier, secret_scan)
            cache[fp] = rm
            redacted.append(rm)
        else:
            redacted.append(_redact_one(m, classifier, secret_scan))
    return redacted
