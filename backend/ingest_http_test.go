package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"backend/db"
)

func TestIngestHandlerEndToEnd(t *testing.T) {
	dir := t.TempDir()

	// credential store (frontend-owned user.db)
	credPath := filepath.Join(dir, "user.db")
	w, err := sql.Open("sqlite", "file:"+credPath+"?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	w.Exec(`CREATE TABLE users (id TEXT PRIMARY KEY, api_key TEXT)`)
	sum := sha256.Sum256([]byte("oa-abc"))
	w.Exec(`INSERT INTO users (id, api_key) VALUES (?, ?)`, "u1", hex.EncodeToString(sum[:]))
	creds := newCredStore(credPath)
	if _, err := creds.handle(); err != nil {
		t.Fatal(err)
	}
	defer creds.Close()

	// logs repo
	repo, err := db.NewSQLiteRepository(filepath.Join(dir, "logs.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer repo.Close()

	h := makeIngestHandler(repo, creds)
	body := `{"traces":[{"model":"m","platform":"pip-library","conversation_id":"pip-xyz","messages":[
		{"role":"user","content":"hi"},{"role":"assistant","content":"hello"}]}]}`

	// valid key
	req := httptest.NewRequest("POST", "/api/ingest", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer oa-abc")
	rr := httptest.NewRecorder()
	h(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rr.Code, rr.Body)
	}
	var res struct {
		Saved int `json:"saved"`
	}
	json.Unmarshal(rr.Body.Bytes(), &res)
	if res.Saved != 1 {
		t.Fatalf("want saved=1, got %d", res.Saved)
	}

	// re-upload same conversation_id -> upsert, still 1 row for that convo
	req2 := httptest.NewRequest("POST", "/api/ingest", strings.NewReader(body))
	req2.Header.Set("Authorization", "Bearer oa-abc")
	rr2 := httptest.NewRecorder()
	h(rr2, req2)
	if rr2.Code != http.StatusOK {
		t.Fatalf("re-upload want 200, got %d", rr2.Code)
	}

	// bad key -> 401
	reqBad := httptest.NewRequest("POST", "/api/ingest", strings.NewReader(body))
	reqBad.Header.Set("Authorization", "Bearer oa-wrong")
	rrBad := httptest.NewRecorder()
	h(rrBad, reqBad)
	if rrBad.Code != http.StatusUnauthorized {
		t.Fatalf("bad key want 401, got %d", rrBad.Code)
	}

	// missing key -> 401
	reqNo := httptest.NewRequest("POST", "/api/ingest", strings.NewReader(body))
	rrNo := httptest.NewRecorder()
	h(rrNo, reqNo)
	if rrNo.Code != http.StatusUnauthorized {
		t.Fatalf("missing key want 401, got %d", rrNo.Code)
	}
}
