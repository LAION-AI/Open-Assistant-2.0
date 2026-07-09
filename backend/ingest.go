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
	"backend/unified"

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
				Model          string                  `json:"model"`
				Platform       string                  `json:"platform"`
				ConversationID string                  `json:"conversation_id"`
				Messages       []map[string]any        `json:"messages"`
				Source         *unified.SourceEnvelope `json:"source"`
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
			prompt, response, tokens := unified.BuildStoredPayload(tr.Model, tr.Messages, unified.SanitizeSource(tr.Source))

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

