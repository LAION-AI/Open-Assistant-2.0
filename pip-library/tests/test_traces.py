"""Local trace-file parsers (oa-proxy upload) — one fixture per agent format,
mirroring the shapes found in the real pods on the NUC."""

import json
import sqlite3

from open_assistant_proxy.traces import (
    collect_traces,
    conversation_id,
    detect_format,
    parse_text_file,
    parse_sqlite_file,
)


def _lines(*objs):
    return "\n".join(json.dumps(o) for o in objs)


# --------------------------------------------------------------------------- #
# JSONL formats
# --------------------------------------------------------------------------- #

def test_claude_code_jsonl():
    text = _lines(
        {"type": "permission-mode", "permissionMode": "bypassPermissions", "sessionId": "s-1"},
        {"sessionId": "s-1", "type": "user", "message": {"role": "user", "content": "list files"}},
        {"sessionId": "s-1", "type": "assistant", "message": {"role": "assistant", "model": "qwen", "content": [
            {"type": "thinking", "thinking": "run ls"},
            {"type": "text", "text": "Checking."},
            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}}]}},
        {"sessionId": "s-1", "type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": "a.ts"}]}},
    )
    (t,) = parse_text_file("/x/.claude/projects/p/s-1.jsonl", text)
    assert t["platform"] == "claude-code" and t["model"] == "qwen"
    assert t["conversation_id"] == conversation_id("claude-code", "s-1")  # deterministic
    assert [m["role"] for m in t["messages"]] == ["user", "assistant", "tool"]
    a = t["messages"][1]
    assert a["reasoning"] == "run ls" and a["tool_calls"][0]["id"] == "t1"
    assert t["messages"][2] == {"role": "tool", "content": "a.ts", "tool_call_id": "t1"}
    assert t["source"]["text"] == text  # verbatim


def test_command_code_jsonl():
    text = _lines(
        {"id": "m1", "sessionId": "cc-1", "role": "user",
         "content": [{"type": "text", "text": "build it"}]},
        {"id": "m2", "sessionId": "cc-1", "role": "assistant", "content": [
            {"type": "text", "text": "On it."},
            {"type": "tool-call", "toolCallId": "call_1", "toolName": "shell_command",
             "input": {"command": "bun init"}}]},
        {"id": "m3", "sessionId": "cc-1", "role": "tool", "content": [
            {"type": "tool-result", "toolCallId": "call_1", "toolName": "shell_command",
             "output": {"type": "text", "value": "done"}}]},
    )
    (t,) = parse_text_file("/x/command-code-pods/main/config/projects/w/cc-1.jsonl", text)
    assert t["platform"] == "command-code"
    a = t["messages"][1]
    assert a["tool_calls"][0]["function"]["name"] == "shell_command"
    assert json.loads(a["tool_calls"][0]["function"]["arguments"]) == {"command": "bun init"}
    assert t["messages"][2] == {"role": "tool", "content": "done",
                                "tool_call_id": "call_1", "name": "shell_command"}


def test_pi_jsonl():
    text = _lines(
        {"type": "session", "version": 3, "id": "pi-1", "cwd": "/workspace"},
        {"type": "model_change", "provider": "rms", "modelId": "Qwen3.6"},
        {"type": "thinking_level_change", "thinkingLevel": "off"},
        {"type": "message", "message": {"role": "user", "content": [
            {"type": "text", "text": "write html"}]}},
        {"type": "message", "message": {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "plan"},
            {"type": "text", "text": "Writing."},
            {"type": "toolCall", "id": "call_9", "name": "write",
             "arguments": {"path": "/x.html", "content": "<html>"}}]}},
        {"type": "message", "message": {"role": "toolResult", "toolCallId": "call_9",
                                        "toolName": "write",
                                        "content": [{"type": "text", "text": "wrote 12 bytes"}]}},
    )
    (t,) = parse_text_file("pi-1.jsonl", text)  # detected by content, not path
    assert t["platform"] == "pi" and t["model"] == "Qwen3.6"
    assert t["conversation_id"] == conversation_id("pi", "pi-1")
    a = t["messages"][1]
    assert a["reasoning"] == "plan"
    assert a["tool_calls"][0]["id"] == "call_9"
    assert t["messages"][2] == {"role": "tool", "content": "wrote 12 bytes",
                                "tool_call_id": "call_9", "name": "write"}


