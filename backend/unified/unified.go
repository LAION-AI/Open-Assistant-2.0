// Package unified is the Go mirror of frontend/src/lib/unified.ts: every row
// written to logs.db — direct pip ingest (/api/ingest), the live V1 proxy, and
// (via the Bun frontend) web uploads — is normalized to the same canonical
// trace schema so rows are reproducible and back-convertible regardless of
// source. Keep the two implementations in sync.
package unified

import "encoding/json"

// Schema must match UNIFIED_SCHEMA in frontend/src/lib/unified.ts.
const Schema = "oa.unified.v2"

// MaxSourceBytes caps the verbatim source copy a client may attach (the web
// upload path applies the same limit).
const MaxSourceBytes = 20 * 1024 * 1024

// SourceEnvelope is the original trace kept verbatim (see SourceEnvelope in
// frontend/src/lib/unified.ts): the exact file content — or, for live
// captures, the exact wire request — so the source format can be reconstructed
// byte-for-byte. It rides along in the stored prompt.
type SourceEnvelope struct {
	Format string `json:"format"`
	Kind   string `json:"kind"`
	Name   string `json:"name,omitempty"`
	Text   string `json:"text"`
}

// SanitizeSource validates a client-supplied envelope; nil when absent/invalid.
func SanitizeSource(s *SourceEnvelope) *SourceEnvelope {
	if s == nil || s.Text == "" || len(s.Text) > MaxSourceBytes {
		return nil
	}
	out := &SourceEnvelope{Format: s.Format, Kind: s.Kind, Name: s.Name, Text: s.Text}
	if out.Format == "" {
		out.Format = "trace"
	}
	if len(out.Format) > 40 {
		out.Format = out.Format[:40]
	}
	if out.Kind != "json" {
		out.Kind = "jsonl"
	}
	if len(out.Name) > 200 {
		out.Name = out.Name[:200]
	}
	return out
}

// strOr returns v as a string when it is one, else "".
func strOr(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// stringify renders any value as a string (JSON for non-strings).
func stringify(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if v == nil {
		return ""
	}
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}

// NormalizeToolCalls coerces tool call entries into the canonical
// {id?, type, function:{name, arguments-string}} shape (arguments always a
// JSON string), mirroring the frontend normalizer.
func NormalizeToolCalls(v any) []map[string]any {
	list, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(list))
	for _, item := range list {
		tc, ok := item.(map[string]any)
		if !ok {
			continue
		}
		fn, _ := tc["function"].(map[string]any)
		if fn == nil {
			fn = tc
		}
		args := fn["arguments"]
		if args == nil {
			args = fn["input"]
		}
		argStr, ok := args.(string)
		if !ok && args != nil {
			argStr = stringify(args)
		}
		name := strOr(fn["name"])
		if name == "" {
			name = strOr(tc["name"])
		}
		if name == "" {
			name = "tool"
		}
		e := map[string]any{
			"type":     "function",
			"function": map[string]any{"name": name, "arguments": argStr},
		}
		id := strOr(tc["id"])
		if id == "" {
			id = strOr(tc["call_id"])
		}
		if id != "" {
			e["id"] = id
		}
		out = append(out, e)
	}
	return out
}

// imageOfBlock extracts an image URL from a content block, if it is one.
func imageOfBlock(b map[string]any) string {
	switch strOr(b["type"]) {
	case "image_url":
		if iu, ok := b["image_url"].(map[string]any); ok {
			return strOr(iu["url"])
		}
		return strOr(b["image_url"])
	case "image":
		if url := strOr(b["url"]); url != "" {
			return url
		}
		if src, ok := b["source"].(map[string]any); ok {
			if strOr(src["type"]) == "base64" && strOr(src["data"]) != "" {
				mt := strOr(src["media_type"])
				if mt == "" {
					mt = "image/png"
				}
				return "data:" + mt + ";base64," + strOr(src["data"])
			}
			return strOr(src["url"])
		}
	}
	return ""
}

func joinLines(parts []string) string {
	out := ""
	for _, p := range parts {
		if p == "" {
			continue
		}
		if out != "" {
			out += "\n"
		}
		out += p
	}
	return out
}

