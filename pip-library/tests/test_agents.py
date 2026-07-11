"""Claude Code (/v1/messages) and Codex (/v1/responses) wire-format handling,
per the caveats in unsloth.ai/docs/basics/claude-code and /codex:

- Claude Code prepends a per-request attribution line to the system prompt
  that invalidates every prompt-prefix cache; the proxy strips it.
- Claude Code replays assistant history with thinking blocks.
- Codex speaks the Responses API exclusively: reasoning items, function_call
  and custom_tool_call items, streamed argument deltas.
"""

import json

from open_assistant_proxy.server import strip_volatile_lines
from open_assistant_proxy.adapters import ADAPTERS
from open_assistant_proxy.redactor import _msg_fingerprint

MESSAGES = ADAPTERS["/v1/messages"]
RESPONSES = ADAPTERS["/v1/responses"]
CHAT = ADAPTERS["/v1/chat/completions"]


def _claude_code_body(cch: str) -> dict:
    """Anthropic Messages request the way Claude Code sends it: attribution
    line prepended to the first system block, cache_control markers, history
    with thinking + tool_use blocks."""
    return {
        "model": "unsloth/Qwen3.5-35B-A3B",
        "system": [
            {
                "type": "text",
                "text": f"x-anthropic-billing-header: cc_version=3.1.2; cch={cch};\nYou are Claude Code, Anthropic's official CLI.",
                "cache_control": {"type": "ephemeral"},
            },
            {"type": "text", "text": "Env context: cwd=/home/bot/project"},
        ],
        "messages": [
            {"role": "user", "content": "list files in src"},
            {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "I should run ls.", "signature": "sig1"},
                    {"type": "text", "text": "Let me check."},
                    {"type": "tool_use", "id": "toolu_01", "name": "Bash", "input": {"command": "ls src"}},
                ],
            },
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_01", "content": "a.ts\nb.ts"}]},
        ],
        "stream": True,
    }


# --------------------------------------------------------------------------- #
# Attribution stripping (the KV-cache fix)
# --------------------------------------------------------------------------- #

def test_strip_attribution_from_anthropic_system_blocks():
    body = strip_volatile_lines(_claude_code_body("aaaa1111"))
    first = body["system"][0]["text"]
    assert first == "You are Claude Code, Anthropic's official CLI."
    # untouched: second block, cache_control, messages
    assert body["system"][1]["text"] == "Env context: cwd=/home/bot/project"
    assert body["system"][0]["cache_control"] == {"type": "ephemeral"}


def test_strip_makes_prompt_prefix_stable_across_turns():
    """The whole point: two turns whose only difference is the volatile cch
    value must produce byte-identical system prompts after stripping, so the
    upstream KV cache and our redaction fingerprint cache both hit."""
    a = strip_volatile_lines(_claude_code_body("aaaa1111"))
    b = strip_volatile_lines(_claude_code_body("bbbb2222"))
    assert json.dumps(a["system"]) == json.dumps(b["system"])

    # and the normalized system message fingerprints (redaction-cache keys) match
    fa = _msg_fingerprint(MESSAGES.normalize_request(a)[0])
    fb = _msg_fingerprint(MESSAGES.normalize_request(b)[0])
    assert fa == fb


def test_strip_attribution_from_string_system_and_chat_messages():
    anth = strip_volatile_lines({"system": "x-anthropic-billing-header: cch=x;\nBe brief."})
    assert anth["system"] == "Be brief."

    chat = strip_volatile_lines({
        "messages": [
            {"role": "system", "content": "x-anthropic-billing-header: cch=y;\nBe brief."},
            {"role": "user", "content": "x-anthropic-billing-header: not stripped in user turns"},
        ]
    })
    assert chat["messages"][0]["content"] == "Be brief."
    assert "not stripped" in chat["messages"][1]["content"]


def test_strip_is_noop_without_attribution():
    body = {"system": "Be brief.", "messages": [{"role": "user", "content": "hi"}]}
    assert strip_volatile_lines(dict(body)) == body


# --------------------------------------------------------------------------- #
# Claude Code adapter (/v1/messages)
# --------------------------------------------------------------------------- #

def test_messages_adapter_keeps_replayed_thinking_and_tools():
    out = MESSAGES.normalize_request(strip_volatile_lines(_claude_code_body("cch")))
    assert [m["role"] for m in out] == ["system", "user", "assistant", "tool"]
    a = out[2]
    assert a["content"] == "Let me check."
    assert a["reasoning"] == "I should run ls."
    assert a["tool_calls"][0]["id"] == "toolu_01"
    assert json.loads(a["tool_calls"][0]["function"]["arguments"]) == {"command": "ls src"}
    assert out[3] == {"role": "tool", "tool_call_id": "toolu_01", "content": "a.ts\nb.ts"}


