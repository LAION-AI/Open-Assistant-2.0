package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"backend/db"
)

type ProxyHandler struct {
	Repo db.LogRepository
}

func NewProxyHandler(repo db.LogRepository) *ProxyHandler {
	return &ProxyHandler{Repo: repo}
}

type ChatMessage struct {
	Role    string      `json:"role"`
	Content interface{} `json:"content"` // Content can be string or array (for images)
}

type ChatRequest struct {
	Model    string        `json:"model"`
	Messages []ChatMessage `json:"messages"`
	Stream   bool          `json:"stream"`
}

type StreamDelta struct {
	Role             string `json:"role"`
	Content          string `json:"content"`
	ReasoningContent string `json:"reasoning_content"`
}

type StreamChoice struct {
	Delta StreamDelta `json:"delta"`
}

type StreamChunk struct {
	Choices []StreamChoice `json:"choices"`
}

type NonStreamChoice struct {
	Message ChatMessage `json:"message"`
}

type NonStreamResponse struct {
	Choices []NonStreamChoice `json:"choices"`
}

func (h *ProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// CORS headers
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-User-Id, X-Conversation-Id, X-BYOE-Url, X-BYOE-Key, X-BYOE-Model")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	userId := r.Header.Get("X-User-Id")
	if userId == "" {
		userId = "anonymous"
	}

	// Conversation id groups all turns of one chat together (logging only; not
	// forwarded upstream to the model).
	conversationId := r.Header.Get("X-Conversation-Id")

	// Read and parse request body to extract the prompt for logging
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read request body", http.StatusInternalServerError)
		return
	}
	r.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))

	var chatReq ChatRequest
	if err := json.Unmarshal(bodyBytes, &chatReq); err != nil {
		log.Printf("Warning: failed to parse request payload: %v", err)
	}


	// Determine upstream URL and API Key
	byoeUrl := r.Header.Get("X-BYOE-Url")
	byoeKey := r.Header.Get("X-BYOE-Key")
	byoeModel := r.Header.Get("X-BYOE-Model")

	upstreamUrl := "https://api.openai.com/v1/chat/completions"
	apiKey := ""
	overrideModel := ""

	// A custom endpoint URL is enough to route as BYOE; the key is optional for
	// local servers that don't require auth.
	if byoeUrl != "" {
		// Clean up custom URL
		byoeUrl = strings.TrimSuffix(byoeUrl, "/")
		if !strings.HasSuffix(byoeUrl, "/chat/completions") {
			if strings.HasSuffix(byoeUrl, "/v1") {
				upstreamUrl = byoeUrl + "/chat/completions"
			} else {
				upstreamUrl = byoeUrl + "/v1/chat/completions"
			}
		} else {
			upstreamUrl = byoeUrl
		}
		apiKey = byoeKey
		overrideModel = byoeModel
	}

	// The body sent upstream strips reasoning_content (kept only in our logs so
	// every turn's reasoning survives) and applies any BYOE model override,
	// without dropping other request params. The original bodyBytes is logged.
	upstreamBytes := buildUpstreamBody(bodyBytes, overrideModel)

	req, err := http.NewRequestWithContext(r.Context(), "POST", upstreamUrl, bytes.NewBuffer(upstreamBytes))
	if err != nil {
		http.Error(w, "Failed to create upstream request", http.StatusInternalServerError)
		return
	}

	// Copy headers
	req.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	} else {
		// Fallback to server environment key
		req.Header.Set("Authorization", r.Header.Get("Authorization"))
	}

	// Long reasoning responses can stream for a while; allow up to 180s.
	client := &http.Client{Timeout: 180 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("Error targeting upstream completions: %v", err)
		http.Error(w, fmt.Sprintf("Upstream completions error: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Handle response
	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)

	if resp.StatusCode != http.StatusOK {
		// Stream error directly back
		io.Copy(w, resp.Body)
		return
	}

	if chatReq.Stream {
		handleStream(w, resp.Body, h.Repo, userId, conversationId, string(bodyBytes))
	} else {
		handleNonStream(w, resp.Body, h.Repo, userId, conversationId, string(bodyBytes))
	}
}

// buildUpstreamBody returns a request body for the model: reasoning_content is
// removed from each message (we only keep it in our own logs), and the model is
// overridden when provided. Other top-level params are preserved. Falls back to
// the original body if it isn't valid JSON.
func buildUpstreamBody(body []byte, overrideModel string) []byte {
	var m map[string]interface{}
	if err := json.Unmarshal(body, &m); err != nil {
		return body
	}
	if msgs, ok := m["messages"].([]interface{}); ok {
		for _, x := range msgs {
			if msg, ok := x.(map[string]interface{}); ok {
				delete(msg, "reasoning_content")
			}
		}
	}
	if overrideModel != "" {
		m["model"] = overrideModel
	}
	out, err := json.Marshal(m)
	if err != nil {
		return body
	}
	return out
}

func handleStream(w http.ResponseWriter, body io.Reader, repo db.LogRepository, userId string, conversationId string, promptRawJson string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		log.Println("ResponseWriter is not http.Flusher, fallback to basic writing")
	}

	var contentBuilder strings.Builder
	var reasoningBuilder strings.Builder
	reader := bufio.NewReader(body)

	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			if err != io.EOF {
				log.Printf("Stream read error: %v", err)
			}
			break
		}

		// Write to client immediately
		w.Write(line)
		if ok {
			flusher.Flush()
		}

		// Parse the SSE chunk to accumulate the final response text
		strLine := strings.TrimSpace(string(line))
		if strings.HasPrefix(strLine, "data: ") {
			dataStr := strings.TrimPrefix(strLine, "data: ")
			if dataStr == "[DONE]" {
				continue
			}

			var chunk StreamChunk
			if err := json.Unmarshal([]byte(dataStr), &chunk); err == nil {
				if len(chunk.Choices) > 0 {
					contentBuilder.WriteString(chunk.Choices[0].Delta.Content)
					reasoningBuilder.WriteString(chunk.Choices[0].Delta.ReasoningContent)
				}
			}
		}
	}

	// Log interaction asynchronously in a goroutine
	go func() {
		contentStr := contentBuilder.String()
		reasoningStr := reasoningBuilder.String()

		// Create v1 assistant message JSON
		logResponseObj := map[string]interface{}{
			"role":              "assistant",
			"content":           contentStr,
			"reasoning_content": reasoningStr,
		}
		responseJsonBytes, err := json.Marshal(logResponseObj)
		if err != nil {
			log.Printf("Error marshalling log response: %v", err)
			return
		}

		// Token estimation (1 token per 4 chars)
		promptTokens := len(promptRawJson) / 4
		completionTokens := (len(contentStr) + len(reasoningStr)) / 4
		totalTokens := promptTokens + completionTokens

		err = repo.UpsertLog(context.Background(), &db.LogEntry{
			UserID:         userId,
			ConversationID: conversationId,
			Prompt:         db.ToRawJSON([]byte(promptRawJson)),
			Response:       db.ToRawJSON(responseJsonBytes),
			Tokens:         totalTokens,
			CreatedAt:      time.Now().Unix(),
		})
		if err != nil {
			log.Printf("Error saving interaction log to SQLite: %v", err)
		} else {
			log.Printf("Logged stream interaction: user=%s, conv=%s, tokens=%d", userId, conversationId, totalTokens)
		}
	}()
}

