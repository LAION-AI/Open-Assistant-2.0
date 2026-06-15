package db

import (
	"context"
	"database/sql"
	_ "modernc.org/sqlite" // Pure Go SQLite driver
)

type SQLiteRepository struct {
	db *sql.DB
}

func NewSQLiteRepository(dbPath string) (*SQLiteRepository, error) {
	// Enable WAL mode and busy timeout natively via connection string
	db, err := sql.Open("sqlite", dbPath+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}

	// Ensure table exists
	schema := `CREATE TABLE IF NOT EXISTS interaction_logs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id TEXT,
		conversation_id TEXT,
		prompt TEXT,
		response TEXT,
		tokens INTEGER,
		created_at INTEGER
	);`
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}

	// Migrate older databases that predate the conversation_id column. The error
	// is ignored because it's expected ("duplicate column name") once applied.
	_, _ = db.Exec(`ALTER TABLE interaction_logs ADD COLUMN conversation_id TEXT`)

	return &SQLiteRepository{db: db}, nil
}

func (r *SQLiteRepository) SaveLog(ctx context.Context, entry *LogEntry) error {
	query := `INSERT INTO interaction_logs (user_id, conversation_id, prompt, response, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)`
	_, err := r.db.ExecContext(ctx, query, entry.UserID, entry.ConversationID, entry.Prompt, entry.Response, entry.Tokens, entry.CreatedAt)
	return err
}

func (r *SQLiteRepository) GetLogs(ctx context.Context) ([]*LogEntry, error) {
	query := `SELECT id, user_id, COALESCE(conversation_id, ''), prompt, response, tokens, created_at FROM interaction_logs ORDER BY created_at DESC`
	return r.queryLogs(ctx, query)
}

func (r *SQLiteRepository) GetLogsByUser(ctx context.Context, userID string) ([]*LogEntry, error) {
	query := `SELECT id, user_id, COALESCE(conversation_id, ''), prompt, response, tokens, created_at FROM interaction_logs WHERE user_id = ? ORDER BY created_at DESC`
	return r.queryLogs(ctx, query, userID)
}

func (r *SQLiteRepository) queryLogs(ctx context.Context, query string, args ...interface{}) ([]*LogEntry, error) {
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []*LogEntry
	for rows.Next() {
		var entry LogEntry
		if err := rows.Scan(&entry.ID, &entry.UserID, &entry.ConversationID, &entry.Prompt, &entry.Response, &entry.Tokens, &entry.CreatedAt); err != nil {
			return nil, err
		}
		entries = append(entries, &entry)
	}
	return entries, nil
}

func (r *SQLiteRepository) Close() error {
	return r.db.Close()
}
