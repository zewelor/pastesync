package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed web/*
var webFS embed.FS

const (
	minCleanupInterval = 15 * time.Second
	maxCleanupInterval = 30 * time.Minute
	cleanupIntervalDiv = 288
)

type pasteSnapshot struct {
	Content  string `json:"content"`
	Revision uint64 `json:"revision"`
}

type pasteStore struct {
	mu        sync.RWMutex
	content   string
	revision  uint64
	updatedAt time.Time
	subs      map[chan pasteSnapshot]struct{}
}

func newPasteStore() *pasteStore {
	return &pasteStore{
		updatedAt: time.Now().UTC(),
		subs:      make(map[chan pasteSnapshot]struct{}),
	}
}

func (s *pasteStore) snapshotLocked() pasteSnapshot {
	return pasteSnapshot{
		Content:  s.content,
		Revision: s.revision,
	}
}

func (s *pasteStore) snapshot() pasteSnapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.snapshotLocked()
}

func (s *pasteStore) set(content string) pasteSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.content = content
	s.revision++
	s.updatedAt = time.Now().UTC()
	snapshot := s.snapshotLocked()
	s.broadcastLocked(snapshot)
	return snapshot
}

func (s *pasteStore) clearIfExpired(ttl time.Duration) (pasteSnapshot, bool) {
	if ttl <= 0 {
		return pasteSnapshot{}, false
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if time.Since(s.updatedAt) < ttl {
		return pasteSnapshot{}, false
	}
	if s.content == "" {
		s.updatedAt = time.Now().UTC()
		return pasteSnapshot{}, false
	}
	s.content = ""
	s.revision++
	s.updatedAt = time.Now().UTC()
	snapshot := s.snapshotLocked()
	s.broadcastLocked(snapshot)
	return snapshot, true
}

func (s *pasteStore) subscribe() (<-chan pasteSnapshot, func()) {
	ch := make(chan pasteSnapshot, 1)
	s.mu.Lock()
	s.subs[ch] = struct{}{}
	snapshot := s.snapshotLocked()
	s.mu.Unlock()
	ch <- snapshot
	return ch, func() {
		s.mu.Lock()
		delete(s.subs, ch)
		close(ch)
		s.mu.Unlock()
	}
}

func (s *pasteStore) broadcastLocked(snapshot pasteSnapshot) {
	for ch := range s.subs {
		select {
		case ch <- snapshot:
		default:
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- snapshot:
			default:
			}
		}
	}
}

type pastePayload struct {
	Content string `json:"content"`
}



type app struct {
	store           *pasteStore
	maxBodyBytes    int64
	ttl             time.Duration
	cleanupInterval time.Duration
}

func newApp(ttl, cleanupInterval time.Duration, maxBodyBytes int64) *app {
	return &app{
		store:           newPasteStore(),
		maxBodyBytes:    maxBodyBytes,
		ttl:             ttl,
		cleanupInterval: cleanupInterval,
	}
}

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", a.handleHealthz)

	mux.HandleFunc("GET /api/paste", a.handleGetPaste)
	mux.HandleFunc("PUT /api/paste", a.handlePutPaste)
	mux.HandleFunc("GET /api/events", a.handleEvents)
	mux.Handle("GET /{$}", noStore(fileServer("web/index.html", "text/html; charset=utf-8")))
	mux.Handle("GET /app.js", noStore(fileServer("web/app.js", "application/javascript; charset=utf-8")))
	mux.Handle("GET /favicon.ico", noStore(fileServer("web/favicon.ico", "image/x-icon")))
	mux.Handle("GET /favicon.svg", noStore(fileServer("web/favicon.svg", "image/svg+xml")))
	mux.Handle("GET /site.webmanifest", noStore(fileServer("web/site.webmanifest", "application/manifest+json; charset=utf-8")))
	mux.Handle("GET /android-chrome-192x192.png", noStore(fileServer("web/android-chrome-192x192.png", "image/png")))
	mux.Handle("GET /android-chrome-512x512.png", noStore(fileServer("web/android-chrome-512x512.png", "image/png")))
	mux.Handle("GET /maskable-icon-512x512.png", noStore(fileServer("web/maskable-icon-512x512.png", "image/png")))
	mux.Handle("GET /styles.css", noStore(fileServer("web/styles.css", "text/css; charset=utf-8")))
	return securityHeaders(requestLogger(mux))
}

func fileServer(name, contentType string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := webFS.ReadFile(name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", contentType)
		_, _ = w.Write(data)
	})
}

func noStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		log.Printf("%s %s", r.Method, r.URL.Path)
		next.ServeHTTP(w, r)
	})
}

func (a *app) handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}



func (a *app) handleGetPaste(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, a.store.snapshot())
}

func (a *app) handlePutPaste(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, a.maxBodyBytes)
	defer r.Body.Close()

	var payload pastePayload
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		status := http.StatusBadRequest
		if errors.As(err, new(*http.MaxBytesError)) {
			status = http.StatusRequestEntityTooLarge
		}
		writeJSON(w, status, map[string]string{"error": "invalid request body"})
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	writeJSON(w, http.StatusOK, a.store.set(payload.Content))
}

func (a *app) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ctx := r.Context()
	updates, unsubscribe := a.store.subscribe()
	defer unsubscribe()

	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case snapshot, ok := <-updates:
			if !ok {
				return
			}
			if err := writeSSE(w, "paste", snapshot); err != nil {
				return
			}
			flusher.Flush()
		case <-ticker.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func writeSSE(w http.ResponseWriter, event string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
	return err
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("json encode error: %v", err)
	}
}

func envDuration(key string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		log.Printf("invalid %s=%q, using %s", key, value, fallback)
		return fallback
	}
	return parsed
}

func envInt64(key string, fallback int64) int64 {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		log.Printf("invalid %s=%q, using %d", key, value, fallback)
		return fallback
	}
	return parsed
}

func envString(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

// Keep cleanup cheap for long TTLs while still reacting quickly for short ones.
func defaultCleanupInterval(ttl time.Duration) time.Duration {
	if ttl <= 0 {
		return 0
	}

	interval := ttl / cleanupIntervalDiv
	if interval < minCleanupInterval {
		return minCleanupInterval
	}
	if interval > maxCleanupInterval {
		return maxCleanupInterval
	}
	return interval
}

func (a *app) startCleanupLoop(ctx context.Context) {
	if a.ttl <= 0 || a.cleanupInterval <= 0 {
		return
	}
	ticker := time.NewTicker(a.cleanupInterval)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if _, cleared := a.store.clearIfExpired(a.ttl); cleared {
					log.Printf("paste expired and was cleared")
				}
			}
		}
	}()
}

func main() {
	port := envString("PORT", "8080")
	ttl := envDuration("PASTE_TTL", 24*time.Hour)
	cleanupInterval := defaultCleanupInterval(ttl)
	cleanupIntervalSource := "auto"
	if strings.TrimSpace(os.Getenv("CLEANUP_INTERVAL")) != "" {
		cleanupInterval = envDuration("CLEANUP_INTERVAL", cleanupInterval)
		cleanupIntervalSource = "env"
	}
	maxBodyBytes := envInt64("MAX_BODY_BYTES", 262144)

	app := newApp(ttl, cleanupInterval, maxBodyBytes)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	app.startCleanupLoop(ctx)

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           app.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      0,
		IdleTimeout:       120 * time.Second,
	}

	log.Printf("listening on :%s ttl=%s cleanup_interval=%s cleanup_interval_source=%s max_body_bytes=%d", port, ttl, cleanupInterval, cleanupIntervalSource, maxBodyBytes)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