func handleNonStream(w http.ResponseWriter, body io.Reader, repo db.LogRepository, userId string, conversationId string, promptRawJson string) {
	respBytes, err := io.ReadAll(body)
	if err != nil {
		log.Printf("Error reading non-stream response: %v", err)
		return
	}

	w.Write(respBytes)

	// Log interaction asynchronously in a goroutine
	go func() {
		var respObj struct {
			Choices []struct {
				Message struct {
					Role             string `json:"role"`
					Content          string `json:"content"`
					ReasoningContent string `json:"reasoning_content"`
				} `json:"message"`
			} `json:"choices"`
		}

		if err := json.Unmarshal(respBytes, &respObj); err == nil && len(respObj.Choices) > 0 {
			msg := respObj.Choices[0].Message
			responseJsonBytes, err := json.Marshal(msg)
			if err != nil {
				log.Printf("Error marshalling non-stream response log: %v", err)
				return
			}

			promptTokens := len(promptRawJson) / 4
			completionTokens := (len(msg.Content) + len(msg.ReasoningContent)) / 4
			totalTokens := promptTokens + completionTokens

			err = repo.UpsertLog(context.Background(), &db.LogEntry{
				UserID:         userId,
				ConversationID: conversationId,
				Prompt:         db.ToRawJSON([]byte(promptRawJson)),
				Response:       db.ToRawJSON(responseJsonBytes),
				Tokens:         totalTokens,
				CreatedAt:      time.Now().Unix(),
			})
			if err != nil {
				log.Printf("Error saving non-stream interaction log to SQLite: %v", err)
			}
		}
	}()
}


