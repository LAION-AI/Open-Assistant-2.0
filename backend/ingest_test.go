package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

func TestHashMatchesFrontend(t *testing.T) {
	// Must equal Node/Bun's createHash("sha256").update("oa-test123").digest("hex")
	// (cross-checked), so keys hashed by the frontend verify here.
	sum := sha256.Sum256([]byte("oa-test123"))
	got := hex.EncodeToString(sum[:])
	want := "8a448b7ba7e2cab4151f0e90f0a8ff04600750b0d8337d18891f83e13bff84ff"
	if got != want {
		t.Fatalf("hash mismatch with frontend:\n got  %s\n want %s", got, want)
	}
}

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
	prompt, response, tokens := buildStoredPayload("gpt", messages)

	var p struct {
		Model    string           `json:"model"`
		Messages []map[string]any `json:"messages"`
	}
	if err := json.Unmarshal([]byte(prompt), &p); err != nil {
		t.Fatalf("prompt not valid json: %v", err)
	}
	if p.Model != "gpt" || len(p.Messages) != 4 {
		t.Fatalf("expected 4 history messages, got %d (%s)", len(p.Messages), prompt)
	}
	// mid-conversation tool_calls preserved
	if _, ok := p.Messages[2]["tool_calls"]; !ok {
		t.Fatalf("expected tool_calls preserved on history assistant: %s", prompt)
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
