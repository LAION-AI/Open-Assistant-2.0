package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"

	"backend/db"
)

// Dataset export.
//
// The hard rule here is that consent is a *query predicate*, not a step someone
// remembers to perform. Interaction data lives in logs.db and consent lives in
// the frontend's user.db, so the two are joined at read time against the
// read-only credential store: rows whose contributor is not in the consented
// set are never assembled into a response in the first place. There is no
// "export everything" path to reach for by mistake.

// consentedUserIDs returns the users who have granted dataset-release consent
// *for the given document version*. A version bump therefore drops everyone
// who has not re-consented, rather than silently carrying an old consent onto a
// document they never saw.
func (c *credStore) consentedUserIDs(consentVersion string) (map[string]bool, error) {
	h, err := c.handle()
	if err != nil {
		return nil, err
	}
	rows, err := h.Query(
		`SELECT id FROM users WHERE dataset_consent = 1 AND dataset_consent_version = ?`,
		consentVersion)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	ids := make(map[string]bool)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids[id] = true
	}
	return ids, rows.Err()
}

// participantID is the pseudonymous identifier that replaces the account id in
// a release. Account ids are UUIDs and never published (see privacy.md §5.2);
// the hash keeps a contributor's rows linkable to each other within a release
// without carrying the account identifier itself.
func participantID(userID string) string {
	return pseudonym("oa2-participant:", userID)
}

// conversationRef replaces the stored conversation id. Ids from imported traces
// are whatever the originating tool used — they have been observed to embed
// file paths and machine names — so the raw value is never released. Hashing
// keeps the turns of one conversation groupable without shipping that string.
func conversationRef(conversationID string) string {
	return pseudonym("oa2-conversation:", conversationID)
}

// instanceRef is the identifier a release carries per instance. It exists so a
// specific published row can be reported and withdrawn after the fact (terms
// § 4.4, privacy § 5.3): a reporter quotes this, and it maps back to exactly one
// row here. Derived from the row id, so it is stable across releases as long as
// the row lives — and the row not living is itself the removal.
func instanceRef(id int64) string {
	return pseudonym("oa2-instance:", strconv.FormatInt(id, 10))
}

func pseudonym(domain, value string) string {
	sum := sha256.Sum256([]byte(domain + value))
	return hex.EncodeToString(sum[:])[:16]
}

// ExportRow is one released instance. Deliberately not db.LogEntry: that type
// carries UserID, and a struct that *can* serialise an account id is a struct
// that eventually will.
type ExportRow struct {
	// Quote this when reporting an instance for withdrawal — see instanceRef.
	InstanceID    string `json:"instanceId"`
	ParticipantID string `json:"participantId"`
	// Pseudonymous, like ParticipantID — see conversationRef.
	ConversationID string          `json:"conversationId"`
	Platform       string          `json:"platform"`
	Prompt         json.RawMessage `json:"prompt"`
	Response       json.RawMessage `json:"response"`
	Tokens         int             `json:"tokens"`
	CreatedAt      int64           `json:"createdAt"`
	// Whether on-device redaction ran before this instance was stored. Provenance
	// for downstream users, not a guarantee that the instance is PII-free.
	ClientRedacted bool   `json:"clientRedacted"`
	ConsentVersion string `json:"consentVersion"`
}

// buildExport filters logs down to consenting contributors and pseudonymises
// them. Exported for testing: this is the function that must never leak a
// non-consenting row, so it is tested directly rather than through HTTP.
func buildExport(logs []*db.LogEntry, consented map[string]bool, consentVersion string) []ExportRow {
	out := make([]ExportRow, 0, len(logs))
	for _, l := range logs {
		if l == nil || !consented[l.UserID] {
			continue
		}
		out = append(out, ExportRow{
			InstanceID:     instanceRef(l.ID),
			ParticipantID:  participantID(l.UserID),
			ConversationID: conversationRef(l.ConversationID),
			Platform:       l.Platform,
			Prompt:         l.Prompt,
			Response:       l.Response,
			Tokens:         l.Tokens,
			CreatedAt:      l.CreatedAt,
			ClientRedacted: l.ClientRedacted,
			ConsentVersion: consentVersion,
		})
	}
	return out
}

// makeExportHandler serves the consented corpus as JSON Lines.
//
// Internal by design: Caddy routes only /proxy/api/ingest to this backend, so
// this endpoint is reachable from the frontend (which checks for an admin
// session) and from the host, not from the internet.
func makeExportHandler(repo db.LogRepository, creds *credStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}
		if creds == nil {
			http.Error(w, `{"error":"credential store unavailable"}`, http.StatusServiceUnavailable)
			return
		}

		// The caller states which consent version it is releasing under; the
		// frontend takes it from src/lib/legal.ts. No default: guessing the
		// version would mean guessing what people agreed to.
		consentVersion := strings.TrimSpace(r.URL.Query().Get("consentVersion"))
		if consentVersion == "" {
			http.Error(w, `{"error":"consentVersion is required"}`, http.StatusBadRequest)
			return
		}

		consented, err := creds.consentedUserIDs(consentVersion)
		if err != nil {
			log.Printf("export: cannot read consent state: %v", err)
			http.Error(w, `{"error":"consent state unavailable"}`, http.StatusServiceUnavailable)
			return
		}
		// An empty consent set exports nothing. That is the correct outcome, not
		// an error to work around.
		if len(consented) == 0 {
			w.Header().Set("Content-Type", "application/x-ndjson")
			w.Header().Set("X-Export-Rows", "0")
			w.WriteHeader(http.StatusOK)
			return
		}

		logs, err := repo.GetLogs(r.Context())
		if err != nil {
			log.Printf("export: cannot read logs: %v", err)
			http.Error(w, fmt.Sprintf(`{"error":"database error: %v"}`, err), http.StatusInternalServerError)
			return
		}

		rows := buildExport(logs, consented, consentVersion)

		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set("X-Export-Rows", fmt.Sprint(len(rows)))
		w.Header().Set("Content-Disposition", `attachment; filename="oa2-export.jsonl"`)
		w.WriteHeader(http.StatusOK)

		enc := json.NewEncoder(w)
		for _, row := range rows {
			if err := enc.Encode(row); err != nil {
				log.Printf("export: write failed after %d rows: %v", len(rows), err)
				return
			}
		}
		log.Printf("export: %d row(s) from %d consenting contributor(s), consent version %s",
			len(rows), len(consented), consentVersion)
	}
}
