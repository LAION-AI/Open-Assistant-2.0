"""Raw wire-request redaction (the lossless source envelope).

Uses a stub classifier so no model download / torch inference is needed — the
logic under test is the JSON walking, the structural-key exemptions, and the
per-unit fingerprint cache.
"""

import json

from open_assistant_proxy.redactor import (
    redact_json_value,
    redact_wire_request,
    redact_messages,
)


class CountingClassifier:
    """Flags every occurrence of "Bob" as a person; counts invocations so the
    cache behavior is observable."""

    def __init__(self):
        self.calls = 0

    def __call__(self, text, aggregation_strategy="simple"):
        self.calls += 1
        out = []
        i = text.find("Bob")
        while i != -1:
            out.append({"entity_group": "private_person", "start": i, "end": i + 3})
            i = text.find("Bob", i + 3)
        return out


def test_redact_json_value_scrubs_prose_keeps_structure():
    clf = CountingClassifier()
    value = {
        "type": "message",
        "id": "msg_Bob_1",
        "model": "gpt-4o",
        "content": [
            {"type": "text", "text": "Hi I am Bob"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64," + "Qm9i" * 200}},
        ],
        "metadata": {"note": "Bob wrote this", "count": 3},
    }
    out = redact_json_value(value, clf)
    # structural fields untouched (ids/enums must survive for back-conversion)
    assert out["type"] == "message"
    assert out["id"] == "msg_Bob_1"
    assert out["model"] == "gpt-4o"
    # prose scrubbed, shape intact
    assert out["content"][0]["text"] == "Hi I am [REDACTED_PERSON]"
    assert out["metadata"]["note"] == "[REDACTED_PERSON] wrote this"
    assert out["metadata"]["count"] == 3
    # data URI skipped entirely (no NER call on the blob)
    assert out["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")


def test_redact_json_value_redacts_tool_arguments_and_secrets():
    clf = CountingClassifier()
    out = redact_json_value(
        {
            "role": "assistant",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "run", "arguments": '{"cmd":"export API_KEY=sk-abcdefghij1234567890 # by Bob"}'},
                }
            ],
        },
        clf,
    )
    args = out["tool_calls"][0]["function"]["arguments"]
    # matches this proxy's policy: tool arguments ARE redacted (secrets + NER)
    assert "sk-abcdefghij" not in args
    assert "[REDACTED_SECRET]" in args
    assert "[REDACTED_PERSON]" in args
    assert out["tool_calls"][0]["id"] == "call_1"


def test_redact_wire_request_caches_per_message_and_system():
    clf = CountingClassifier()
    cache = {}
    system = "You are a helpful assistant working for Bob."
    turn1 = {
        "model": "gpt-4o",
        "system": system,
        "messages": [{"role": "user", "content": "Hi I am Bob"}],
        "stream": True,
    }
    out1 = redact_wire_request(turn1, clf, True, cache)
    assert out1["system"] == "You are a helpful assistant working for [REDACTED_PERSON]."
    assert out1["messages"][0]["content"] == "Hi I am [REDACTED_PERSON]"
    assert out1["stream"] is True
    calls_after_turn1 = clf.calls
    assert calls_after_turn1 > 0

    # Turn 2 replays the same system + history plus one new message: only the
    # new message may cost classifier calls.
    turn2 = {
        "model": "gpt-4o",
        "system": system,
        "messages": [
            {"role": "user", "content": "Hi I am Bob"},
            {"role": "assistant", "content": "Hello!"},
        ],
        "stream": True,
    }
    out2 = redact_wire_request(turn2, clf, True, cache)
    new_calls = clf.calls - calls_after_turn1
    assert new_calls == 1, f"expected only the new message to be classified, got {new_calls} calls"
    assert out2["messages"][0]["content"] == "Hi I am [REDACTED_PERSON]"
    assert out2["messages"][1]["content"] == "Hello!"


def test_redact_wire_request_handles_anthropic_and_responses_shapes():
    clf = CountingClassifier()
    # Anthropic messages: block content + top-level system
    anth = redact_wire_request(
        {
            "model": "claude-sonnet-5",
            "system": [{"type": "text", "text": "Serve Bob well"}],
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "Bob here"}]},
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "found Bob"}]},
            ],
        },
        clf,
        True,
        {},
    )
    assert anth["system"][0]["text"] == "Serve [REDACTED_PERSON] well"
    assert anth["messages"][0]["content"][0]["text"] == "[REDACTED_PERSON] here"
    assert anth["messages"][1]["content"][0]["tool_use_id"] == "t1"
    assert anth["messages"][1]["content"][0]["content"] == "found [REDACTED_PERSON]"

    # OpenAI responses: `input` list + `instructions` string
    resp = redact_wire_request(
        {"model": "gpt-5", "instructions": "Assist Bob", "input": [{"role": "user", "content": "I am Bob"}]},
        clf,
        True,
        {},
    )
    assert resp["instructions"] == "Assist [REDACTED_PERSON]"
    assert resp["input"][0]["content"] == "I am [REDACTED_PERSON]"


def test_source_stays_consistent_with_normalized_messages():
    """The invariant that matters: anything scrubbed from the normalized
    messages must also be scrubbed from the raw copy."""
    clf = CountingClassifier()
    cache = {}
    raw = {"model": "m", "messages": [{"role": "user", "content": "secret friend Bob"}]}

    normalized = redact_messages(list(raw["messages"]), clf, True, cache)
    redacted_raw = redact_wire_request(raw, clf, True, cache)

    assert normalized[0]["content"] == "secret friend [REDACTED_PERSON]"
    assert json.dumps(redacted_raw).count("Bob") == 0
