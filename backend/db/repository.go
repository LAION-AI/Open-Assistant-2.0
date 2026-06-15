package db

import "context"

type LogEntry struct {
	ID             int64  `json:"id"`
	UserID         string `json:"userId"`
	ConversationID string `json:"conversationId"`
	Prompt         string `json:"prompt"`
	Response       string `json:"response"`
	Tokens         int    `json:"tokens"`
	CreatedAt      int64  `json:"createdAt"`
}

// LogRepository defines the database adapter contract
type LogRepository interface {
	SaveLog(ctx context.Context, entry *LogEntry) error
	GetLogs(ctx context.Context) ([]*LogEntry, error)
	GetLogsByUser(ctx context.Context, userID string) ([]*LogEntry, error)
	Close() error
}
