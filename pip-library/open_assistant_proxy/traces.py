"""Parsers for locally saved agent sessions ("traces").

Turns session files from coding agents into the same normalized message shape
the live proxy captures (see adapters.py), plus a verbatim source envelope for
lossless back-conversion. Used by the ``oa-proxy upload`` CLI.

Supported on-disk formats (as found in the agents' home directories):
  * Claude Code      ~/.claude/projects/<slug>/<uuid>.jsonl
  * command-code     ~/.command-code/projects/<slug>/<uuid>.jsonl (flat lines)
  * OpenAI Codex     ~/.codex/sessions/**/rollout-*.jsonl
  * pi               ~/.pi/agent/sessions/<slug>/<ts>_<uuid>.jsonl
  * OpenAI-style     {"model": ..., "messages": [...]} JSON / JSON array
  * Crush            .crush/crush.db                (sqlite)
  * Hermes           ~/.hermes/state.db             (sqlite)
  * OpenCode         ~/.local/share/opencode/opencode.db (sqlite)

Kept stdlib-only (json/sqlite3/hashlib) so parsing never needs ML deps.
"""

import json
import hashlib
import shutil
import sqlite3
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .adapters import _stringify, _norm_tool_calls

MAX_TEXT_BYTES = 20 * 1024 * 1024
MAX_DB_BYTES = 500 * 1024 * 1024

# Directory noise we never descend into when walking a folder.
_SKIP_DIRS = {"node_modules", ".git", ".venv", "venv", "__pycache__", ".cache"}


def conversation_id(platform: str, key: str) -> str:
    """Deterministic id for an imported session, so re-uploading the same file
    upserts the existing row instead of duplicating it."""
    seed = f"{platform}:{key}"
    return "import-" + hashlib.sha256(seed.encode("utf-8", "ignore")).hexdigest()[:24]


def _title(messages: List[Dict[str, Any]], fallback: str) -> str:
    # Prefer the first "real" user prompt — skip injected context wrappers like
    # <environment_context> so titles are meaningful.
    first = next((m for m in messages
                  if m.get("role") == "user" and m.get("content")
                  and not m["content"].lstrip().startswith("<")), None)
    if first is None:
        first = next((m for m in messages if m.get("role") == "user" and m.get("content")), None)
    text = (first or {}).get("content") or fallback
    return " ".join(text.split())[:80] or fallback


def _finish(platform: str, model: str, conv_key: str, messages: List[Dict[str, Any]],
            source: Optional[Dict[str, str]], name: str) -> Optional[Dict[str, Any]]:
    kept = [m for m in messages
            if m.get("role") == "tool"
            or (m.get("role") in ("system", "user", "assistant")
                and (m.get("content") or m.get("tool_calls") or m.get("reasoning")))]
    if not any(m.get("role") in ("user", "assistant") for m in kept):
        return None
    trace: Dict[str, Any] = {
        "platform": platform,
        "model": model or "",
        "conversation_id": conversation_id(platform, conv_key),
        "title": _title(kept, name),
        "messages": kept,
        "turns": sum(1 for m in kept if m.get("role") == "user"),
        "file": name,
    }
    if source:
        trace["source"] = source
    return trace


# --------------------------------------------------------------------------- #
# Content-block flattening (shared by the JSONL message formats)
# --------------------------------------------------------------------------- #

