package main

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPasteStoreClearIfExpired(t *testing.T) {
	store := newPasteStore()
	store.set("hello")
	store.mu.Lock()
	store.updatedAt = time.Now().Add(-2 * time.Hour)
	store.mu.Unlock()

	snapshot, cleared := store.clearIfExpired(time.Hour)
	if !cleared {
		t.Fatal("expected paste to be cleared")
	}
	if snapshot.Content != "" {
		t.Fatalf("expected empty content, got %q", snapshot.Content)
	}
	if snapshot.Revision != 2 {
		t.Fatalf("expected revision 2, got %d", snapshot.Revision)
	}
}

func TestDefaultCleanupInterval(t *testing.T) {
	tests := []struct {
		name string
		ttl  time.Duration
		want time.Duration
	}{
		{name: "disabled when ttl is zero", ttl: 0, want: 0},
		{name: "minimum floor", ttl: time.Hour, want: 15 * time.Second},
		{name: "24 hours becomes five minutes", ttl: 24 * time.Hour, want: 5 * time.Minute},
		{name: "upper cap", ttl: 7 * 24 * time.Hour, want: 30 * time.Minute},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := defaultCleanupInterval(tt.ttl)
			if got != tt.want {
				t.Fatalf("expected %s, got %s", tt.want, got)
			}
		})
	}
}

func TestPutThenGetPaste(t *testing.T) {
	app := newApp(time.Hour, time.Minute, 1024)
	server := httptest.NewServer(app.routes())
	defer server.Close()

	req, err := http.NewRequest(http.MethodPut, server.URL+"/api/paste", strings.NewReader(`{"content":"abc"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	resp, err = http.Get(server.URL + "/api/paste")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	var snapshot pasteSnapshot
	if err := json.NewDecoder(resp.Body).Decode(&snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Content != "abc" {
		t.Fatalf("expected abc, got %q", snapshot.Content)
	}
}

func TestSSEReceivesUpdate(t *testing.T) {
	app := newApp(time.Hour, time.Minute, 1024)
	server := httptest.NewServer(app.routes())
	defer server.Close()

	resp, err := http.Get(server.URL + "/api/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	lines := make(chan string, 8)
	go func() {
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
		close(lines)
	}()

	req, err := http.NewRequest(http.MethodPut, server.URL+"/api/paste", strings.NewReader(`{"content":"live"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	putResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	putResp.Body.Close()

	timeout := time.After(2 * time.Second)
	for {
		select {
		case line, ok := <-lines:
			if !ok {
				t.Fatal("event stream closed before update")
			}
			if strings.Contains(line, `"content":"live"`) {
				return
			}
		case <-timeout:
			t.Fatal("timed out waiting for sse update")
		}
	}
}
