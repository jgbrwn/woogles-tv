package main

// Server statistics: what's happening right now (rooms, games, connections) and lifetime counters (games played,
// moves, speech requests, rate-limit refusals) kept in DATA/rooms/stats/counters.json across restarts. They live
// under rooms/ because that's the folder deployments already keep (the Docker volume); room loading ignores subfolders.
//
// Two ways to read them, both off by default:
//   - WT_ADMIN_ADDR=127.0.0.1:8421 (or -admin): a separate local-only listener serving GET /stats. Nothing on it is
//     reachable from the internet unless you expose that port yourself.
//   - WT_STATS_TOKEN=<random, 24+ characters>: GET /api/stats on the public site, with
//     "Authorization: Bearer <token>". Without the token setting the route doesn't exist (404).
//
// Only counts are reported: no room codes, keys or player names.

import (
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Lifetime counters. eachCounter gives each its name in stats.json and in the report.
type counters struct {
	RoomsCreated   atomic.Int64 `json:"roomsCreated"`
	GamesStarted   atomic.Int64 `json:"gamesStarted"`
	GamesVsBot     atomic.Int64 `json:"gamesVsBot"`     // of those started, against a bot
	GamesFinished  atomic.Int64 `json:"gamesFinished"`  // played out (rack emptied or six scoreless turns)
	GamesResigned  atomic.Int64 `json:"gamesResigned"`  //
	GamesTimedOut  atomic.Int64 `json:"gamesTimedOut"`  // lost on time (10 minutes of overtime)
	GamesAbandoned atomic.Int64 `json:"gamesAbandoned"` // ended from the menu before the finish
	Moves          atomic.Int64 `json:"moves"`          // plays, passes and exchanges, by people and bots
	BotMoves       atomic.Int64 `json:"botMoves"`
	Bingos         atomic.Int64 `json:"bingos"`
	Connections    atomic.Int64 `json:"connections"` // WebSocket connections opened (TVs, players, spectators)
	TTSRequests    atomic.Int64 `json:"ttsRequests"`
	TTSCacheHits   atomic.Int64 `json:"ttsCacheHits"`
	TTSBusy        atomic.Int64 `json:"ttsBusy"`   // engine had no free slot in time (503)
	TTSErrors      atomic.Int64 `json:"ttsErrors"` // engine down or sent nothing (502)
	DefLookups     atomic.Int64 `json:"defLookups"`
	DefCacheHits   atomic.Int64 `json:"defCacheHits"`
	DefFailures    atomic.Int64 `json:"defFailures"`
	LimitNewRoom   atomic.Int64 `json:"limitNewRoom"`   // refusals by each rate limit
	LimitCodeQuery atomic.Int64 `json:"limitCodeQuery"` // code lookups and "Show on TV"
	LimitTTS       atomic.Int64 `json:"limitTTS"`
	LimitDefine    atomic.Int64 `json:"limitDefine"`
	LimitMessages  atomic.Int64 `json:"limitMessages"` // WebSocket messages dropped by flood protection
	PeakClients    atomic.Int64 `json:"peakClients"`   // most connections at once
	PeakRooms      atomic.Int64 `json:"peakRooms"`
}

var stats = struct {
	counters
	path     string
	since    string    // when counting began (first run with stats)
	start    time.Time // this process
	atStart  map[string]int64
	clients  atomic.Int64
	saveMu   sync.Mutex
	lastSave map[string]int64
}{start: time.Now()}

// snapshot returns every counter as name → value.
func (c *counters) snapshot() map[string]int64 {
	m := map[string]int64{}
	eachCounter(c, func(name string, v *atomic.Int64) { m[name] = v.Load() })
	return m
}

func eachCounter(c *counters, f func(string, *atomic.Int64)) {
	f("roomsCreated", &c.RoomsCreated)
	f("gamesStarted", &c.GamesStarted)
	f("gamesVsBot", &c.GamesVsBot)
	f("gamesFinished", &c.GamesFinished)
	f("gamesResigned", &c.GamesResigned)
	f("gamesTimedOut", &c.GamesTimedOut)
	f("gamesAbandoned", &c.GamesAbandoned)
	f("moves", &c.Moves)
	f("botMoves", &c.BotMoves)
	f("bingos", &c.Bingos)
	f("connections", &c.Connections)
	f("ttsRequests", &c.TTSRequests)
	f("ttsCacheHits", &c.TTSCacheHits)
	f("ttsBusy", &c.TTSBusy)
	f("ttsErrors", &c.TTSErrors)
	f("defLookups", &c.DefLookups)
	f("defCacheHits", &c.DefCacheHits)
	f("defFailures", &c.DefFailures)
	f("limitNewRoom", &c.LimitNewRoom)
	f("limitCodeQuery", &c.LimitCodeQuery)
	f("limitTTS", &c.LimitTTS)
	f("limitDefine", &c.LimitDefine)
	f("limitMessages", &c.LimitMessages)
	f("peakClients", &c.PeakClients)
	f("peakRooms", &c.PeakRooms)
}

type statsFile struct {
	Since    string           `json:"since"`
	Saved    string           `json:"saved"`
	Counters map[string]int64 `json:"counters"`
}

// loadStats reads the counters file in roomsDir/stats (if any) and saves it again every 30 s when something changed.
func loadStats(roomsDir string) {
	dir := filepath.Join(roomsDir, "stats")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		slog.Warn("stats: can't keep lifetime counters", "err", err)
	}
	stats.path = filepath.Join(dir, "counters.json")
	stats.since = time.Now().UTC().Format(time.RFC3339)
	if b, err := os.ReadFile(stats.path); err == nil {
		var f statsFile
		if err := json.Unmarshal(b, &f); err != nil {
			slog.Warn("stats: unreadable, starting over", "file", stats.path, "err", err)
		} else {
			if f.Since != "" {
				stats.since = f.Since
			}
			eachCounter(&stats.counters, func(name string, v *atomic.Int64) { v.Store(f.Counters[name]) })
		}
	}
	stats.atStart = stats.snapshot()
	stats.lastSave = stats.atStart
	go func() {
		for range time.Tick(30 * time.Second) {
			saveStats()
		}
	}()
}