def _flatten_blocks(content: Any) -> Tuple[str, str, List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Return (text, reasoning, tool_calls, tool_result_messages) from a content
    value. Handles the block vocabularies of Claude Code (tool_use/tool_result),
    command-code (tool-call/tool-result) and pi (toolCall + toolResult roles)."""
    if content is None:
        return "", "", [], []
    if isinstance(content, str):
        return content, "", [], []
    text: List[str] = []
    reasoning: List[str] = []
    tools: List[Dict[str, Any]] = []
    results: List[Dict[str, Any]] = []
    for b in content if isinstance(content, list) else [content]:
        if not isinstance(b, dict):
            text.append(str(b))
            continue
        bt = b.get("type")
        if bt in ("text", "input_text", "output_text"):
            if b.get("text"):
                text.append(b["text"])
        elif bt == "thinking":
            if b.get("thinking"):
                reasoning.append(b["thinking"])
        elif bt in ("tool_use", "tool_call", "toolCall", "tool-call"):
            args = b.get("input") if "input" in b else b.get("arguments")
            tools.append({
                "id": b.get("id") or b.get("toolCallId") or "",
                "type": "function",
                "function": {"name": b.get("name") or b.get("toolName") or "tool",
                             "arguments": _stringify(args)},
            })
        elif bt in ("tool_result", "tool-result", "toolResult"):
            out = b.get("content")
            if out is None:
                out = b.get("output")
            if isinstance(out, dict) and "value" in out:  # command-code: {type, value}
                out = out.get("value")
            tm: Dict[str, Any] = {"role": "tool", "content": _stringify(out)}
            cid = b.get("tool_use_id") or b.get("toolCallId") or b.get("tool_call_id") or ""
            if cid:
                tm["tool_call_id"] = cid
            if b.get("toolName") or b.get("name"):
                tm["name"] = b.get("toolName") or b.get("name")
            results.append(tm)
        elif bt in ("image", "image_url", "input_image"):
            text.append("[image omitted]")
    return "\n".join(text), "\n".join(reasoning), tools, results


def _message_from(role: str, content: Any, extra: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """One raw message -> normalized message(s); inline tool results split out."""
    text, reasoning, tools, results = _flatten_blocks(content)
    out: List[Dict[str, Any]] = []
    if role in ("toolResult", "tool") and not results:
        # pi tool results are whole messages (role=toolResult) rather than blocks.
        tm: Dict[str, Any] = {"role": "tool", "content": text}
        for src_key, dst_key in (("toolCallId", "tool_call_id"), ("tool_call_id", "tool_call_id"),
                                 ("toolName", "name"), ("name", "name")):
            v = (extra or {}).get(src_key)
            if v and dst_key not in tm:
                tm[dst_key] = v
        return [tm]
    if text or reasoning or tools:
        nm: Dict[str, Any] = {"role": role, "content": text}
        if reasoning:
            nm["reasoning"] = reasoning
        if tools:
            nm["tool_calls"] = tools
        out.append(nm)
    out.extend(results)
    return out


# --------------------------------------------------------------------------- #
# JSONL / JSON text formats
# --------------------------------------------------------------------------- #

def _jsonl(text: str):
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except Exception:
            continue


def parse_message_jsonl(text: str, name: str, platform: str) -> List[Dict[str, Any]]:
    """Claude Code / command-code style: one record per line, the message either
    nested under `message` (Claude Code) or flat `role`/`content` (command-code)."""
    messages: List[Dict[str, Any]] = []
    model = ""
    conv_key = name
    for obj in _jsonl(text):
        if not isinstance(obj, dict):
            continue
        if isinstance(obj.get("sessionId"), str):
            conv_key = obj["sessionId"]
        msg = obj.get("message") if isinstance(obj.get("message"), dict) else obj
        if not model and isinstance(msg.get("model"), str):
            model = msg["model"]
        role = msg.get("role")
        if not isinstance(role, str) or "content" not in msg:
            continue
        messages.extend(_message_from(role, msg.get("content"), msg))
    source = {"format": platform, "kind": "jsonl", "name": Path(name).name, "text": text}
    trace = _finish(platform, model, conv_key, messages, source, Path(name).name)
    return [trace] if trace else []


def parse_codex(text: str, name: str) -> List[Dict[str, Any]]:
    """OpenAI Codex CLI rollout: `response_item` lines carry the conversation."""
    messages: List[Dict[str, Any]] = []
    model = ""
    conv_key = Path(name).name
    pending_reasoning: List[str] = []
    for obj in _jsonl(text):
        if not isinstance(obj, dict):
            continue
        p = obj.get("payload") or {}
        if obj.get("type") == "session_meta" and isinstance(p.get("id"), str):
            conv_key = p["id"]
        if obj.get("type") == "turn_context" and p.get("model") and not model:
            model = p["model"]
        if obj.get("type") != "response_item" or not isinstance(p, dict):
            continue
        typ = p.get("type")
        if typ == "message":
            role = "system" if p.get("role") == "developer" else p.get("role")
            if role not in ("user", "assistant", "system"):
                continue
            text_parts = [c.get("text") for c in (p.get("content") or [])
                          if isinstance(c, dict) and c.get("text")]
            nm: Dict[str, Any] = {"role": role, "content": "\n".join(text_parts)}
            if role == "assistant" and pending_reasoning:
                nm["reasoning"] = "\n".join(pending_reasoning)
                pending_reasoning.clear()
            messages.append(nm)
        elif typ == "reasoning":
            for s in p.get("summary") or []:
                if isinstance(s, dict) and s.get("text"):
                    pending_reasoning.append(s["text"])
        elif typ in ("function_call", "custom_tool_call"):
            args = p.get("arguments") if typ == "function_call" else p.get("input")
            nm = {"role": "assistant", "content": "", "tool_calls": [{
                "id": p.get("call_id") or p.get("id") or "",
                "type": "function",
                "function": {"name": p.get("name") or "tool", "arguments": _stringify(args)},
            }]}
            if pending_reasoning:
                nm["reasoning"] = "\n".join(pending_reasoning)
                pending_reasoning.clear()
            messages.append(nm)
        elif typ in ("function_call_output", "custom_tool_call_output"):
            messages.append({"role": "tool", "tool_call_id": p.get("call_id") or "",
                             "content": _stringify(p.get("output"))})
    source = {"format": "codex", "kind": "jsonl", "name": Path(name).name, "text": text}
    trace = _finish("codex", model, conv_key, messages, source, Path(name).name)
    return [trace] if trace else []


def parse_pi(text: str, name: str) -> List[Dict[str, Any]]:
    """pi agent sessions: session/model_change/message lines; tool results are
    whole messages with role=toolResult."""
    messages: List[Dict[str, Any]] = []
    model = ""
    conv_key = Path(name).name
    for obj in _jsonl(text):
        if not isinstance(obj, dict):
            continue
        typ = obj.get("type")
        if typ == "session" and isinstance(obj.get("id"), str):
            conv_key = obj["id"]
        elif typ == "model_change" and obj.get("modelId") and not model:
            model = obj["modelId"]
        elif typ == "message" and isinstance(obj.get("message"), dict):
            msg = obj["message"]
            role = msg.get("role")
            if isinstance(role, str):
                messages.extend(_message_from(role, msg.get("content"), msg))
    source = {"format": "pi", "kind": "jsonl", "name": Path(name).name, "text": text}
    trace = _finish("pi", model, conv_key, messages, source, Path(name).name)
    return [trace] if trace else []


def parse_openai_json(doc: Any, text: str, name: str) -> List[Dict[str, Any]]:
    """{"model", "messages": [...]} documents or bare message arrays."""
    raw = doc.get("messages") if isinstance(doc, dict) else doc
    if not isinstance(raw, list):
        return []
    messages: List[Dict[str, Any]] = []
    for m in raw:
        if not isinstance(m, dict):
            continue
        msg = m.get("message") if isinstance(m.get("message"), dict) else m
        if isinstance(msg.get("role"), str) and "content" in msg:
            messages.extend(_message_from(msg["role"], msg.get("content"), msg))
    model = doc.get("model", "") if isinstance(doc, dict) else ""
    source = {"format": "trace", "kind": "json", "name": Path(name).name, "text": text}
    trace = _finish("trace", model, name, messages, source, Path(name).name)
    return [trace] if trace else []


def detect_format(path: str, text: str) -> str:
    p = path.lower()
    if "command-code" in p or "command_code" in p:
        return "command-code"
    if ".claude" in p or "claude-code" in p or "claude_code" in p or "claude-pods" in p:
        return "claude-code"
    if ".codex" in p or "/rollout-" in p or Path(p).name.startswith("rollout-"):
        return "codex"
    if "/agent/sessions/" in p or "pi-pods" in p or "/.pi/" in p:
        return "pi"
    # Content sniffing.
    head = text[:4000]
    if '"type":"response_item"' in head.replace(" ", "") or '"turn_context"' in head or '"session_meta"' in head:
        return "codex"
    if '"thinking_level_change"' in head or ('"type":"session"' in head.replace(" ", "") and '"cwd"' in head):
        return "pi"
    if '"sessionId"' in head and '"message"' in head:
        return "claude-code"
    if '"sessionId"' in head and '"role"' in head:
        return "command-code"
    return "trace"


def parse_text_file(path: str, text: str) -> List[Dict[str, Any]]:
    fmt = detect_format(path, text)
    if fmt == "codex":
        return parse_codex(text, path)
    if fmt == "pi":
        return parse_pi(text, path)
    trimmed = text.strip()
    if trimmed.startswith(("{", "[")):
        try:
            doc = json.loads(trimmed)
        except Exception:
            doc = None
        if isinstance(doc, dict) and isinstance(doc.get("messages"), list):
            return parse_openai_json(doc, text, path)
        if isinstance(doc, list):
            return parse_openai_json(doc, text, path)
    return parse_message_jsonl(text, path, fmt if fmt != "trace" else "trace")


# --------------------------------------------------------------------------- #
# SQLite formats (Crush / Hermes / OpenCode)
# --------------------------------------------------------------------------- #

def _sqlite_rows(db: sqlite3.Connection, sql: str, args=()) -> List[Dict[str, Any]]:
    db.row_factory = sqlite3.Row
    return [dict(r) for r in db.execute(sql, args).fetchall()]


def _parse_crush(db: sqlite3.Connection) -> List[Dict[str, Any]]:
    traces = []
    for s in _sqlite_rows(db, "SELECT id, title FROM sessions ORDER BY created_at"):
        rows = _sqlite_rows(db, "SELECT id, role, parts, model FROM messages "
                                "WHERE session_id = ? ORDER BY created_at", (s["id"],))
        messages: List[Dict[str, Any]] = []
        model = ""
        source_lines = [json.dumps({"table": "session", "row": s})]
        for r in rows:
            try:
                parts = json.loads(r["parts"])
            except Exception:
                parts = []
            source_lines.append(json.dumps({"table": "message", "id": r["id"],
                                            "role": r["role"], "model": r["model"], "parts": parts}))
            if not model and r["model"]:
                model = r["model"]
            text, reasoning, tools, results = [], [], [], []
            for part in parts if isinstance(parts, list) else []:
                d = part.get("data") or {} if isinstance(part, dict) else {}
                pt = part.get("type") if isinstance(part, dict) else None
                if pt == "text" and d.get("text"):
                    text.append(d["text"])
                elif pt == "reasoning" and d.get("thinking"):
                    reasoning.append(d["thinking"])
                elif pt == "tool_call":
                    tools.append({"id": d.get("id") or "", "type": "function",
                                  "function": {"name": d.get("name") or "tool",
                                               "arguments": _stringify(d.get("input"))}})
                elif pt == "tool_result":
                    tm = {"role": "tool", "content": _stringify(d.get("content"))}
                    if d.get("tool_call_id"):
                        tm["tool_call_id"] = d["tool_call_id"]
                    if d.get("name"):
                        tm["name"] = d["name"]
                    results.append(tm)
            if text or reasoning or tools:
                nm: Dict[str, Any] = {"role": r["role"], "content": "\n".join(text)}
                if reasoning:
                    nm["reasoning"] = "\n".join(reasoning)
                if tools:
                    nm["tool_calls"] = tools
                messages.append(nm)
            messages.extend(results)
        source = {"format": "crush", "kind": "jsonl", "name": f"{s['id']}.jsonl",
                  "text": "\n".join(source_lines)}
        trace = _finish("crush", model, s["id"], messages, source, s["id"])
        if trace:
            if s.get("title"):
                trace["title"] = " ".join(s["title"].split())[:80]
            traces.append(trace)
    return traces


def _parse_hermes(db: sqlite3.Connection) -> List[Dict[str, Any]]:
    traces = []
    for s in _sqlite_rows(db, "SELECT id, model, title FROM sessions ORDER BY started_at"):
        rows = _sqlite_rows(db, "SELECT id, role, content, tool_call_id, tool_calls, tool_name, "
                                "reasoning, reasoning_content FROM messages "
                                "WHERE session_id = ? ORDER BY id", (s["id"],))
        messages: List[Dict[str, Any]] = []
        source_lines = [json.dumps({"table": "session", "row": s})]
        for r in rows:
            source_lines.append(json.dumps({"table": "message", "row": r}))
            role = r["role"]
            if role in ("toolResult", "tool_response"):
                role = "tool"
            if role not in ("system", "user", "assistant", "tool"):
                continue
            nm: Dict[str, Any] = {"role": role, "content": r["content"] or ""}
            reasoning = r["reasoning_content"] or r["reasoning"]
            if reasoning:
                nm["reasoning"] = reasoning
            if r["tool_calls"]:
                try:
                    nm["tool_calls"] = _norm_tool_calls(json.loads(r["tool_calls"]))
                except Exception:
                    pass
            if role == "tool":
                if r["tool_call_id"]:
                    nm["tool_call_id"] = r["tool_call_id"]
                if r["tool_name"]:
                    nm["name"] = r["tool_name"]
            messages.append(nm)
        source = {"format": "hermes", "kind": "jsonl", "name": f"{s['id']}.jsonl",
                  "text": "\n".join(source_lines)}
        trace = _finish("hermes", s.get("model") or "", s["id"], messages, source, s["id"])
        if trace:
            if s.get("title"):
                trace["title"] = " ".join(s["title"].split())[:80]
            traces.append(trace)
    return traces


def _parse_opencode(db: sqlite3.Connection) -> List[Dict[str, Any]]:
    traces = []
    for s in _sqlite_rows(db, "SELECT id, title, model FROM session"):
        rows = _sqlite_rows(db, "SELECT id, data FROM message WHERE session_id = ? "
                                "ORDER BY time_created", (s["id"],))
        messages: List[Dict[str, Any]] = []
        source_lines = [json.dumps({"table": "session", "row": s})]
        for r in rows:
            try:
                md = json.loads(r["data"])
            except Exception:
                md = {}
            part_rows = _sqlite_rows(db, "SELECT data FROM part WHERE message_id = ? "
                                         "ORDER BY time_created", (r["id"],))
            parts = []
            for pr in part_rows:
                try:
                    parts.append(json.loads(pr["data"]))
                except Exception:
                    parts.append({"raw": pr["data"]})
            source_lines.append(json.dumps({"table": "message", "id": r["id"],
                                            "data": md, "parts": parts}))
            text, reasoning, tools = [], [], []
            for pd in parts:
                if not isinstance(pd, dict):
                    continue
                if pd.get("type") == "text" and pd.get("text"):
                    text.append(pd["text"])
                elif pd.get("type") == "reasoning" and pd.get("text"):
                    reasoning.append(pd["text"])
                elif pd.get("type") == "tool":
                    tools.append({"id": pd.get("callID") or "", "type": "function",
                                  "function": {"name": pd.get("tool") or "tool",
                                               "arguments": _stringify((pd.get("state") or {}).get("input"))}})
            if text or reasoning or tools:
                nm: Dict[str, Any] = {"role": md.get("role", "user"), "content": "\n".join(text)}
                if reasoning:
                    nm["reasoning"] = "\n".join(reasoning)
                if tools:
                    nm["tool_calls"] = tools
                messages.append(nm)
        model = ""
        try:
            model = json.loads(s.get("model") or "{}").get("id") or ""
        except Exception:
            pass
        source = {"format": "opencode", "kind": "jsonl", "name": f"{s['id']}.jsonl",
                  "text": "\n".join(source_lines)}
        trace = _finish("opencode", model, s["id"], messages, source, s["id"])
        if trace:
            if s.get("title"):
                trace["title"] = " ".join(s["title"].split())[:80]
            traces.append(trace)
    return traces


def parse_sqlite_file(path: str) -> List[Dict[str, Any]]:
    """Detect and parse a Crush / Hermes / OpenCode database. Works on a temp
    copy (with WAL sidecars) so live/mounted databases open safely."""
    src = Path(path)
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / src.name
        shutil.copy2(src, work)
        for ext in ("-wal", "-shm"):
            side = Path(str(src) + ext)
            if side.exists():
                shutil.copy2(side, str(work) + ext)
        db = sqlite3.connect(work)
        try:
            tables = {r[0] for r in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
            if {"session", "message", "part"} <= tables:
                return _parse_opencode(db)
            if "messages" in tables and "sessions" in tables:
                cols = {r[1] for r in db.execute("PRAGMA table_info(messages)").fetchall()}
                if "parts" in cols:
                    return _parse_crush(db)
                if "tool_calls" in cols:
                    return _parse_hermes(db)
            return []
        finally:
            db.close()


# --------------------------------------------------------------------------- #
# Collection
# --------------------------------------------------------------------------- #

def _iter_files(paths: List[str]):
    for p in paths:
        root = Path(p).expanduser()
        if root.is_file():
            yield root
        elif root.is_dir():
            for f in sorted(root.rglob("*")):
                if f.is_file() and not any(part in _SKIP_DIRS for part in f.parts):
                    yield f


def collect_traces(paths: List[str]) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Walk files/folders and parse everything that looks like an agent trace.
    Returns (traces, notes) where notes lists skipped/unreadable candidates."""
    traces: List[Dict[str, Any]] = []
    notes: List[str] = []
    for f in _iter_files(paths):
        suffix = f.suffix.lower()
        try:
            if suffix in (".jsonl", ".ndjson", ".json"):
                if f.stat().st_size > MAX_TEXT_BYTES:
                    notes.append(f"skipped (too large): {f}")
                    continue
                found = parse_text_file(str(f), f.read_text(encoding="utf-8", errors="ignore"))
            elif suffix in (".db", ".sqlite", ".sqlite3"):
                if f.stat().st_size > MAX_DB_BYTES:
                    notes.append(f"skipped (too large): {f}")
                    continue
                found = parse_sqlite_file(str(f))
            else:
                continue
        except Exception as e:
            notes.append(f"unreadable ({e.__class__.__name__}): {f}")
            continue
        traces.extend(found)
    return traces, notes
