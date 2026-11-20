package main

import (
	"io/fs"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

// The server listens as soon as it starts, before the word lists are checked and the saved games restored, so a
// slow start (woogles.io not answering costs up to 20 s, a first start downloads the word lists) shows a "starting
// up" screen with what is being done instead of a proxy's error page, and open TVs and phones can say why they are
// reconnecting. Until ready() is called, pages get web/starting.html, the files it needs are served, /api/ready
// reports the step, and everything else (the API, sockets, QR codes) answers 503.

type startupStep struct {
	Key    string    `json:"key"`    // lists, rooms, extras
	Label  string    `json:"label"`  // shown big: "Checking the word lists"
	Detail string    `json:"detail"` // shown small under it
	Since  time.Time `json:"-"`
}

var (
	startupAt  = time.Now()
	startupCur atomic.Pointer[startupStep] // nil once the server is ready
)

func init() { startupCur.Store(&startupStep{Key: "lists", Label: "Starting up", Since: startupAt}) }

func startupStepTo(key, label, detail string) {
	if startupCur.Load() == nil {
		return
	}
	startupCur.Store(&startupStep{Key: key, Label: label, Detail: detail, Since: time.Now()})
}

func startupReady() { startupCur.Store(nil) }

// startupPhase reports the current step, or nil once the server is ready.
func startupPhase() *startupStep { return startupCur.Load() }

// slowListsAfter is how long a word-list check may take before the starting screen explains the wait.
const slowListsAfter = 4 * time.Second

func readyBody(st *startupStep) map[string]any {
	if st == nil {
		return map[string]any{"ready": true}
	}
	b := map[string]any{"ready": false, "step": st.Key, "label": st.Label, "detail": st.Detail,
		"secs": int(time.Since(startupAt).Seconds())}
	if st.Key == "lists" && time.Since(st.Since) > slowListsAfter {
		b["slow"] = "woogles.io is slow to answer. If it doesn't, the word lists already here are used (within 20 seconds)."
	}
	return b
}

func handleReady(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	st := startupPhase()
	code := 200
	if st != nil {
		code = 503
		w.Header().Set("Retry-After", "1")
	}
	writeJSON(w, code, readyBody(st))
}

// startupPages are the HTML pages; while starting, each one is the starting screen, which reloads itself when ready.
func isStartupPage(p string) bool {
	switch p {
	case "/", "/tv", "/app", "/cast":
		return true
	}
	return strings.HasPrefix(p, "/p/")
}

func startupGate(next http.Handler, web fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if startupPhase() == nil {
			next.ServeHTTP(w, r)
			return
		}
		p := r.URL.Path
		switch {
		case p == "/api/ready":
			handleReady(w, r)
		case p == "/healthz", p == "/sw.js", p == "/manifest.webmanifest", p == "/app/woogles-tv.apk",
			strings.HasPrefix(p, "/static/"):
			next.ServeHTTP(w, r)
		case r.Method == http.MethodGet && isStartupPage(p):
			// 200, not 503: the Android TV app swaps any 5xx page for its own "can't reach" screen. The header
			// keeps the service worker from caching this screen as the real page.
			b, _ := fs.ReadFile(web, "starting.html")
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Woogles-Starting", "1")
			w.Write(b)
		default:
			w.Header().Set("Retry-After", "1")
			writeJSON(w, 503, map[string]string{"error": "Woogles-TV is starting up, try again in a moment"})
		}
	})
}
