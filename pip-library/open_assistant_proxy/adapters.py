"""Adapters that normalize the different OpenAI/Anthropic-style chat APIs into a
single trace representation, so the proxy can capture, redact and upload any of
them uniformly.

Supported wire formats:
  * OpenAI Chat Completions  (/v1/chat/completions, /v1beta/chat/completions)
  * OpenAI Responses         (/v1/responses)
  * Anthropic Messages       (/v1/messages)

Every adapter turns both the request and the model's reply into the same
normalized message shape (a superset the Open Assistant upload endpoint
understands):

    {
        "role": "system" | "user" | "assistant" | "tool",
        "content": str,                 # always a plain string
        "reasoning": str,               # optional
        "tool_calls": [                 # optional, OpenAI function-call shape
            {"id": str, "type": "function",
             "function": {"name": str, "arguments": str}}
        ],
        "tool_call_id": str,            # optional (tool results)
        "name": str,                    # optional
    }

Streaming and non-streaming responses both collapse to a single normalized
assistant message.
"""

import json
from typing import Any, Dict, List


# --------------------------------------------------------------------------- #
# Shared helpers
# --------------------------------------------------------------------------- #

def _stringify(value: Any) -> str:
    """Best-effort flatten of arbitrary content (string / block list / dict)."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for x in value:
            if isinstance(x, dict):
                if x.get("type") in ("text", "input_text", "output_text") and "text" in x:
                    parts.append(x.get("text") or "")
                elif x.get("type") == "thinking":
                    parts.append(x.get("thinking") or "")
                else:
                    parts.append(json.dumps(x, ensure_ascii=False))
            else:
                parts.append(str(x))
        return "\n".join(p for p in parts if p)
    if isinstance(value, dict):
        if value.get("type") in ("text", "input_text", "output_text"):
            return value.get("text") or ""
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _text_and_images(content: Any):
    """Return (text, [image_refs]) from an OpenAI-style content value.

    Image payloads are captured only as references; raw base64 pixel data is
    never carried into the trace (it can't be PII-scanned and bloats uploads).
    """
    if content is None:
        return "", []
    if isinstance(content, str):
        return content, []
    if isinstance(content, list):
        parts, images = [], []
        for p in content:
            if not isinstance(p, dict):
                parts.append(str(p))
                continue
            t = p.get("type")
            if t in ("text", "input_text", "output_text") and "text" in p:
                parts.append(p.get("text") or "")
            elif t in ("image_url", "input_image", "image"):
                images.append(True)
            else:
                parts.append(_stringify(p))
        text = "\n".join(p for p in parts if p)
        if images:
            note = f"[{len(images)} image(s) omitted]"
            text = (text + "\n" + note).strip() if text else note
        return text, images
    return _stringify(content), []


def _norm_tool_calls(tool_calls: Any) -> List[Dict[str, Any]]:
    """Coerce OpenAI tool_calls into the canonical {id,type,function} shape."""
    out = []
    for tc in tool_calls or []:
        if not isinstance(tc, dict):
            continue
        fn = tc.get("function") or {}
        args = fn.get("arguments")
        if not isinstance(args, str):
            args = json.dumps(args, ensure_ascii=False) if args is not None else ""
        out.append({
            "id": tc.get("id", "") or "",
            "type": tc.get("type", "function") or "function",
            "function": {"name": fn.get("name", "") or "", "arguments": args},
        })
    return out


def _assistant(content: str, reasoning: str = "", tool_calls=None) -> Dict[str, Any]:
    msg: Dict[str, Any] = {"role": "assistant", "content": content or ""}
    if reasoning:
        msg["reasoning"] = reasoning
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return msg


# --------------------------------------------------------------------------- #
# OpenAI Chat Completions
# --------------------------------------------------------------------------- #

class ChatCompletionsAdapter:
    name = "chat"
    auth = "bearer"

    def normalize_request(self, body: Dict[str, Any]) -> List[Dict[str, Any]]:
        out = []
        for m in body.get("messages") or []:
            if not isinstance(m, dict):
                continue
            text, _ = _text_and_images(m.get("content"))
            nm: Dict[str, Any] = {"role": m.get("role", "user"), "content": text}
            reasoning = m.get("reasoning_content") or m.get("reasoning")
            if reasoning:
                nm["reasoning"] = reasoning
            if m.get("tool_calls"):
                nm["tool_calls"] = _norm_tool_calls(m["tool_calls"])
            if m.get("tool_call_id"):
                nm["tool_call_id"] = m["tool_call_id"]
            if m.get("name"):
                nm["name"] = m["name"]
            out.append(nm)
        return out

    def parse_response(self, data: Dict[str, Any]) -> Dict[str, Any]:
        choices = data.get("choices") or [{}]
        msg = (choices[0] or {}).get("message", {}) or {}
        text, _ = _text_and_images(msg.get("content"))
        reasoning = msg.get("reasoning_content") or msg.get("reasoning") or ""
        tool_calls = _norm_tool_calls(msg.get("tool_calls")) if msg.get("tool_calls") else None
        return _assistant(text, reasoning, tool_calls)

    def stream_collector(self):
        return _ChatStreamCollector()


class _ChatStreamCollector:
    def __init__(self):
        self.content, self.reasoning = [], []
        self.tools: Dict[int, Dict[str, Any]] = {}
        self.order: List[int] = []

    def feed(self, data: Dict[str, Any]) -> None:
        for ch in data.get("choices") or []:
            delta = (ch or {}).get("delta") or {}
            if delta.get("content"):
                self.content.append(delta["content"])
            r = delta.get("reasoning_content") or delta.get("reasoning")
            if r:
                self.reasoning.append(r)
            for tc in delta.get("tool_calls") or []:
                idx = tc.get("index", 0)
                a = self.tools.get(idx)
                if a is None:
                    a = {"id": "", "type": "function", "name": "", "args": []}
                    self.tools[idx] = a
                    self.order.append(idx)
                if tc.get("id"):
                    a["id"] = tc["id"]
                if tc.get("type"):
                    a["type"] = tc["type"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    a["name"] = fn["name"]
                if fn.get("arguments"):
                    a["args"].append(fn["arguments"])

    def finish(self) -> Dict[str, Any]:
        tool_calls = [
            {"id": self.tools[i]["id"], "type": self.tools[i]["type"] or "function",
             "function": {"name": self.tools[i]["name"], "arguments": "".join(self.tools[i]["args"])}}
            for i in self.order
        ] or None
        return _assistant("".join(self.content), "".join(self.reasoning), tool_calls)


# --------------------------------------------------------------------------- #
# OpenAI Responses API
# --------------------------------------------------------------------------- #

class ResponsesAdapter:
    name = "responses"
    auth = "bearer"

    def normalize_request(self, body: Dict[str, Any]) -> List[Dict[str, Any]]:
        out = []
        instr = body.get("instructions")
        if instr:
            out.append({"role": "system", "content": _stringify(instr)})
        inp = body.get("input")
        if isinstance(inp, str):
            out.append({"role": "user", "content": inp})
        elif isinstance(inp, list):
            for item in inp:
                if not isinstance(item, dict):
                    out.append({"role": "user", "content": str(item)})
                    continue
                typ = item.get("type", "message")
                if typ == "message" or "role" in item:
                    text, _ = _text_and_images(item.get("content"))
                    out.append({"role": item.get("role", "user"), "content": text})
                elif typ == "function_call":
                    out.append(_assistant("", "", [{
                        "id": item.get("call_id") or item.get("id", ""),
                        "type": "function",
                        "function": {"name": item.get("name", ""), "arguments": item.get("arguments", "") or ""},
                    }]))
                elif typ == "function_call_output":
                    out.append({"role": "tool", "tool_call_id": item.get("call_id", ""),
                                "content": _stringify(item.get("output"))})
        return out

    def parse_response(self, data: Dict[str, Any]) -> Dict[str, Any]:
        content, reasoning, tools = [], [], []
        for item in data.get("output") or []:
            if not isinstance(item, dict):
                continue
            typ = item.get("type")
            if typ == "message":
                text, _ = _text_and_images(item.get("content"))
                if text:
                    content.append(text)
            elif typ == "reasoning":
                for s in item.get("summary") or []:
                    if isinstance(s, dict) and s.get("text"):
                        reasoning.append(s["text"])
            elif typ == "function_call":
                tools.append({
                    "id": item.get("call_id") or item.get("id", ""),
                    "type": "function",
                    "function": {"name": item.get("name", ""), "arguments": item.get("arguments", "") or ""},
                })
        if not content and isinstance(data.get("output_text"), str):
            content.append(data["output_text"])
        return _assistant("\n".join(content), "\n".join(reasoning), tools or None)

    def stream_collector(self):
        return _ResponsesStreamCollector(self)


class _ResponsesStreamCollector:
    def __init__(self, adapter: "ResponsesAdapter"):
        self._adapter = adapter
        self.text, self.reasoning = [], []
        self.tools: Dict[int, Dict[str, Any]] = {}
        self.order: List[int] = []
        self.final = None

    def feed(self, ev: Dict[str, Any]) -> None:
        t = ev.get("type", "")
        if t == "response.output_text.delta":
            self.text.append(ev.get("delta", "") or "")
        elif t in ("response.reasoning_summary_text.delta", "response.reasoning_text.delta"):
            self.reasoning.append(ev.get("delta", "") or "")
        elif t == "response.function_call_arguments.delta":
            idx = ev.get("output_index", 0)
            a = self.tools.setdefault(idx, {"id": "", "name": "", "args": []})
            if idx not in self.order:
                self.order.append(idx)
            a["args"].append(ev.get("delta", "") or "")
        elif t == "response.output_item.added":
            item = ev.get("item") or {}
            if item.get("type") == "function_call":
                idx = ev.get("output_index", 0)
                a = self.tools.setdefault(idx, {"id": "", "name": "", "args": []})
                if idx not in self.order:
                    self.order.append(idx)
                a["id"] = item.get("call_id") or item.get("id", "")
                a["name"] = item.get("name", "")
        elif t in ("response.completed", "response.incomplete"):
            self.final = ev.get("response")

    def finish(self) -> Dict[str, Any]:
        if isinstance(self.final, dict):
            return self._adapter.parse_response(self.final)
        tool_calls = [
            {"id": self.tools[i]["id"], "type": "function",
             "function": {"name": self.tools[i]["name"], "arguments": "".join(self.tools[i]["args"])}}
            for i in self.order
        ] or None
        return _assistant("".join(self.text), "".join(self.reasoning), tool_calls)


# --------------------------------------------------------------------------- #
# Anthropic Messages API
# --------------------------------------------------------------------------- #

class MessagesAdapter:
    name = "messages"
    auth = "anthropic"

    def normalize_request(self, body: Dict[str, Any]) -> List[Dict[str, Any]]:
        out = []
        system = body.get("system")
        if system:
            out.append({"role": "system", "content": _stringify(system)})
        for m in body.get("messages") or []:
            if not isinstance(m, dict):
                continue
            role = m.get("role", "user")
            content = m.get("content")
            if isinstance(content, str):
                out.append({"role": role, "content": content})
                continue
            text, tools, tool_results = [], [], []
            for b in content or []:
                if not isinstance(b, dict):
                    continue
                bt = b.get("type")
                if bt == "text":
                    text.append(b.get("text", ""))
                elif bt == "tool_use":
                    tools.append({
                        "id": b.get("id", ""), "type": "function",
                        "function": {"name": b.get("name", ""),
                                     "arguments": json.dumps(b.get("input", {}), ensure_ascii=False)},
                    })
                elif bt == "tool_result":
                    tool_results.append({"role": "tool", "tool_call_id": b.get("tool_use_id", ""),
                                         "content": _stringify(b.get("content"))})
                elif bt in ("image",):
                    text.append("[image omitted]")
            if text or tools:
                nm: Dict[str, Any] = {"role": role, "content": "\n".join(t for t in text if t)}
                if tools:
                    nm["tool_calls"] = tools
                out.append(nm)
            out.extend(tool_results)
        return out

    def parse_response(self, data: Dict[str, Any]) -> Dict[str, Any]:
        text, reasoning, tools = [], [], []
        for b in data.get("content") or []:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "text":
                text.append(b.get("text", ""))
            elif bt == "thinking":
                reasoning.append(b.get("thinking", ""))
            elif bt == "tool_use":
                tools.append({
                    "id": b.get("id", ""), "type": "function",
                    "function": {"name": b.get("name", ""),
                                 "arguments": json.dumps(b.get("input", {}), ensure_ascii=False)},
                })
        return _assistant("\n".join(t for t in text if t), "\n".join(reasoning), tools or None)

    def stream_collector(self):
        return _MessagesStreamCollector()


class _MessagesStreamCollector:
    def __init__(self):
        self.blocks: Dict[int, Dict[str, Any]] = {}

    def _block(self, idx: int) -> Dict[str, Any]:
        return self.blocks.setdefault(idx, {"type": None, "text": [], "name": "", "id": "", "json": []})

    def feed(self, ev: Dict[str, Any]) -> None:
        t = ev.get("type", "")
        if t == "content_block_start":
            blk = ev.get("content_block") or {}
            b = self._block(ev.get("index", 0))
            b["type"] = blk.get("type")
            b["name"] = blk.get("name", "") or b["name"]
            b["id"] = blk.get("id", "") or b["id"]
        elif t == "content_block_delta":
            b = self._block(ev.get("index", 0))
            d = ev.get("delta") or {}
            dt = d.get("type")
            if dt == "text_delta":
                b["type"] = b["type"] or "text"
                b["text"].append(d.get("text", ""))
            elif dt == "thinking_delta":
                b["type"] = "thinking"
                b["text"].append(d.get("thinking", ""))
            elif dt == "input_json_delta":
                b["type"] = "tool_use"
                b["json"].append(d.get("partial_json", ""))

    def finish(self) -> Dict[str, Any]:
        text, reasoning, tools = [], [], []
        for idx in sorted(self.blocks):
            b = self.blocks[idx]
            if b["type"] == "text":
                text.append("".join(b["text"]))
            elif b["type"] == "thinking":
                reasoning.append("".join(b["text"]))
            elif b["type"] == "tool_use":
                tools.append({"id": b["id"], "type": "function",
                              "function": {"name": b["name"], "arguments": "".join(b["json"])}})
        return _assistant("\n".join(t for t in text if t), "\n".join(reasoning), tools or None)


# --------------------------------------------------------------------------- #
# Registry
# --------------------------------------------------------------------------- #

# Maps the request path the client hit -> the adapter that understands it.
ADAPTERS: Dict[str, Any] = {
    "/v1/chat/completions": ChatCompletionsAdapter(),
    "/v1beta/chat/completions": ChatCompletionsAdapter(),
    "/v1/responses": ResponsesAdapter(),
    "/v1/messages": MessagesAdapter(),
}
