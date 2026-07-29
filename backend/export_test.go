package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"backend/db"
)

// The property under test throughout this file: a contributor who has not
// consented, or whose consent predates the current document version, must never
// appear in an export — regardless of how the export is invoked.

func logEntry(userID, conv string) *db.LogEntry {
	return &db.LogEntry{
		UserID:         userID,
		ConversationID: conv,
		Platform:       "chat",
		Prompt:         json.RawMessage(`{"role":"user","content":"hello"}`),
		Response:       json.RawMessage(`{"role":"assistant","content":"hi"}`),
		Tokens:         10,
		CreatedAt:      1700000000,
	}
}

func TestBuildExportKeepsOnlyConsentingContributors(t *testing.T) {
	logs := []*db.LogEntry{
		logEntry("yes-user", "c1"),
		logEntry("no-user", "c2"),
		logEntry("yes-user", "c3"),
		logEntry("never-asked", "c4"),
		nil, // a nil row must not panic the release pipeline
	}
	consented := map[string]bool{"yes-user": true}

	rows := buildExport(logs, consented, "1.0")

	if len(rows) != 2 {
		t.Fatalf("expected 2 exported rows, got %d", len(rows))
	}
	dropped := map[string]bool{conversationRef("c2"): true, conversationRef("c4"): true}
	for _, r := range rows {
		if dropped[r.ConversationID] {
			t.Fatalf("non-consenting contributor leaked into the export: %+v", r)
		}
		if r.ConsentVersion != "1.0" {
			t.Errorf("row is missing the consent version it was released under: %+v", r)
		}
	}
}

func TestExportNeverCarriesAccountIdentifiers(t *testing.T) {
	// A conversation id from an imported trace, carrying a local path.
	rows := buildExport([]*db.LogEntry{logEntry("secret-account-id", "/Users/someone/private-project")},
		map[string]bool{"secret-account-id": true}, "1.0")

	blob, err := json.Marshal(rows)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(blob), "secret-account-id") {
		t.Fatalf("serialised export contains the raw account id: %s", blob)
	}
	if strings.Contains(string(blob), "private-project") {
		t.Fatalf("serialised export contains the raw conversation id: %s", blob)
	}
	if rows[0].ParticipantID == "" || rows[0].ParticipantID == "secret-account-id" {
		t.Fatalf("participant id is not pseudonymous: %q", rows[0].ParticipantID)
	}
}

func TestInstanceIDIdentifiesExactlyOneRow(t *testing.T) {
	// The post-release withdrawal route depends on this: a reporter quotes the
	// instance id, and it has to resolve to one row and keep resolving to it.
	if instanceRef(42) != instanceRef(42) {
		t.Error("instance id is not stable for the same row")
	}
	if instanceRef(42) == instanceRef(43) {
		t.Error("two rows collided onto the same instance id")
	}
	rows := buildExport([]*db.LogEntry{{ID: 7, UserID: "u1", ConversationID: "c1"}},
		map[string]bool{"u1": true}, "1.0")
	if rows[0].InstanceID != instanceRef(7) {
		t.Fatalf("exported instance id %q does not match the row it came from", rows[0].InstanceID)
	}
	if strings.Contains(rows[0].InstanceID, "7") && len(rows[0].InstanceID) < 8 {
		t.Error("instance id looks like a bare row id rather than a pseudonym")
	}
}

func TestParticipantIDIsStableAndDistinct(t *testing.T) {
	// Stable, so a contributor's rows stay linkable within and across releases.
	if participantID("u1") != participantID("u1") {
		t.Error("participant id is not stable for the same user")
	}
	if participantID("u1") == participantID("u2") {
		t.Error("different users collided onto the same participant id")
	}
}

// --- consent lookup against a real user.db ---------------------------------

func writeUserDB(t *testing.T, rows [][3]any) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "user.db")
	h, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer h.Close()
	if _, err := h.Exec(`CREATE TABLE users (
		id TEXT PRIMARY KEY,
		dataset_consent INTEGER NOT NULL DEFAULT 0,
		dataset_consent_version TEXT
	)`); err != nil {
		t.Fatalf("create: %v", err)
	}
	for _, r := range rows {
		if _, err := h.Exec(
			`INSERT INTO users (id, dataset_consent, dataset_consent_version) VALUES (?, ?, ?)`,
			r[0], r[1], r[2]); err != nil {
			t.Fatalf("insert: %v", err)
		}
	}
	return path
}

func TestConsentedUserIDsRequiresCurrentVersion(t *testing.T) {
	path := writeUserDB(t, [][3]any{
		{"granted-current", 1, "1.0"},
		{"granted-stale", 1, "0.9"}, // consented to a document that has since changed
		{"declined", 0, "1.0"},
		{"never-asked", 0, nil},
	})
	creds := newCredStore(path)
	defer creds.Close()

	ids, err := creds.consentedUserIDs("1.0")
	if err != nil {
		t.Fatalf("consentedUserIDs: %v", err)
	}
	if !ids["granted-current"] {
		t.Error("a current consent was not honoured")
	}
	for _, id := range []string{"granted-stale", "declined", "never-asked"} {
		if ids[id] {
			t.Errorf("%s must not count as consenting", id)
		}
	}
}

// --- HTTP surface -----------------------------------------------------------

type fakeRepo struct {
	db.LogRepository
	logs []*db.LogEntry
}

func (f *fakeRepo) GetLogs(_ context.Context) ([]*db.LogEntry, error) { return f.logs, nil }

func TestExportHandlerRequiresConsentVersion(t *testing.T) {
	creds := newCredStore(writeUserDB(t, [][3]any{{"u1", 1, "1.0"}}))
	defer creds.Close()

	rec := httptest.NewRecorder()
	makeExportHandler(&fakeRepo{logs: []*db.LogEntry{logEntry("u1", "c1")}}, creds)(
		rec, httptest.NewRequest(http.MethodGet, "/api/export", nil))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("export without a consent version should be refused, got %d", rec.Code)
	}
}

func TestExportHandlerEmitsOnlyConsentingRows(t *testing.T) {
	creds := newCredStore(writeUserDB(t, [][3]any{
		{"yes", 1, "1.0"},
		{"no", 0, "1.0"},
	}))
	defer creds.Close()

	repo := &fakeRepo{logs: []*db.LogEntry{
		logEntry("yes", "keep"),
		logEntry("no", "drop"),
	}}

	rec := httptest.NewRecorder()
	makeExportHandler(repo, creds)(rec,
		httptest.NewRequest(http.MethodGet, "/api/export?consentVersion=1.0", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, conversationRef("keep")) {
		t.Error("consenting contributor's row is missing from the export")
	}
	if strings.Contains(body, conversationRef("drop")) {
		t.Fatalf("non-consenting contributor's row was exported: %s", body)
	}
	if got := rec.Header().Get("X-Export-Rows"); got != "1" {
		t.Errorf("X-Export-Rows = %q, want \"1\"", got)
	}
}

func TestExportHandlerWithNoConsentExportsNothing(t *testing.T) {
	creds := newCredStore(writeUserDB(t, [][3]any{{"no", 0, "1.0"}}))
	defer creds.Close()

	rec := httptest.NewRecorder()
	makeExportHandler(&fakeRepo{logs: []*db.LogEntry{logEntry("no", "c1")}}, creds)(
		rec, httptest.NewRequest(http.MethodGet, "/api/export?consentVersion=1.0", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if body := strings.TrimSpace(rec.Body.String()); body != "" {
		t.Fatalf("expected an empty export, got %q", body)
	}
}
