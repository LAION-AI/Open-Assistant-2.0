package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"path/filepath"
	"testing"
)

// Replicates production: frontend keeps user.db open in WAL mode (single writer)
// while the backend opens a read-only view to verify keys.
func TestCredStoreReadOnlyWAL(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "user.db")

	writer, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)")
	if err != nil { t.Fatal(err) }
	defer writer.Close()
	if _, err := writer.Exec(`CREATE TABLE users (id TEXT PRIMARY KEY, api_key TEXT)`); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("oa-secret-key"))
	if _, err := writer.Exec(`INSERT INTO users (id, api_key) VALUES (?, ?)`, "user-42", hex.EncodeToString(sum[:])); err != nil {
		t.Fatal(err)
	}

	// Writer stays open (as the frontend would). Open read-only reader.
	creds, err := openCredStore(path)
	if err != nil { t.Fatalf("read-only open of live WAL db failed: %v", err) }
	defer creds.db.Close()

	id, ok := creds.userIDForKey("oa-secret-key")
	if !ok || id != "user-42" {
		t.Fatalf("expected user-42, got %q ok=%v", id, ok)
	}
	if _, ok := creds.userIDForKey("oa-wrong"); ok {
		t.Fatalf("unknown key must not resolve")
	}
}
