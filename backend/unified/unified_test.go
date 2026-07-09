package unified

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestBuildStoredPayload(t *testing.T) {
	messages := []map[string]any{
		{"role": "system", "content": "be brief"},
		{"role": "user", "content": "what is 2+2"},
		{"role": "assistant", "content": "4", "tool_calls": []any{
			map[string]any{"id": "c1", "type": "function", "function": map[string]any{"name": "calc", "arguments": "{}"}},
		}},
		{"role": "tool", "tool_call_id": "c1", "content": "ok"},
		{"role": "assistant", "content": "The answer is 4", "reasoning": "adding"},
	}
	prompt, response, tokens := BuildStoredPayload("gpt", messages, nil)

	var p struct {
		Schema   string           `json:"schema"`
		Model    string           `json:"model"`
		Messages []map[string]any `json:"messages"`
	}
	if err := json.Unmarshal([]byte(prompt), &p); err != nil {
		t.Fatalf("prompt not valid json: %v", err)
	}
	// rows are stamped with the unified trace schema (matches frontend)
	if p.Schema != Schema {
		t.Fatalf("expected schema %q, got %q", Schema, p.Schema)
	}
	if p.Model != "gpt" || len(p.Messages) != 4 {
		t.Fatalf("expected 4 history messages, got %d (%s)", len(p.Messages), prompt)
	}
	// mid-conversation tool_calls preserved, with call id
	tcs, ok := p.Messages[2]["tool_calls"].([]any)
	if !ok || len(tcs) != 1 {
		t.Fatalf("expected tool_calls preserved on history assistant: %s", prompt)
	}
	if tc, _ := tcs[0].(map[string]any); tc["id"] != "c1" {
		t.Fatalf("expected tool call id preserved: %s", prompt)
	}
	// tool result carries linkage
	if p.Messages[3]["tool_call_id"] != "c1" {
		t.Fatalf("expected tool_call_id on tool msg: %s", prompt)
	}
	// final assistant becomes response with reasoning_content
	if !strings.Contains(response, "The answer is 4") || !strings.Contains(response, `"reasoning_content":"adding"`) {
		t.Fatalf("unexpected response: %s", response)
	}
	if tokens <= 0 {
		t.Fatalf("expected positive token estimate")
	}
}

func TestBuildStoredPayloadUnifiedFields(t *testing.T) {
	messages := []map[string]any{
		{"role": "user", "content": "look at this", "image": "data:image/png;base64,AAA"},
		{"role": "assistant", "content": "", "tool_calls": []any{
			// non-string arguments get stringified, missing name defaults
			map[string]any{"id": "c9", "function": map[string]any{"name": "calc", "arguments": map[string]any{"x": 1}}},
		}},
		{"role": "user", "content": ""}, // payload-less: dropped
		{"role": "assistant", "content": "done", "reasoning_content": "already unified"},
	}
	prompt, response, _ := BuildStoredPayload("", messages, nil)

	var p struct {
		Model    string           `json:"model"`
		Messages []map[string]any `json:"messages"`
	}
	if err := json.Unmarshal([]byte(prompt), &p); err != nil {
		t.Fatalf("prompt not valid json: %v", err)
	}
	if p.Model != "trace" {
		t.Fatalf("expected model fallback 'trace', got %q", p.Model)
	}
	if len(p.Messages) != 2 {
		t.Fatalf("expected empty message dropped (2 history messages), got %d: %s", len(p.Messages), prompt)
	}
	// image moves into the unified images array; content stays a plain string
	imgs, _ := p.Messages[0]["images"].([]any)
	if len(imgs) != 1 || imgs[0] != "data:image/png;base64,AAA" {
		t.Fatalf("expected image in images field: %s", prompt)
	}
	if _, isStr := p.Messages[0]["content"].(string); !isStr {
		t.Fatalf("expected plain string content: %s", prompt)
	}
	// tool call arguments normalized to a JSON string
	tcs, _ := p.Messages[1]["tool_calls"].([]any)
	tc, _ := tcs[0].(map[string]any)
	fn, _ := tc["function"].(map[string]any)
	if fn["arguments"] != `{"x":1}` {
		t.Fatalf("expected stringified arguments: %s", prompt)
	}
	if !strings.Contains(response, `"reasoning_content":"already unified"`) {
		t.Fatalf("expected reasoning_content alias in response: %s", response)
	}
}

