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
	"sync"
	"time"

	"backend/db"
	"backend/unified"

	"github.com/google/uuid"
)

// credStore is a read-only handle to the frontend-owned user.db, used solely to
// verify programmatic API keys at the ingestion edge. The frontend remains the
// single writer of user.db; this connection never writes.
// The handle is opened lazily rather than at startup: on a fresh deployment the
// backend can boot before the frontend has created user.db, and a one-shot open
// at startup would leave /api/ingest permanently disabled until a restart.
type credStore struct {
	path string
	mu   sync.Mutex
	db   *sql.DB
}

func newCredStore(path string) *credStore { return &credStore{path: path} }

// handle returns the connection, opening it on first successful use.
func (c *credStore) handle() (*sql.DB, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.db != nil {
		return c.db, nil
	}
	// mode=ro guarantees the driver never writes. The frontend keeps user.db in
	// WAL mode as the single writer; a read-only reader attaches to its live
	// -wal/-shm sidecars while the frontend is running.
	h, err := sql.Open("sqlite", "file:"+c.path+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	if err := h.Ping(); err != nil {
		h.Close()
		return nil, err
	}
	c.db = h
	return c.db, nil
}

func (c *credStore) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.db == nil {
		return nil
	}
	err := c.db.Close()
	c.db = nil
	return err
}

// userIDForKey returns the owning user id for a presented plaintext API key, or
// ("", false) if unknown. Keys are stored as SHA-256 hex (matching the
// frontend), so we hash before the lookup.
func (c *credStore) userIDForKey(rawKey string) (string, bool) {
	h, err := c.handle()
	if err != nil {
		return "", false
	}
	sum := sha256.Sum256([]byte(strings.TrimSpace(rawKey)))
	var id string
	if err := h.QueryRow(`SELECT id FROM users WHERE api_key = ?`, hex.EncodeToString(sum[:])).Scan(&id); err != nil {
		return "", false
	}
	return id, true
}

// uploadAllowed mirrors the frontend's upload gate: an account whose only
// credential is a password must add a second factor before it may contribute.
// Enforced here too, because an API key would otherwise walk straight past the
// check the UI makes.
//
// Fails closed. If the consent/credential store cannot be read, the answer is
// "no": refusing an upload is recoverable, accepting one under an unverified
// identity is not.
func (c *credStore) uploadAllowed(userID string) bool {
	h, err := c.handle()
	if err != nil {
		log.Printf("ingest: cannot check upload eligibility for %s: %v", userID, err)
		return false
	}

	// A passkey is hardware-bound and already multi-factor.
	var passkeys int
	if err := h.QueryRow(`SELECT COUNT(*) FROM credentials WHERE user_id = ?`, userID).Scan(&passkeys); err != nil {
		log.Printf("ingest: cannot count passkeys for %s: %v", userID, err)
		return false
	}
	if passkeys > 0 {
		return true
	}

	var method sql.NullString
	if err := h.QueryRow(`SELECT twofa_method FROM users WHERE id = ?`, userID).Scan(&method); err != nil {
		log.Printf("ingest: cannot read 2FA state for %s: %v", userID, err)
		return false
	}
	return method.Valid && method.String != ""
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
		// Surface a retryable status if user.db still isn't readable, rather
		// than reporting every key as invalid.
		if _, err := creds.handle(); err != nil {
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
		if !creds.uploadAllowed(userID) {
			http.Error(w,
				`{"error":"two-factor authentication required before uploading: add a second factor or a passkey in Settings"}`,
				http.StatusForbidden)
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