def test_messages_stream_collector_anthropic_sse():
    c = MESSAGES.stream_collector()
    for ev in [
        {"type": "message_start", "message": {"role": "assistant"}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking"}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "let me "}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "see"}},
        {"type": "content_block_start", "index": 1, "content_block": {"type": "text"}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Two files."}},
        {"type": "content_block_start", "index": 2,
         "content_block": {"type": "tool_use", "id": "toolu_02", "name": "Write"}},
        {"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": '{"path":'}},
        {"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": '"x.md"}'}},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use"}},
    ]:
        c.feed(ev)
    msg = c.finish()
    assert msg["content"] == "Two files."
    assert msg["reasoning"] == "let me see"
    assert msg["tool_calls"] == [{"id": "toolu_02", "type": "function",
                                  "function": {"name": "Write", "arguments": '{"path":"x.md"}'}}]


# --------------------------------------------------------------------------- #
# Codex adapter (/v1/responses)
# --------------------------------------------------------------------------- #

def test_responses_adapter_normalizes_codex_input():
    out = RESPONSES.normalize_request({
        "model": "unsloth/gemma-4-26B-A4B",
        "instructions": "You are Codex.",
        "input": [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "run the tests"}]},
            {"type": "reasoning", "summary": [{"type": "summary_text", "text": "need pytest"}], "content": []},
            {"type": "function_call", "call_id": "call_1", "name": "shell",
             "arguments": '{"command":["pytest"]}'},
            {"type": "function_call_output", "call_id": "call_1", "output": "3 passed"},
            {"type": "reasoning", "summary": [{"type": "summary_text", "text": "all green"}]},
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "All tests pass."}]},
            {"type": "custom_tool_call", "call_id": "call_2", "name": "apply_patch", "input": "*** Begin Patch"},
            {"type": "custom_tool_call_output", "call_id": "call_2", "output": "Done"},
        ],
    })
    assert [m["role"] for m in out] == ["system", "user", "assistant", "tool", "assistant", "assistant", "tool"]
    # reasoning attaches to the assistant turn that follows it
    assert out[2]["reasoning"] == "need pytest"
    assert out[2]["tool_calls"][0] == {"id": "call_1", "type": "function",
                                       "function": {"name": "shell", "arguments": '{"command":["pytest"]}'}}
    assert out[3] == {"role": "tool", "tool_call_id": "call_1", "content": "3 passed"}
    assert out[4] == {"role": "assistant", "content": "All tests pass.", "reasoning": "all green"}
    # custom tool calls (apply_patch) captured with their raw input
    assert out[5]["tool_calls"][0]["function"] == {"name": "apply_patch", "arguments": "*** Begin Patch"}
    assert out[6] == {"role": "tool", "tool_call_id": "call_2", "content": "Done"}


def test_responses_stream_collector_without_completed_event():
    c = RESPONSES.stream_collector()
    for ev in [
        {"type": "response.output_item.added", "output_index": 0,
         "item": {"type": "custom_tool_call", "call_id": "call_9", "name": "apply_patch"}},
        {"type": "response.custom_tool_call_input.delta", "output_index": 0, "delta": "*** Begin"},
        {"type": "response.custom_tool_call_input.delta", "output_index": 0, "delta": " Patch"},
        {"type": "response.output_text.delta", "delta": "Patching now."},
    ]:
        c.feed(ev)
    msg = c.finish()
    assert msg["content"] == "Patching now."
    assert msg["tool_calls"] == [{"id": "call_9", "type": "function",
                                  "function": {"name": "apply_patch", "arguments": "*** Begin Patch"}}]


def test_responses_final_event_wins_and_handles_custom_tools():
    c = RESPONSES.stream_collector()
    c.feed({"type": "response.output_text.delta", "delta": "partial"})
    c.feed({"type": "response.completed", "response": {
        "output": [
            {"type": "reasoning", "summary": [{"type": "summary_text", "text": "sum"}]},
            {"type": "message", "content": [{"type": "output_text", "text": "final text"}]},
            {"type": "custom_tool_call", "call_id": "c3", "name": "apply_patch", "input": "patch body"},
        ],
    }})
    msg = c.finish()
    assert msg["content"] == "final text"
    assert msg["reasoning"] == "sum"
    assert msg["tool_calls"][0]["function"] == {"name": "apply_patch", "arguments": "patch body"}