def test_codex_rollout_with_custom_tools():
    text = _lines(
        {"type": "session_meta", "payload": {"id": "cx-1"}},
        {"type": "turn_context", "payload": {"model": "gemma"}},
        {"type": "response_item", "payload": {"type": "message", "role": "user",
                                              "content": [{"type": "input_text", "text": "patch it"}]}},
        {"type": "response_item", "payload": {"type": "reasoning",
                                              "summary": [{"type": "summary_text", "text": "patch first"}]}},
        {"type": "response_item", "payload": {"type": "custom_tool_call", "call_id": "c1",
                                              "name": "apply_patch", "input": "*** Begin Patch"}},
        {"type": "response_item", "payload": {"type": "custom_tool_call_output", "call_id": "c1",
                                              "output": "Done"}},
    )
    (t,) = parse_text_file("rollout-2026-07-10T20-44-21-abc.jsonl", text)
    assert t["platform"] == "codex" and t["model"] == "gemma"
    assert t["conversation_id"] == conversation_id("codex", "cx-1")
    a = t["messages"][1]
    assert a["reasoning"] == "patch first"
    assert a["tool_calls"][0]["function"] == {"name": "apply_patch", "arguments": "*** Begin Patch"}
    assert t["messages"][2] == {"role": "tool", "tool_call_id": "c1", "content": "Done"}


def test_config_files_yield_nothing():
    assert parse_text_file("settings.json", json.dumps({"env": {"FOO": "1"}})) == []
    assert parse_text_file("history.jsonl", _lines({"display": "hi", "project": "/x"})) == []


# --------------------------------------------------------------------------- #
# SQLite formats
# --------------------------------------------------------------------------- #

def _make_db(path, schema_and_rows):
    db = sqlite3.connect(path)
    for sql, rows in schema_and_rows:
        db.execute(sql)
        for r in rows:
            placeholders = ",".join("?" * len(r))
            table = sql.split()[2]
            db.execute(f"INSERT INTO {table} VALUES ({placeholders})", r)
    db.commit()
    db.close()


def test_crush_db(tmp_path):
    p = tmp_path / "crush.db"
    parts = json.dumps([
        {"type": "reasoning", "data": {"thinking": "plan"}},
        {"type": "text", "data": {"text": "Writing."}},
        {"type": "tool_call", "data": {"id": "c1", "name": "write",
                                       "input": "{\"file_path\": \"/x\"}", "finished": True}},
    ])
    result_parts = json.dumps([{"type": "tool_result",
                                "data": {"tool_call_id": "c1", "name": "write", "content": "ok"}}])
    _make_db(p, [
        ("CREATE TABLE sessions (id TEXT, title TEXT, created_at INT)",
         [("cr-1", "portfolio site", 1)]),
        ("CREATE TABLE messages (id TEXT, session_id TEXT, role TEXT, parts TEXT, model TEXT, created_at INT)",
         [("m0", "cr-1", "user", json.dumps([{"type": "text", "data": {"text": "make a site"}}]), None, 1),
          ("m1", "cr-1", "assistant", parts, "qwen", 2),
          ("m2", "cr-1", "tool", result_parts, None, 3)]),
    ])
    (t,) = parse_sqlite_file(str(p))
    assert t["platform"] == "crush" and t["model"] == "qwen" and t["title"] == "portfolio site"
    assert [m["role"] for m in t["messages"]] == ["user", "assistant", "tool"]
    assert t["messages"][1]["reasoning"] == "plan"
    assert t["messages"][1]["tool_calls"][0]["function"]["arguments"] == "{\"file_path\": \"/x\"}"
    assert t["messages"][2] == {"role": "tool", "content": "ok", "tool_call_id": "c1", "name": "write"}
    # source rows are reconstructable JSONL
    rows = [json.loads(l) for l in t["source"]["text"].splitlines()]
    assert rows[0]["table"] == "session" and len(rows) == 4


