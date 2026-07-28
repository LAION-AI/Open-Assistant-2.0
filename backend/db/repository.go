package db

import (
	"context"
	"encoding/json"
)

type LogEntry struct {
	ID             int64           `json:"id"`
	UserID         string          `json:"userId"`
	ConversationID string          `json:"conversationId"`
	Platform       string          `json:"platform"` // "chat" or the external tool (claude-code, opencode, …)
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

type FeedbackEntry struct {
	ID         int64  `json:"id"`
	UserID     string `json:"userId"`
	Message    string `json:"message"`
	Category   string `json:"category"`
	Status     string `json:"status"` // "open" | "done"
	CreatedAt  int64  `json:"createdAt"`
	ResolvedAt int64  `json:"resolvedAt"`
}

type LeaderboardEntry struct {
	UserID      string `json:"userId"`
	TotalTokens int64  `json:"totalTokens"`
	TotalTraces int64  `json:"totalTraces"`
}

// LogRepository defines the database adapter contract
type LogRepository interface {
	SaveLog(ctx context.Context, entry *LogEntry) error
	// UpsertLog keeps a single row per (user, conversation): later turns replace
	// the row rather than appending a redundant superset of the prior history.
	UpsertLog(ctx context.Context, entry *LogEntry) error
	GetLogs(ctx context.Context) ([]*LogEntry, error)
	GetLogsByUser(ctx context.Context, userID string) ([]*LogEntry, error)
	// GetLogsPaged returns a page of rows filtered by user (optional) and category
	// ("all"|"chat"|"v1"|"trace"), plus the total count for that filter. limit<=0
	// returns all rows.
	GetLogsPaged(ctx context.Context, userID, category string, limit, offset int) ([]*LogEntry, int, error)
	// DeleteByConversation removes all rows of a conversation owned by the user.
	DeleteByConversation(ctx context.Context, userID, conversationID string) (int64, error)
	// DeleteByID removes a single owned log row.
	DeleteByID(ctx context.Context, userID string, id int64) (int64, error)
	// DeleteAllByUser removes every row a user has contributed. Used by the
	// self-service "delete my data" and account-deletion paths, where leaving a
	// single row behind would make the erasure a lie.
	DeleteAllByUser(ctx context.Context, userID string) (int64, error)
	UpdateContent(ctx context.Context, userID, conversationID string, prompt, response json.RawMessage, tokens int) (int64, error)
	// UpdateContentByID rewrites the prompt/response/tokens of a single log row by ID.
	UpdateContentByID(ctx context.Context, userID string, id int64, prompt, response json.RawMessage, tokens int) (int64, error)

	// Feedback
	SaveFeedback(ctx context.Context, entry *FeedbackEntry) error
	GetFeedback(ctx context.Context, status string) ([]*FeedbackEntry, error)
	UpdateFeedbackStatus(ctx context.Context, id int64, status string) (int64, error)

	// Leaderboard: aggregate per-user token totals and trace counts.
	GetLeaderboard(ctx context.Context) ([]*LeaderboardEntry, error)

	Close() error
}
