package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"backend/db"

	"github.com/google/uuid"
)

// credStore is a read-only handle to the frontend-owned user.db, used solely to
// verify programmatic API keys at the ingestion edge. The frontend remains the
// single writer of user.db; this connection never writes.
type credStore struct{ db *sql.DB }

func openCredStore(path string) (*credStore, error) {
	// mode=ro guarantees the driver never writes. The frontend keeps user.db in
	// WAL mode as the single writer; a read-only reader attaches to its live
	// -wal/-shm sidecars while the frontend is running.
	h, err := sql.Open("sqlite", "file:"+path+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	if err := h.Ping(); err != nil {
		h.Close()
		return nil, err
	}
	return &credStore{db: h}, nil
}

// userIDForKey returns the owning user id for a presented plaintext API key, or
// ("", false) if unknown. Keys are stored as SHA-256 hex (matching the
// frontend), so we hash before the lookup.
func (c *credStore) userIDForKey(rawKey string) (string, bool) {
	sum := sha256.Sum256([]byte(strings.TrimSpace(rawKey)))
	var id string
	err := c.db.QueryRow(`SELECT id FROM users WHERE api_key = ?`, hex.EncodeToString(sum[:])).Scan(&id)
	if err != nil {
		return "", false
	}
	return id, true
}

// makeIngestHandler authenticates uploads with the read-only credential store
// and writes them straight to logs.db — no frontend hop. This is the only
// backend route intended to be publicly reachable (via a scoped Caddy path);
// the userId-trusting routes must stay internal.
func makeIngestHandler(repo db.LogRepository, creds *credStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodPost {
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}
		if creds == nil {
			http.Error(w, `{"error":"credential store unavailable"}`, http.StatusServiceUnavailable)
			return
		}

		key := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if key == "" {
			http.Error(w, `{"error":"missing api key"}`, http.StatusUnauthorized)
			return
		}
		userID, ok := creds.userIDForKey(key)
		if !ok {
			http.Error(w, `{"error":"invalid api key"}`, http.StatusUnauthorized)
			return
		}

		var payload struct {
			Traces []struct {
				Model          string           `json:"model"`
				Platform       string           `json:"platform"`
				ConversationID string           `json:"conversation_id"`
				Messages       []map[string]any `json:"messages"`
			} `json:"traces"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			http.Error(w, `{"error":"invalid payload"}`, http.StatusBadRequest)
			return
		}

		saved := 0
		for _, tr := range payload.Traces {
			if len(tr.Messages) == 0 {
				continue
			}
			prompt, response, tokens := buildStoredPayload(tr.Model, tr.Messages)

			platform := tr.Platform
			if platform == "" {
				platform = "pip-library"
			}
			if len(platform) > 40 {
				platform = platform[:40]
			}
			convID := tr.ConversationID
			if convID == "" {
				convID = uuid.NewString()
			}

			if err := repo.UpsertLog(r.Context(), &db.LogEntry{
				UserID:         userID,
				ConversationID: convID,
				Platform:       platform,
				Prompt:         db.ToRawJSON([]byte(prompt)),
				Response:       db.ToRawJSON([]byte(response)),
				Tokens:         tokens,
				CreatedAt:      time.Now().Unix(),
			}); err != nil {
				log.Printf("ingest: save error (user=%s): %v", userID, err)
				continue
			}
			saved++
		}

		fmt.Fprintf(w, `{"saved":%d}`, saved)
	}
}

// buildStoredPayload mirrors the frontend's split of a normalized message list
// into (prompt, response, tokens), so traces ingested directly by the backend
// are stored identically to those that came through the Bun /api/traces/upload
// path. The last assistant message becomes the response; everything before it
// is the prompt history.
func buildStoredPayload(model string, messages []map[string]any) (string, string, int) {
	history := messages
	finalAssistant := map[string]any{"role": "assistant", "content": ""}
	if n := len(messages); n > 0 {
		if role, _ := messages[n-1]["role"].(string); role == "assistant" {
			finalAssistant = messages[n-1]
			history = messages[:n-1]
		}
	}

	apiHistory := make([]map[string]any, 0, len(history))
	for _, m := range history {
		role, _ := m["role"].(string)
		switch role {
		case "assistant":
			e := map[string]any{"role": "assistant", "content": strOr(m["content"])}
			if reasoning := strOr(m["reasoning"]); reasoning != "" {
				e["reasoning_content"] = reasoning
			}
			if tc := m["tool_calls"]; tc != nil {
				e["tool_calls"] = tc
			}
			apiHistory = append(apiHistory, e)
		case "tool":
			e := map[string]any{"role": "tool", "content": strOr(m["content"])}
			if id := strOr(m["tool_call_id"]); id != "" {
				e["tool_call_id"] = id
			}
			if name := strOr(m["name"]); name != "" {
				e["name"] = name
			}
			apiHistory = append(apiHistory, e)
		default:
			if img := strOr(m["image"]); img != "" {
				apiHistory = append(apiHistory, map[string]any{
					"role": role,
					"content": []any{
						map[string]any{"type": "text", "text": strOr(m["content"])},
						map[string]any{"type": "image_url", "image_url": map[string]any{"url": img}},
					},
				})
			} else {
				apiHistory = append(apiHistory, map[string]any{"role": role, "content": strOr(m["content"])})
			}
		}
	}

	if model == "" {
		model = "trace"
	}
	promptBytes, _ := json.Marshal(map[string]any{"model": model, "messages": apiHistory})

	respObj := map[string]any{
		"role":              "assistant",
		"content":           strOr(finalAssistant["content"]),
		"reasoning_content": strOr(finalAssistant["reasoning"]),
	}
	if tc := finalAssistant["tool_calls"]; tc != nil {
		respObj["tool_calls"] = tc
	}
	respBytes, _ := json.Marshal(respObj)

	tokens := (len(promptBytes) + len(respBytes)) / 4
	return string(promptBytes), string(respBytes), tokens
}

// strOr returns v as a string when it is one, else "".
func strOr(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