func TestBuildStoredPayloadSourceEnvelope(t *testing.T) {
	messages := []map[string]any{
		{"role": "user", "content": "hi"},
		{"role": "assistant", "content": "hello"},
	}
	raw := `{"sessionId":"s1","message":{"role":"user","content":"hi"}}` + "\n" + `{"message":{"role":"assistant","content":"hello"}}`
	src := SanitizeSource(&SourceEnvelope{Format: "claude-code", Kind: "jsonl", Name: "session.jsonl", Text: raw})

	prompt, _, withTokens := BuildStoredPayload("m", messages, src)
	_, _, withoutTokens := BuildStoredPayload("m", messages, nil)

	var p struct {
		Source *SourceEnvelope `json:"source"`
	}
	if err := json.Unmarshal([]byte(prompt), &p); err != nil {
		t.Fatalf("prompt not valid json: %v", err)
	}
	// verbatim, byte-for-byte
	if p.Source == nil || p.Source.Text != raw || p.Source.Format != "claude-code" || p.Source.Name != "session.jsonl" {
		t.Fatalf("expected verbatim source envelope, got %+v", p.Source)
	}
	// the source copy must not inflate contribution credit
	if withTokens != withoutTokens {
		t.Fatalf("source envelope changed token estimate: %d != %d", withTokens, withoutTokens)
	}
	// invalid envelopes are dropped
	if SanitizeSource(&SourceEnvelope{Text: ""}) != nil || SanitizeSource(nil) != nil {
		t.Fatalf("expected empty envelope to sanitize to nil")
	}
	if s := SanitizeSource(&SourceEnvelope{Text: "x", Kind: "weird"}); s == nil || s.Kind != "jsonl" || s.Format != "trace" {
		t.Fatalf("expected kind/format fallbacks, got %+v", s)
	}
}

func TestNormalizeMessageBlocks(t *testing.T) {
	// Anthropic-style block content: thinking + text + tool_use, then a user
	// message carrying a tool_result block that must split into a tool message,
	// plus a multimodal image message.
	out := NormalizeMessages([]map[string]any{
		{"role": "assistant", "content": []any{
			map[string]any{"type": "thinking", "thinking": "plan"},
			map[string]any{"type": "text", "text": "running"},
			map[string]any{"type": "tool_use", "id": "t1", "name": "bash", "input": map[string]any{"cmd": "ls"}},
		}},
		{"role": "user", "content": []any{
			map[string]any{"type": "tool_result", "tool_use_id": "t1", "content": "a.txt"},
		}},
		{"role": "user", "content": []any{
			map[string]any{"type": "text", "text": "see this"},
			map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:x"}},
		}},
	})
	if len(out) != 3 {
		t.Fatalf("expected 3 normalized messages, got %d: %+v", len(out), out)
	}
	a := out[0]
	if a["content"] != "running" || a["reasoning_content"] != "plan" {
		t.Fatalf("unexpected assistant normalization: %+v", a)
	}
	tcs, _ := a["tool_calls"].([]map[string]any)
	if len(tcs) != 1 || tcs[0]["id"] != "t1" {
		t.Fatalf("expected tool call with id from block: %+v", a)
	}
	tm := out[1]
	if tm["role"] != "tool" || tm["content"] != "a.txt" || tm["tool_call_id"] != "t1" {
		t.Fatalf("expected split tool message: %+v", tm)
	}
	um := out[2]
	imgs, _ := um["images"].([]any)
	if um["content"] != "see this" || len(imgs) != 1 || imgs[0] != "data:x" {
		t.Fatalf("expected flattened multimodal user message: %+v", um)
	}
}

func TestPromptJSON(t *testing.T) {
	rawReq := `{"model":"gpt","messages":[{"role":"user","content":"hi"}],"stream":true}`
	prompt, tokens := PromptJSON("gpt", []map[string]any{{"role": "user", "content": "hi"}},
		SanitizeSource(&SourceEnvelope{Format: "openai-chat", Kind: "json", Text: rawReq}))

	var p struct {
		Schema   string           `json:"schema"`
		Messages []map[string]any `json:"messages"`
		Source   *SourceEnvelope  `json:"source"`
	}
	if err := json.Unmarshal([]byte(prompt), &p); err != nil {
		t.Fatalf("prompt not valid json: %v", err)
	}
	// no response split: the user turn stays in messages
	if p.Schema != Schema || len(p.Messages) != 1 || p.Messages[0]["content"] != "hi" {
		t.Fatalf("unexpected prompt: %s", prompt)
	}
	if p.Source == nil || p.Source.Text != rawReq {
		t.Fatalf("expected verbatim wire request as source: %s", prompt)
	}
	if tokens <= 0 || tokens > len(prompt)/4 {
		t.Fatalf("expected source-less token estimate, got %d (prompt len %d)", tokens, len(prompt))
	}
}