// NormalizeMessage converts one raw message into the unified shape: content is
// always a plain string; reasoning (either alias), tool calls, tool linkage and
// images live in dedicated fields. Anthropic-style inline tool_result blocks
// split into separate tool-role messages (host message first), so one input may
// produce several outputs. Deterministic — never generates ids. Returns nil for
// messages with no payload.
func NormalizeMessage(m map[string]any) []map[string]any {
	role := strOr(m["role"])
	if role == "" {
		if t := strOr(m["type"]); t == "user" || t == "assistant" {
			role = t
		} else {
			return nil
		}
	}

	var texts, reasonings, images []string
	var toolCalls []map[string]any
	var toolResults []map[string]any

	if r := strOr(m["reasoning_content"]); r != "" {
		reasonings = append(reasonings, r)
	} else if r := strOr(m["reasoning"]); r != "" {
		reasonings = append(reasonings, r)
	}
	if img := strOr(m["image"]); img != "" {
		images = append(images, img)
	}
	if list, ok := m["images"].([]any); ok {
		for _, u := range list {
			if s := strOr(u); s != "" {
				images = append(images, s)
			}
		}
	}
	toolCalls = append(toolCalls, NormalizeToolCalls(m["tool_calls"])...)

	switch content := m["content"].(type) {
	case string:
		if content != "" {
			texts = append(texts, content)
		}
	case []any:
		for _, item := range content {
			b, ok := item.(map[string]any)
			if !ok {
				continue
			}
			switch strOr(b["type"]) {
			case "text", "output_text", "input_text":
				if t := strOr(b["text"]); t != "" {
					texts = append(texts, t)
				}
			case "thinking", "reasoning":
				t := strOr(b["thinking"])
				if t == "" {
					t = strOr(b["text"])
				}
				if t != "" {
					reasonings = append(reasonings, t)
				}
			case "tool_use", "tool_call", "function_call":
				toolCalls = append(toolCalls, NormalizeToolCalls([]any{item})...)
			case "tool_result", "function_call_output":
				body := b["content"]
				if body == nil {
					body = b["output"]
				}
				tm := map[string]any{"role": "tool", "content": stringify(body)}
				id := strOr(b["tool_use_id"])
				if id == "" {
					id = strOr(b["tool_call_id"])
				}
				if id == "" {
					id = strOr(b["call_id"])
				}
				if id != "" {
					tm["tool_call_id"] = id
				}
				if name := strOr(b["name"]); name != "" {
					tm["name"] = name
				}
				toolResults = append(toolResults, tm)
			default:
				if img := imageOfBlock(b); img != "" {
					images = append(images, img)
				}
			}
		}
	default:
		if content != nil {
			texts = append(texts, stringify(content))
		}
	}

	e := map[string]any{"role": role, "content": joinLines(texts)}
	if r := joinLines(reasonings); r != "" {
		e["reasoning_content"] = r
	}
	if len(toolCalls) > 0 {
		e["tool_calls"] = toolCalls
	}
	if len(images) > 0 {
		imgs := make([]any, len(images))
		for i, u := range images {
			imgs[i] = u
		}
		e["images"] = imgs
	}

	var out []map[string]any
	if role == "tool" {
		if id := strOr(m["tool_call_id"]); id != "" {
			e["tool_call_id"] = id
		}
		if name := strOr(m["name"]); name != "" {
			e["name"] = name
		}
		out = append(out, e)
	} else if strOr(e["content"]) != "" || len(reasonings) > 0 || len(toolCalls) > 0 || len(images) > 0 {
		out = append(out, e)
	}
	return append(out, toolResults...)
}

// NormalizeMessages normalizes a whole conversation.
func NormalizeMessages(messages []map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(messages))
	for _, m := range messages {
		out = append(out, NormalizeMessage(m)...)
	}
	return out
}

// promptObject assembles the stored prompt map (without the source envelope).
func promptObject(model string, history []map[string]any) map[string]any {
	if model == "" {
		model = "trace"
	}
	return map[string]any{"schema": Schema, "model": model, "messages": history}
}

// withSource re-marshals the prompt with the envelope attached. The token
// estimate is always taken from the source-less form — the verbatim copy must
// not inflate contribution credit.
func withSource(promptObj map[string]any, source *SourceEnvelope) string {
	if source != nil {
		promptObj["source"] = source
	}
	b, _ := json.Marshal(promptObj)
	return string(b)
}

// BuildStoredPayload normalizes a full conversation and splits it into
// (prompt, response, tokens): the last assistant message becomes the response,
// everything before it the prompt history.
func BuildStoredPayload(model string, messages []map[string]any, source *SourceEnvelope) (string, string, int) {
	normalized := NormalizeMessages(messages)

	history := normalized
	finalAssistant := map[string]any{"role": "assistant", "content": ""}
	if n := len(normalized); n > 0 {
		if strOr(normalized[n-1]["role"]) == "assistant" {
			finalAssistant = normalized[n-1]
			history = normalized[:n-1]
		}
	}

	promptObj := promptObject(model, history)
	promptBytes, _ := json.Marshal(promptObj)

	respObj := map[string]any{
		"role":              "assistant",
		"content":           strOr(finalAssistant["content"]),
		"reasoning_content": strOr(finalAssistant["reasoning_content"]),
	}
	if tc := finalAssistant["tool_calls"]; tc != nil {
		respObj["tool_calls"] = tc
	}
	if imgs := finalAssistant["images"]; imgs != nil {
		respObj["images"] = imgs
	}
	respBytes, _ := json.Marshal(respObj)

	tokens := (len(promptBytes) + len(respBytes)) / 4
	return withSource(promptObj, source), string(respBytes), tokens
}

// PromptJSON normalizes request messages into a stored prompt without
// splitting off a response — used by the live proxy, where the assistant
// response arrives separately from upstream. Returns the prompt JSON and its
// token estimate (source excluded).
func PromptJSON(model string, messages []map[string]any, source *SourceEnvelope) (string, int) {
	promptObj := promptObject(model, NormalizeMessages(messages))
	promptBytes, _ := json.Marshal(promptObj)
	return withSource(promptObj, source), len(promptBytes) / 4
}
