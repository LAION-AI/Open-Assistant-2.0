import re
import sys
import json
import hashlib
from typing import Any, Dict, List, MutableMapping, Optional

# torch / transformers are imported lazily inside the loader functions: they
# take seconds to import and aren't needed until redaction actually runs, so
# the proxy starts fast and lightweight hosts can run (and test) everything
# except model inference without ML dependencies installed.

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
    import torch  # lazy: heavy import, only needed for inference

    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"

def setup_model() -> None:
    """Downloads the redactor model showing tqdm progress bar."""
    from huggingface_hub import snapshot_download  # lazy

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
    from transformers import pipeline  # lazy: heavy import

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


# --------------------------------------------------------------------------- #
# Raw wire-request redaction
#
# Uploads can carry the exact provider request (the "source envelope", see
# frontend/src/lib/unified.ts) so the capture is lossless and back-convertible
# to the wire format. That verbatim copy must be scrubbed with the same rigor
# as the normalized messages — otherwise redaction would be cosmetic.
# --------------------------------------------------------------------------- #

# String values under these keys are ids/enums/linkage that must survive
# unchanged for the reconstructed request to stay machine-readable. Unlike the
# web uploader, tool-call ``arguments`` are NOT exempt here: this proxy's
# policy (see _redact_one) is to redact tool arguments, and the raw copy has
# to match or it would leak what the normalized messages scrubbed.
_STRUCTURAL_KEYS = frozenset({
    "type", "role", "id", "uuid", "parentUuid", "leafUuid", "sessionId",
    "requestId", "tool_call_id", "tool_use_id", "call_id", "model",
    "timestamp", "version", "media_type", "mimeType", "kind", "format",
    "schema",
})

_BASE64ISH = re.compile(r"[A-Za-z0-9+/=_\-]{512,}")


def _skip_string(s: str) -> bool:
    """True for strings that can't contain prose PII (data URIs, base64 blobs)
    — NER on them is wasted work."""
    if len(s) < 3:
        return True
    if s.startswith("data:") and ";base64," in s[:96]:
        return True
    return len(s) >= 512 and bool(_BASE64ISH.fullmatch(s))


def redact_json_value(value: Any, classifier: Any, secret_scan: bool = True) -> Any:
    """Recursively redact every non-structural string in a JSON value, keeping
    the shape intact so the result re-serializes to a valid document."""
    if isinstance(value, str):
        return value if _skip_string(value) else redact_text(value, classifier, secret_scan)
    if isinstance(value, list):
        return [redact_json_value(v, classifier, secret_scan) for v in value]
    if isinstance(value, dict):
        return {
            k: v if isinstance(v, str) and k in _STRUCTURAL_KEYS
            else redact_json_value(v, classifier, secret_scan)
            for k, v in value.items()
        }
    return value


def _raw_fingerprint(value: Any) -> str:
    # "raw:" prefix keeps these entries distinct from normalized-message
    # fingerprints when both share one cache.
    return "raw:" + hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=True, default=str).encode()
    ).hexdigest()


def redact_wire_request(
    body: Dict[str, Any],
    classifier: Any,
    secret_scan: bool = True,
    cache: Optional[MutableMapping[str, Any]] = None,
) -> Any:
    """Deep-redact a raw provider request body (OpenAI chat/responses or
    Anthropic messages shape).

    Redaction units are fingerprint-cached like redact_messages: each element
    of ``messages``/``input`` and the whole ``system``/``instructions`` value.
    Agent clients replay the (growing) history plus a stable system prompt on
    every turn, so later turns only pay to redact the newest messages — the
    cache behavior that makes per-turn capture affordable.
    """
    if not isinstance(body, dict):
        return redact_json_value(body, classifier, secret_scan)

    def _cached(unit: Any) -> Any:
        if cache is None:
            return redact_json_value(unit, classifier, secret_scan)
        fp = _raw_fingerprint(unit)
        hit = cache.get(fp)
        if hit is not None:
            return hit
        r = redact_json_value(unit, classifier, secret_scan)
        cache[fp] = r
        return r

    out: Dict[str, Any] = {}
    for k, v in body.items():
        if k in ("messages", "input") and isinstance(v, list):
            out[k] = [_cached(item) for item in v]
        elif k in ("system", "instructions"):
            out[k] = _cached(v)
        elif isinstance(v, str) and k in _STRUCTURAL_KEYS:
            # Top-level structural params (model, …) — same exemption the
            # dict recursion applies.
            out[k] = v
        else:
            out[k] = redact_json_value(v, classifier, secret_scan)
    return out


def redact_source_text(
    text: str,
    kind: str,
    classifier: Any,
    secret_scan: bool = True,
    cache: Optional[MutableMapping[str, Any]] = None,
) -> str:
    """Redact a verbatim source envelope, parse-aware so the result stays a
    valid file of the same format: JSONL line-by-line (each line a cached
    redaction unit), JSON as one document. Unparseable lines fall back to
    plain-text redaction."""

    def _cached(unit: Any) -> Any:
        if cache is None:
            return redact_json_value(unit, classifier, secret_scan)
        fp = _raw_fingerprint(unit)
        hit = cache.get(fp)
        if hit is not None:
            return hit
        r = redact_json_value(unit, classifier, secret_scan)
        cache[fp] = r
        return r

    if kind == "json":
        try:
            return json.dumps(_cached(json.loads(text)), ensure_ascii=False)
        except Exception:
            return redact_text(text, classifier, secret_scan)

    lines = []
    for line in text.split("\n"):
        if not line.strip():
            lines.append(line)
            continue
        try:
            lines.append(json.dumps(_cached(json.loads(line)), ensure_ascii=False))
        except Exception:
            lines.append(redact_text(line, classifier, secret_scan))
    return "\n".join(lines)


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
