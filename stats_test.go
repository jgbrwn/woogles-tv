package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func resetStats(t *testing.T) {
	t.Helper()
	eachCounter(&stats.counters, func(_ string, v *atomic.Int64) { v.Store(0) })
	stats.path, stats.atStart, stats.lastSave = "", nil, nil
	t.Cleanup(func() { stats.path = "" })
}

func TestStatsPersist(t *testing.T) {
	resetStats(t)
	dir := t.TempDir()
	loadStats(dir)
	since := stats.since
	stats.GamesStarted.Add(3)
	stats.Bingos.Add(1)
	saveStats()

	// A new process picks up where the last one stopped, and keeps the original start date.
	eachCounter(&stats.counters, func(_ string, v *atomic.Int64) { v.Store(0) })
	stats.since = "x"
	loadStats(dir)
	if stats.GamesStarted.Load() != 3 || stats.Bingos.Load() != 1 || stats.since != since {
		t.Fatalf("after reload: started %d bingos %d since %q (want %q)", stats.GamesStarted.Load(), stats.Bingos.Load(), stats.since, since)
	}
	stats.GamesStarted.Add(2)
	rep := statsReport()
	if got := rep["sinceRestart"].(map[string]int64)["gamesStarted"]; got != 2 {
		t.Errorf("sinceRestart gamesStarted = %d, want 2", got)
	}
	if got := rep["lifetime"].(map[string]any)["counters"].(map[string]int64)["gamesStarted"]; got != 5 {
		t.Errorf("lifetime gamesStarted = %d, want 5", got)
	}

	// A damaged file doesn't stop the server.
	os.WriteFile(filepath.Join(dir, "stats", "counters.json"), []byte("{oops"), 0o600)
	loadStats(dir)
}

func TestStatsReportCounts(t *testing.T) {
	resetStats(t)
	r := newTestRoom(t)
	defer func() { roomsMu.Lock(); delete(rooms, r.Code); roomsMu.Unlock() }()
	r.mu.Lock()
	r.seats[0] = &Seat{Name: "Alex", Token: newSecret()}
	r.seats[1] = &Seat{Name: "Bot", Bot: true}
	r.clients[&Client{role: "tv", seat: -1}] = true
	r.clients[&Client{role: "player", seat: 0}] = true
	r.clients[&Client{role: "player", seat: -1}] = true
	r.mu.Unlock()
	if stats.RoomsCreated.Load() != 1 {
		t.Errorf("roomsCreated = %d", stats.RoomsCreated.Load())
	}

	b, _ := json.Marshal(statsReport())
	var rep struct {
		Now map[string]int `json:"now"`
	}
	json.Unmarshal(b, &rep)
	for k, want := range map[string]int{"tvs": 1, "players": 1, "spectators": 1, "withTV": 1, "lobby": 1} {
		if rep.Now[k] < want {
			t.Errorf("now.%s = %d, want ≥ %d", k, rep.Now[k], want)
		}
	}
	// Counts only: nothing that would let someone join a room.
	if s := string(b); strings.Contains(s, r.Code) || strings.Contains(s, r.JoinKey) || strings.Contains(s, "Alex") {
		t.Error("report leaks a room code, key or name")
	}
}

func TestPublicStatsToken(t *testing.T) {
	resetStats(t)
	t.Setenv("WT_STATS_TOKEN", "")
	if publicStatsHandler() != nil {
		t.Error("route should be off without a token")
	}
	t.Setenv("WT_STATS_TOKEN", "short")
	if publicStatsHandler() != nil {
		t.Error("route should stay off with a short token")
	}
	tok := strings.Repeat("k", statsTokenMin)
	t.Setenv("WT_STATS_TOKEN", tok)
	h := publicStatsHandler()
	for _, c := range []struct {
		auth string
		code int
	}{{"", 401}, {"Bearer nope", 401}, {tok, 401}, {"Bearer " + tok, 200}} {
		req := httptest.NewRequest("GET", "/api/stats", nil)
		if c.auth != "" {
			req.Header.Set("Authorization", c.auth)
		}
		rec := httptest.NewRecorder()
		h(rec, req)
		if rec.Code != c.code {
			t.Errorf("auth %q: status %d, want %d", c.auth, rec.Code, c.code)
		}
		if c.code == 200 && !strings.Contains(rec.Body.String(), `"lifetime"`) {
			t.Error("no report in the response")
		}
	}
}