// saveStats writes the counters if they changed since the last save (atomically: temp file + rename).
func saveStats() {
	if stats.path == "" {
		return
	}
	stats.saveMu.Lock()
	defer stats.saveMu.Unlock()
	now := stats.snapshot()
	changed := false
	for k, v := range now {
		if stats.lastSave[k] != v {
			changed = true
			break
		}
	}
	if !changed {
		return
	}
	b, _ := json.MarshalIndent(statsFile{Since: stats.since, Saved: time.Now().UTC().Format(time.RFC3339), Counters: now}, "", "  ")
	tmp := stats.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		slog.Warn("stats: save", "err", err)
		return
	}
	if err := os.Rename(tmp, stats.path); err != nil {
		slog.Warn("stats: save", "err", err)
		return
	}
	stats.lastSave = now
}

func raisePeak(peak *atomic.Int64, v int64) {
	for {
		p := peak.Load()
		if v <= p || peak.CompareAndSwap(p, v) {
			return
		}
	}
}

func statsClientJoined() {
	stats.Connections.Add(1)
	raisePeak(&stats.PeakClients, stats.clients.Add(1))
}
func statsClientLeft() { stats.clients.Add(-1) }

// statsGameOver counts how a game ended; call it once, when the game ends.
func statsGameOver(reason string) {
	switch reason {
	case "resign":
		stats.GamesResigned.Add(1)
	case "time":
		stats.GamesTimedOut.Add(1)
	default:
		stats.GamesFinished.Add(1)
	}
}

// ---- report ----

func buildVersion() string {
	if bi, ok := debug.ReadBuildInfo(); ok {
		rev, dirty := "", false
		for _, s := range bi.Settings {
			switch s.Key {
			case "vcs.revision":
				rev = s.Value
			case "vcs.modified":
				dirty = s.Value == "true"
			}
		}
		if len(rev) > 12 {
			rev = rev[:12]
		}
		if rev != "" && dirty {
			rev += "+changes"
		}
		if rev != "" {
			return rev
		}
	}
	return "unknown"
}

