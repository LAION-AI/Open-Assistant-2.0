import re
import sys
from typing import Any, Dict, List
import torch
from transformers import pipeline
from huggingface_hub import snapshot_download

MODEL_ID = "openai/privacy-filter"

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

def redact_text(text: str, classifier: Any) -> str:
    if not text or not text.strip():
        return text
    chunks = chunk_text(text)
    out = ""
    for chunk in chunks:
        try:
            entities = classifier(chunk, aggregation_strategy="simple")
        except Exception:
            entities = []
        out += apply_redaction(chunk, entities)
    return out

def redact_messages(messages: List[Dict[str, Any]], classifier: Any) -> List[Dict[str, Any]]:
    """Redact content and reasoning fields of every message in a conversation history."""
    redacted = []
    for m in messages:
        role = m.get("role", "user")
        content = m.get("content") or ""
        reasoning = m.get("reasoning_content") or m.get("reasoning") or ""
        
        redacted_msg = {
            "role": role,
            "content": redact_text(content, classifier)
        }
        if reasoning:
            redacted_msg["reasoning_content"] = redact_text(reasoning, classifier)
            
        # Carry over extra fields like names
        for k, v in m.items():
            if k not in ["role", "content", "reasoning_content", "reasoning"]:
                redacted_msg[k] = v
                
        redacted.append(redacted_msg)
    return redacted
