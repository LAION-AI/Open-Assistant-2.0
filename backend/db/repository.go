package db

import (
	"context"
	"encoding/json"
)

type LogEntry struct {
	ID             int64           `json:"id"`
	UserID         string          `json:"userId"`
	ConversationID string          `json:"conversationId"`
	Prompt         json.RawMessage `json:"prompt"`
	Response       json.RawMessage `json:"response"`
	Tokens         int             `json:"tokens"`
	CreatedAt      int64           `json:"createdAt"`
}

// ToRawJSON returns valid JSON for storage/serialization: the bytes as-is when
// they are already valid JSON, otherwise the value wrapped as a JSON string.
// Guarantees the value can be embedded as nested JSON without marshal errors.
func ToRawJSON(b []byte) json.RawMessage {
	if len(b) == 0 {
		return json.RawMessage("null")
	}
	if json.Valid(b) {
		return json.RawMessage(b)
	}
	quoted, err := json.Marshal(string(b))
	if err != nil {
		return json.RawMessage("null")
	}
	return json.RawMessage(quoted)
}

// LogRepository defines the database adapter contract
type LogRepository interface {
	SaveLog(ctx context.Context, entry *LogEntry) error
	// UpsertLog keeps a single row per (user, conversation): later turns replace
	// the row rather than appending a redundant superset of the prior history.
	UpsertLog(ctx context.Context, entry *LogEntry) error
	GetLogs(ctx context.Context) ([]*LogEntry, error)
	GetLogsByUser(ctx context.Context, userID string) ([]*LogEntry, error)
	Close() error
}
