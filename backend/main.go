package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"backend/db"
	"backend/proxy"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "logs.db"
	}

	// Initialize database
	repo, err := db.NewSQLiteRepository(dbPath)
	if err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer repo.Close()

	proxyHandler := proxy.NewProxyHandler(repo)

	mux := http.NewServeMux()

	// Chat completions endpoint
	mux.Handle("/v1/chat/completions", proxyHandler)
	mux.Handle("/v1beta/chat/completions", proxyHandler)

	// Health check endpoint
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	// Retrieve all interaction logs
	mux.HandleFunc("/api/logs", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Content-Type", "application/json")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Filters: ?userId= scopes to one user, ?category= (all|chat|v1|trace),
		// ?limit=&offset= paginate (limit<=0 returns all).
		q := r.URL.Query()
		userID := q.Get("userId")
		category := q.Get("category")
		limit, _ := strconv.Atoi(q.Get("limit"))
		offset, _ := strconv.Atoi(q.Get("offset"))

		logs, total, err := repo.GetLogsPaged(r.Context(), userID, category, limit, offset)
		if err != nil {
			log.Printf("Error getting logs: %v", err)
			http.Error(w, fmt.Sprintf("Error getting logs: %v", err), http.StatusInternalServerError)
			return
		}

		jsonBytes, err := json.Marshal(map[string]interface{}{
			"logs":   logs,
			"total":  total,
			"limit":  limit,
			"offset": offset,
		})
		if err != nil {
			log.Printf("Error marshalling logs: %v", err)
			http.Error(w, fmt.Sprintf("Error marshalling logs: %v", err), http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusOK)
		w.Write(jsonBytes)
	})

	// Delete a user's own logs (by conversation id or single row id). The Bun
	// server authenticates the session and supplies the trusted userId.
	mux.HandleFunc("/api/logs/delete", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Content-Type", "application/json")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var payload struct {
			UserID         string `json:"userId"`
			ConversationID string `json:"conversationId"`
			ID             int64  `json:"id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.UserID == "" {
			http.Error(w, "Invalid request payload", http.StatusBadRequest)
			return
		}

		var deleted int64
		var err error
		if payload.ConversationID != "" {
			deleted, err = repo.DeleteByConversation(r.Context(), payload.UserID, payload.ConversationID)
		} else if payload.ID != 0 {
			deleted, err = repo.DeleteByID(r.Context(), payload.UserID, payload.ID)
		} else {
			http.Error(w, "conversationId or id required", http.StatusBadRequest)
			return
		}
		if err != nil {
			log.Printf("Error deleting logs: %v", err)
			http.Error(w, fmt.Sprintf("Database error: %v", err), http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"success":true,"deleted":%d}`, deleted)
	})

	// Feedback: create / list / update status. Gated by the Bun layer.
	mux.HandleFunc("/api/feedback", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Content-Type", "application/json")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		if r.Method == http.MethodGet {
			items, err := repo.GetFeedback(r.Context(), r.URL.Query().Get("status"))
			if err != nil {
				http.Error(w, fmt.Sprintf("Error getting feedback: %v", err), http.StatusInternalServerError)
				return
			}
			jsonBytes, _ := json.Marshal(map[string]interface{}{"feedback": items})
			w.WriteHeader(http.StatusOK)
			w.Write(jsonBytes)
			return
		}

		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var payload struct {
			UserID   string `json:"userId"`
			Message  string `json:"message"`
			Category string `json:"category"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.Message == "" {
			http.Error(w, "Invalid request payload", http.StatusBadRequest)
			return
		}
		entry := &db.FeedbackEntry{
			UserID:    payload.UserID,
			Message:   payload.Message,
			Category:  payload.Category,
			Status:    "open",
			CreatedAt: time.Now().Unix(),
		}
		if err := repo.SaveFeedback(r.Context(), entry); err != nil {
			http.Error(w, fmt.Sprintf("Database error: %v", err), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"success":true}`))
	})

	// Update feedback status ("open" | "done").
	mux.HandleFunc("/api/feedback/update", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Content-Type", "application/json")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var payload struct {
			ID     int64  `json:"id"`
			Status string `json:"status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.ID == 0 {
			http.Error(w, "Invalid request payload", http.StatusBadRequest)
			return
		}
		if payload.Status != "open" && payload.Status != "done" {
			payload.Status = "done"
		}
		n, err := repo.UpdateFeedbackStatus(r.Context(), payload.ID, payload.Status)
		if err != nil {
			http.Error(w, fmt.Sprintf("Database error: %v", err), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"success":true,"updated":%d}`, n)
	})

	// Update a conversation's stored content (used by client-side redaction).
	mux.HandleFunc("/api/logs/update", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Content-Type", "application/json")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var payload struct {
			UserID         string `json:"userId"`
			ConversationID string `json:"conversationId"`
			LogID          int64  `json:"logId"`
			Prompt         string `json:"prompt"`
			Response       string `json:"response"`
			Tokens         int    `json:"tokens"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.UserID == "" {
			http.Error(w, "Invalid request payload", http.StatusBadRequest)
			return
		}

		var n int64
		var err error
		if payload.LogID > 0 {
			n, err = repo.UpdateContentByID(r.Context(), payload.UserID, payload.LogID,
				db.ToRawJSON([]byte(payload.Prompt)), db.ToRawJSON([]byte(payload.Response)), payload.Tokens)
		} else if payload.ConversationID != "" {
			n, err = repo.UpdateContent(r.Context(), payload.UserID, payload.ConversationID,
				db.ToRawJSON([]byte(payload.Prompt)), db.ToRawJSON([]byte(payload.Response)), payload.Tokens)
		} else {
			http.Error(w, "conversationId or logId required", http.StatusBadRequest)
			return
		}

		if err != nil {
			log.Printf("Error updating log content: %v", err)
			http.Error(w, fmt.Sprintf("Database error: %v", err), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"success":true,"updated":%d}`, n)
	})

	// Log an interaction directly (used for direct local completions bypassing the proxy)
	mux.HandleFunc("/api/log-interaction", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Content-Type", "application/json")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var payload struct {
			UserID         string `json:"userId"`
			ConversationID string `json:"conversationId"`
			Platform       string `json:"platform"`
			Prompt         string `json:"prompt"`
			Response       string `json:"response"`
			Tokens         int    `json:"tokens"`
		}

		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			http.Error(w, "Invalid request payload", http.StatusBadRequest)
			return
		}

		entry := &db.LogEntry{
			UserID:         payload.UserID,
			ConversationID: payload.ConversationID,
			Platform:       payload.Platform,
			Prompt:         db.ToRawJSON([]byte(payload.Prompt)),
			Response:       db.ToRawJSON([]byte(payload.Response)),
			Tokens:         payload.Tokens,
			CreatedAt:      time.Now().Unix(),
		}

		if err := repo.SaveLog(r.Context(), entry); err != nil {
			log.Printf("Error saving direct interaction log: %v", err)
			http.Error(w, fmt.Sprintf("Database error: %v", err), http.StatusInternalServerError)
			return
		}

		log.Printf("Direct interaction logged: user=%s, tokens=%d", payload.UserID, payload.Tokens)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"success":true}`))
	})

	// Leaderboard: per-user token totals and trace counts
	mux.HandleFunc("/api/leaderboard", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Content-Type", "application/json")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		entries, err := repo.GetLeaderboard(r.Context())
		if err != nil {
			log.Printf("Error getting leaderboard: %v", err)
			http.Error(w, fmt.Sprintf("Error getting leaderboard: %v", err), http.StatusInternalServerError)
			return
		}

		jsonBytes, err := json.Marshal(map[string]interface{}{
			"leaderboard": entries,
		})
		if err != nil {
			http.Error(w, "Error marshalling leaderboard", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write(jsonBytes)
	})

	log.Printf("🚀 Open Assistant 2.0 Go proxy backend starting on port %s...", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatalf("Server stopped: %v", err)
	}
}
