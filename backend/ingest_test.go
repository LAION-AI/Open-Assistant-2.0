package main

import (
	"crypto/sha256"
	"encoding/hex"
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
