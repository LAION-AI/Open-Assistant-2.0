package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"

	_ "modernc.org/sqlite" // Pure Go SQLite driver
)

// SQL predicates for the platform-based categories. Uploaded traces are marked
// with a `trace:` prefix; web chat is empty/"chat"; everything else is V1 proxy.
const (
	chatPredicate  = "(platform IS NULL OR platform = '' OR platform = 'chat')"
	tracePredicate = "(platform = 'trace' OR platform LIKE 'trace:%')"
)

func categoryPredicate(category string) string {
	switch category {
	case "chat":
		return chatPredicate
	case "trace":
		return tracePredicate
	case "v1":
		return "NOT (" + chatPredicate + " OR " + tracePredicate + ")"
	default:
		return ""
	}
}

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
		platform TEXT,
		prompt TEXT,
		response TEXT,
		tokens INTEGER,
		created_at INTEGER
	);`
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}

	// Migrate older databases that predate these columns. The errors are ignored
	// because "duplicate column name" is expected once a migration is applied.
	_, _ = db.Exec(`ALTER TABLE interaction_logs ADD COLUMN conversation_id TEXT`)
	_, _ = db.Exec(`ALTER TABLE interaction_logs ADD COLUMN platform TEXT`)

	// Collapse redundant per-turn rows: keep only the latest (superset) row for
	// each conversation. Idempotent — a no-op once conversations are single-row.
	_, _ = db.Exec(`DELETE FROM interaction_logs
		WHERE conversation_id IS NOT NULL AND conversation_id != ''
		AND id NOT IN (
			SELECT MAX(id) FROM interaction_logs
			WHERE conversation_id IS NOT NULL AND conversation_id != ''
			GROUP BY user_id, conversation_id
		)`)

	return &SQLiteRepository{db: db}, nil
}

func (r *SQLiteRepository) SaveLog(ctx context.Context, entry *LogEntry) error {
	query := `INSERT INTO interaction_logs (user_id, conversation_id, platform, prompt, response, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
	// Store as TEXT (string) to keep the column's TEXT affinity.
	_, err := r.db.ExecContext(ctx, query, entry.UserID, entry.ConversationID, entry.Platform, string(entry.Prompt), string(entry.Response), entry.Tokens, entry.CreatedAt)
	return err
}

func (r *SQLiteRepository) UpsertLog(ctx context.Context, entry *LogEntry) error {
	// No conversation id (e.g. anonymous): fall back to a plain insert.
	if entry.ConversationID == "" {
		return r.SaveLog(ctx, entry)
	}
	res, err := r.db.ExecContext(ctx,
		`UPDATE interaction_logs SET platform = ?, prompt = ?, response = ?, tokens = ?, created_at = ? WHERE user_id = ? AND conversation_id = ?`,
		entry.Platform, string(entry.Prompt), string(entry.Response), entry.Tokens, entry.CreatedAt, entry.UserID, entry.ConversationID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return r.SaveLog(ctx, entry)
	}
	return nil
}

func (r *SQLiteRepository) GetLogs(ctx context.Context) ([]*LogEntry, error) {
	query := `SELECT id, user_id, COALESCE(conversation_id, ''), COALESCE(platform, ''), prompt, response, tokens, created_at FROM interaction_logs ORDER BY created_at DESC`
	return r.queryLogs(ctx, query)
}

func (r *SQLiteRepository) GetLogsByUser(ctx context.Context, userID string) ([]*LogEntry, error) {
	query := `SELECT id, user_id, COALESCE(conversation_id, ''), COALESCE(platform, ''), prompt, response, tokens, created_at FROM interaction_logs WHERE user_id = ? ORDER BY created_at DESC`
	return r.queryLogs(ctx, query, userID)
}

func (r *SQLiteRepository) GetLogsPaged(ctx context.Context, userID, category string, limit, offset int) ([]*LogEntry, int, error) {
	var conds []string
	var args []interface{}
	if userID != "" {
		conds = append(conds, "user_id = ?")
		args = append(args, userID)
	}
	if pred := categoryPredicate(category); pred != "" {
		conds = append(conds, pred)
	}
	where := ""
	if len(conds) > 0 {
		where = " WHERE " + strings.Join(conds, " AND ")
	}

	var total int
	if err := r.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM interaction_logs"+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	query := "SELECT id, user_id, COALESCE(conversation_id, ''), COALESCE(platform, ''), prompt, response, tokens, created_at FROM interaction_logs" +
		where + " ORDER BY created_at DESC"
	if limit > 0 {
		query += " LIMIT ? OFFSET ?"
		args = append(args, limit, offset)
	}

	logs, err := r.queryLogs(ctx, query, args...)
	if err != nil {
		return nil, 0, err
	}
	if logs == nil {
		logs = []*LogEntry{}
	}
	return logs, total, nil
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
		var prompt, response string
		if err := rows.Scan(&entry.ID, &entry.UserID, &entry.ConversationID, &entry.Platform, &prompt, &response, &entry.Tokens, &entry.CreatedAt); err != nil {
			return nil, err
		}
		// Embed stored text as nested JSON (legacy/non-JSON values are wrapped).
		entry.Prompt = ToRawJSON([]byte(prompt))
		entry.Response = ToRawJSON([]byte(response))
		entries = append(entries, &entry)
	}
	return entries, nil
}

func (r *SQLiteRepository) DeleteByConversation(ctx context.Context, userID, conversationID string) (int64, error) {
	res, err := r.db.ExecContext(ctx,
		`DELETE FROM interaction_logs WHERE user_id = ? AND conversation_id = ?`, userID, conversationID)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

func (r *SQLiteRepository) DeleteByID(ctx context.Context, userID string, id int64) (int64, error) {
	res, err := r.db.ExecContext(ctx,
		`DELETE FROM interaction_logs WHERE user_id = ? AND id = ?`, userID, id)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

func (r *SQLiteRepository) UpdateContent(ctx context.Context, userID, conversationID string, prompt, response json.RawMessage, tokens int) (int64, error) {
	res, err := r.db.ExecContext(ctx,
		`UPDATE interaction_logs SET prompt = ?, response = ?, tokens = ? WHERE user_id = ? AND conversation_id = ?`,
		string(prompt), string(response), tokens, userID, conversationID)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

func (r *SQLiteRepository) Close() error {
	return r.db.Close()
}