def test_hermes_db(tmp_path):
    p = tmp_path / "state.db"
    tool_calls = json.dumps([{"id": "c1", "type": "function",
                              "function": {"name": "write_file", "arguments": "{}"}}])
    _make_db(p, [
        ("CREATE TABLE sessions (id TEXT, model TEXT, title TEXT, started_at REAL)",
         [("hm-1", "qwen", "", 1.0)]),
        ("CREATE TABLE messages (id INTEGER, session_id TEXT, role TEXT, content TEXT, "
         "tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, reasoning TEXT, reasoning_content TEXT)",
         [(1, "hm-1", "user", "make a site", None, None, None, None, None),
          (2, "hm-1", "assistant", "", None, tool_calls, None, None, "thinking hard"),
          (3, "hm-1", "tool", "ok", "c1", None, "write_file", None, None)]),
    ])
    (t,) = parse_sqlite_file(str(p))
    assert t["platform"] == "hermes" and t["model"] == "qwen"
    assert t["messages"][1]["reasoning"] == "thinking hard"
    assert t["messages"][1]["tool_calls"][0]["function"]["name"] == "write_file"
    assert t["messages"][2] == {"role": "tool", "content": "ok",
                                "tool_call_id": "c1", "name": "write_file"}


def test_opencode_db(tmp_path):
    p = tmp_path / "opencode.db"
    _make_db(p, [
        ("CREATE TABLE session (id TEXT, title TEXT, model TEXT)",
         [("oc-1", "hello", json.dumps({"id": "qwen"}))]),
        ("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INT)",
         [("m1", "oc-1", json.dumps({"role": "user"}), 1),
          ("m2", "oc-1", json.dumps({"role": "assistant"}), 2)]),
        ("CREATE TABLE part (id TEXT, message_id TEXT, data TEXT, time_created INT)",
         [("p1", "m1", json.dumps({"type": "text", "text": "hi"}), 1),
          ("p2", "m2", json.dumps({"type": "text", "text": "hello!"}), 2),
          ("p3", "m2", json.dumps({"type": "tool", "tool": "bash", "callID": "c7",
                                   "state": {"input": {"cmd": "ls"}}}), 3)]),
    ])
    (t,) = parse_sqlite_file(str(p))
    assert t["platform"] == "opencode" and t["model"] == "qwen"
    assert t["messages"][1]["tool_calls"][0]["id"] == "c7"


# --------------------------------------------------------------------------- #
# Collection
# --------------------------------------------------------------------------- #

def test_collect_traces_walks_and_skips(tmp_path):
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "junk.json").write_text(json.dumps({"messages": [{"role": "user", "content": "x"}]}))
    (tmp_path / "s.jsonl").write_text(_lines(
        {"sessionId": "s", "message": {"role": "user", "content": "hi"}},
        {"sessionId": "s", "message": {"role": "assistant", "content": "hello"}}))
    (tmp_path / "settings.json").write_text(json.dumps({"theme": "dark"}))
    traces, notes = collect_traces([str(tmp_path)])
    assert len(traces) == 1 and traces[0]["turns"] == 1
    assert notes == []


def test_detect_format_paths():
    assert detect_format("/x/.claude/projects/a/b.jsonl", "") == "claude-code"
    assert detect_format("/x/command-code-pods/c.jsonl", "") == "command-code"
    assert detect_format("/x/rollout-2026.jsonl", "") == "codex"
    assert detect_format("/x/config/agent/sessions/a/b.jsonl", "") == "pi"
