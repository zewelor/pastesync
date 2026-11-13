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

func TestPasteStoreGenerationSurvivesWritesAndChangesOnRestart(t *testing.T) {
	generation := func(snapshot pasteSnapshot) string {
		t.Helper()
		data, err := json.Marshal(snapshot)
		if err != nil {
			t.Fatal(err)
		}
		var decoded struct {
			Generation string `json:"generation"`
		}
		if err := json.Unmarshal(data, &decoded); err != nil {
			t.Fatal(err)
		}
		return decoded.Generation
	}
	store := newPasteStore()
	initial := generation(store.snapshot())
	if initial == "" {
		t.Fatal("snapshot must identify the server generation")
	}
	if got := generation(store.set("first write")); got != initial {
		t.Fatal("writing changed the server generation")
	}
	store.updatedAt = time.Now().Add(-2 * time.Hour)
	expired, cleared := store.clearIfExpired(time.Hour)
	if !cleared || generation(expired) != initial {
		t.Fatal("TTL cleanup must preserve the server generation")
	}
	restarted := newPasteStore().snapshot()
	if generation(restarted) == initial || generation(restarted) == "" {
		t.Fatal("a new store must have a new generation")
	}
	if restarted.Revision != 0 {
		t.Fatal("a new generation must start at revision zero")
	}
}

func TestPasteStoreSubscriptionInitialLatestAndUnsubscribe(t *testing.T) {
	store := newPasteStore()
	initial := store.set("initial")
	updates, unsubscribe := store.subscribe()
	if got := <-updates; got != initial {
		t.Fatalf("initial snapshot = %+v, want %+v", got, initial)
	}
	store.set("intermediate")
	latest := store.set("latest")
	if got := <-updates; got != latest {
		t.Fatalf("coalesced snapshot = %+v, want %+v", got, latest)
	}
	unsubscribe()
	if _, open := <-updates; open {
		t.Fatal("unsubscribe must close the event stream")
	}
	store.set("after unsubscribe")
}

func TestPasteStoreSubscribeDuringWrites(t *testing.T) {
	const attempts = 500
	results := make(chan bool, attempts)
	for range attempts {
		store := newPasteStore()
		start := make(chan struct{})
		written := make(chan struct{})
		go func() {
			<-start
			for range 3 {
				store.set("concurrent write")
			}
			close(written)
		}()
		go func() {
			<-start
			updates, unsubscribe := store.subscribe()
			defer unsubscribe()
			<-written
			results <- (<-updates == store.snapshot())
		}()
		close(start)
	}
	timeout := time.NewTimer(5 * time.Second)
	defer timeout.Stop()
	for range attempts {
		select {
		case latest := <-results:
			if !latest {
				t.Fatal("subscription lost the latest concurrent write")
			}
		case <-timeout.C:
			t.Fatal("subscribe blocked during concurrent writes")
		}
	}
}

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

func TestPutPasteRejectsOversizedBody(t *testing.T) {
	app := newApp(time.Hour, time.Minute, 32)
	server := httptest.NewServer(app.routes())
	defer server.Close()

	req, err := http.NewRequest(http.MethodPut, server.URL+"/api/paste", strings.NewReader(`{"content":"abcdefghijklmnopqrstuvwxyz"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d", resp.StatusCode)
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

func TestStaticIconAssets(t *testing.T) {
	app := newApp(time.Hour, time.Minute, 1024)
	server := httptest.NewServer(app.routes())
	defer server.Close()

	tests := []struct {
		path        string
		contentType string
	}{
		{path: "/favicon.ico", contentType: "image/x-icon"},
		{path: "/favicon.svg", contentType: "image/svg+xml"},
		{path: "/site.webmanifest", contentType: "application/manifest+json"},
		{path: "/android-chrome-192x192.png", contentType: "image/png"},
		{path: "/android-chrome-512x512.png", contentType: "image/png"},
		{path: "/maskable-icon-512x512.png", contentType: "image/png"},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			resp, err := http.Get(server.URL + tt.path)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()

			if resp.StatusCode != http.StatusOK {
				t.Fatalf("expected 200, got %d", resp.StatusCode)
			}
			if got := resp.Header.Get("Content-Type"); !strings.Contains(got, tt.contentType) {
				t.Fatalf("expected content type containing %q, got %q", tt.contentType, got)
			}
		})
	}
}