func statsReport() map[string]any {
	type nowCounts struct {
		Rooms        int `json:"rooms"`
		RoomLimit    int `json:"roomLimit"`
		Lobby        int `json:"lobby"`
		Playing      int `json:"playing"`
		Paused       int `json:"paused"` // also counted in playing
		Over         int `json:"over"`
		VsBot        int `json:"vsBot"`        // games in progress against a bot
		VsPerson     int `json:"vsPerson"`     // games in progress between two people
		Active15m    int `json:"active15m"`    // rooms used in the last 15 minutes
		Active24h    int `json:"active24h"`    //
		WithTV       int `json:"withTV"`       // rooms with a TV connected
		Clients      int `json:"clients"`      // connections right now
		TVs          int `json:"tvs"`          //
		Players      int `json:"players"`      // phones in a seat
		Spectators   int `json:"spectators"`   // phones watching
		WithPlayers  int `json:"withPlayers"`  // rooms with a phone in a seat connected
		RoomsOnDisk  int `json:"roomsOnDisk"`  //
		ConnSinceRun int `json:"connSinceRun"` // connections opened since this process started
	}
	var n nowCounts
	n.RoomLimit = maxRooms
	roomsMu.Lock()
	list := make([]*Room, 0, len(rooms))
	for _, r := range rooms {
		list = append(list, r)
	}
	roomsMu.Unlock()
	now := time.Now()
	for _, r := range list {
		r.mu.Lock()
		if r.deleted {
			r.mu.Unlock()
			continue
		}
		n.Rooms++
		switch {
		case r.m == nil:
			n.Lobby++
		case r.overLocked():
			n.Over++
		default:
			n.Playing++
			if r.m.Clock != nil && r.m.Clock.Paused {
				n.Paused++
			}
			if (r.seats[0] != nil && r.seats[0].Bot) || (r.seats[1] != nil && r.seats[1].Bot) {
				n.VsBot++
			} else {
				n.VsPerson++
			}
		}
		idle := now.Sub(r.lastUsed)
		if len(r.clients) > 0 || idle < 15*time.Minute {
			n.Active15m++
		}
		if len(r.clients) > 0 || idle < 24*time.Hour {
			n.Active24h++
		}
		tv, player := false, false
		for c := range r.clients {
			n.Clients++
			switch {
			case c.role == "tv":
				n.TVs++
				tv = true
			case c.seat >= 0:
				n.Players++
				player = true
			default:
				n.Spectators++
			}
		}
		if tv {
			n.WithTV++
		}
		if player {
			n.WithPlayers++
		}
		r.mu.Unlock()
	}
	raisePeak(&stats.PeakRooms, int64(n.Rooms))
	if stats.path != "" {
		if m, _ := filepath.Glob(filepath.Join(filepath.Dir(stats.path), "..", "*.json")); m != nil {
			n.RoomsOnDisk = len(m)
		}
	}

	life := stats.snapshot()
	run := map[string]int64{}
	for k, v := range life {
		if strings.HasPrefix(k, "peak") {
			continue
		}
		run[k] = v - stats.atStart[k]
	}
	n.ConnSinceRun = int(run["connections"])
	delete(run, "connections")

	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	server := map[string]any{
		"version":    buildVersion(),
		"go":         runtime.Version(),
		"started":    stats.start.UTC().Format(time.RFC3339),
		"uptimeSec":  int64(time.Since(stats.start).Seconds()),
		"goroutines": runtime.NumGoroutine(),
		"memoryMB":   ms.Sys >> 20,
		"heapMB":     ms.HeapAlloc >> 20,
	}
	features := map[string]any{"definitions": defs != nil && defs.enabled, "cast": os.Getenv("CAST_APP_ID") != ""}
	if tts != nil {
		features["serverVoice"] = map[string]any{"voices": len(tts.voices), "default": tts.voices[0].ID,
			"cacheMB": tts.cache.megabytes()}
	} else {
		features["serverVoice"] = false
	}
	return map[string]any{
		"server":       server,
		"now":          n,
		"sinceRestart": run,
		"lifetime":     map[string]any{"since": stats.since, "counters": life},
		"features":     features,
	}
}

func serveStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	enc.Encode(statsReport())
}

// ---- access ----

const statsTokenMin = 24

var statsFails = newTokenBucket(1, 10) // wrong tokens: ~60/minute across everyone after a burst of 10

// publicStatsHandler serves GET /api/stats on the public site when WT_STATS_TOKEN is set (else nil: no route).
func publicStatsHandler() http.HandlerFunc {
	tok := os.Getenv("WT_STATS_TOKEN")
	if tok == "" {
		return nil
	}
	if len(tok) < statsTokenMin {
		slog.Warn("stats: WT_STATS_TOKEN is too short, /api/stats stays off", "min", statsTokenMin)
		return nil
	}
	want := []byte("Bearer " + tok)
	slog.Info("stats on /api/stats (token required)")
	return func(w http.ResponseWriter, r *http.Request) {
		got := []byte(r.Header.Get("Authorization"))
		if subtle.ConstantTimeCompare(got, want) != 1 {
			if !statsFails.allow() {
				time.Sleep(time.Second)
			}
			w.Header().Set("WWW-Authenticate", `Bearer realm="woogles-tv stats"`)
			writeJSON(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
		serveStats(w, r)
	}
}

// startAdmin serves GET /stats on a separate listener, meant for a local address such as 127.0.0.1:8421.
func startAdmin(addr string) {
	if addr == "" {
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /stats", serveStats)
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/stats", http.StatusFound) })
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	if h, _, err := net.SplitHostPort(addr); err == nil && (h == "" || h == "0.0.0.0" || h == "::") {
		slog.Warn("admin: listening on all interfaces; anyone who can reach this port can read the stats", "addr", addr)
	}
	slog.Info("admin stats", "addr", addr, "path", "/stats")
	go func() {
		if err := srv.ListenAndServe(); err != nil {
			slog.Error("admin", "err", err)
		}
	}()
}
