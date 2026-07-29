package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"backend/db"
)

// The property under test throughout this file: a contributor who has not
// consented, or whose consent predates the current document version, must never
// appear in an export — regardless of how the export is invoked.

// The fixtures use CreatedAt 1700000000; "now" for a test that wants those rows
// publishable is therefore well past the embargo.
func publishableNow() time.Time {
	return time.Unix(1700000000, 0).Add(PublicationEmbargo).Add(time.Hour)
}

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

	rows, _ := buildExport(logs, consented, "1.0", publishableNow())

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
	rows, _ := buildExport([]*db.LogEntry{logEntry("secret-account-id", "/Users/someone/private-project")},
		map[string]bool{"secret-account-id": true}, "1.0", publishableNow())

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
	rows, _ := buildExport([]*db.LogEntry{{ID: 7, UserID: "u1", ConversationID: "c1"}},
		map[string]bool{"u1": true}, "1.0", publishableNow())
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

// --- upload gate ------------------------------------------------------------

// writeAuthDB builds a user.db shaped like the frontend's, for the gate that
// keeps password-only accounts from uploading until they add a second factor.
func writeAuthDB(t *testing.T, twofa string, passkeys int) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "user.db")
	h, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer h.Close()
	h.Exec(`CREATE TABLE users (id TEXT PRIMARY KEY, api_key TEXT, twofa_method TEXT)`)
	h.Exec(`CREATE TABLE credentials (id TEXT PRIMARY KEY, user_id TEXT)`)
	if twofa == "" {
		h.Exec(`INSERT INTO users (id, twofa_method) VALUES ('u1', NULL)`)
	} else {
		h.Exec(`INSERT INTO users (id, twofa_method) VALUES ('u1', ?)`, twofa)
	}
	for i := 0; i < passkeys; i++ {
		h.Exec(`INSERT INTO credentials (id, user_id) VALUES (?, 'u1')`, "cred-"+strconv.Itoa(i))
	}
	return path
}

func TestUploadGate(t *testing.T) {
	cases := []struct {
		name     string
		twofa    string
		passkeys int
		want     bool
	}{
		{"password only, no second factor", "", 0, false},
		{"password with TOTP", "totp", 0, true},
		{"password with email codes", "email", 0, true},
		{"passkey, already multi-factor", "", 1, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			creds := newCredStore(writeAuthDB(t, tc.twofa, tc.passkeys))
			defer creds.Close()
			if got := creds.uploadAllowed("u1"); got != tc.want {
				t.Errorf("uploadAllowed = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestUploadGateFailsClosedOnAnUnreadableStore(t *testing.T) {
	// A store we cannot read must not become an open door.
	creds := newCredStore(filepath.Join(t.TempDir(), "does-not-exist.db"))
	defer creds.Close()
	if creds.uploadAllowed("u1") {
		t.Error("gate opened when the credential store could not be read")
	}
}

// --- publication embargo ----------------------------------------------------

func TestEmbargoHoldsBackYoungInstances(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	old := now.Add(-PublicationEmbargo).Add(-time.Hour) // just past the embargo
	fresh := now.Add(-time.Hour)                        // uploaded an hour ago

	logs := []*db.LogEntry{
		{ID: 1, UserID: "u1", ConversationID: "old", CreatedAt: old.Unix()},
		{ID: 2, UserID: "u1", ConversationID: "fresh", CreatedAt: fresh.Unix()},
	}

	rows, embargoed := buildExport(logs, map[string]bool{"u1": true}, "1.0", now)

	if len(rows) != 1 {
		t.Fatalf("expected exactly the aged row, got %d", len(rows))
	}
	if rows[0].InstanceID != instanceRef(1) {
		t.Error("the wrong row survived the embargo")
	}
	if embargoed != 1 {
		t.Errorf("embargoed count = %d, want 1", embargoed)
	}
}

func TestEmbargoBoundaryIsInclusive(t *testing.T) {
	// A row exactly at the cutoff has served its 30 days and is publishable;
	// one second younger is not. Worth pinning: this is the line a contributor
	// relies on when they delete something on day 29.
	now := time.Unix(1_800_000_000, 0)
	at := now.Add(-PublicationEmbargo).Unix()

	rows, _ := buildExport([]*db.LogEntry{{ID: 1, UserID: "u1", CreatedAt: at}},
		map[string]bool{"u1": true}, "1.0", now)
	if len(rows) != 1 {
		t.Error("a row that has served the full embargo was withheld")
	}

	rows, _ = buildExport([]*db.LogEntry{{ID: 1, UserID: "u1", CreatedAt: at + 1}},
		map[string]bool{"u1": true}, "1.0", now)
	if len(rows) != 0 {
		t.Error("a row one second short of the embargo was published")
	}
}

func TestEmbargoIsThirtyDays(t *testing.T) {
	// The terms and the privacy policy both promise 30 days by name. If this
	// constant changes, those documents are wrong and must change with it.
	if days := int(PublicationEmbargo.Hours() / 24); days != 30 {
		t.Fatalf("embargo is %d days; the legal documents say 30", days)
	}
}
