package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestStartupGate(t *testing.T) {
	defer startupCur.Store(startupCur.Load())
	web := fstest.MapFS{"starting.html": {Data: []byte("<h1>starting</h1>")}}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("real " + r.URL.Path)) })
	h := startupGate(next, web)
	get := func(method, path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
		return rec
	}

	startupCur.Store(&startupStep{Key: "lists", Label: "Checking the word lists"})
	for _, p := range []string{"/", "/tv", "/p/ABCDEF", "/app", "/cast"} {
		rec := get("GET", p)
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), "starting") || rec.Header().Get("X-Woogles-Starting") != "1" {
			t.Errorf("GET %s while starting: %d %q", p, rec.Code, rec.Body.String())
		}
	}
	for _, p := range []string{"/static/app.css", "/sw.js", "/healthz", "/manifest.webmanifest"} {
		if rec := get("GET", p); rec.Body.String() != "real "+p {
			t.Errorf("GET %s while starting should be served: %q", p, rec.Body.String())
		}
	}
	for _, r := range [][2]string{{"POST", "/api/rooms"}, {"GET", "/ws"}, {"GET", "/qr"}, {"GET", "/api/config"}, {"POST", "/api/join"}} {
		if rec := get(r[0], r[1]); rec.Code != 503 {
			t.Errorf("%s %s while starting: %d, want 503", r[0], r[1], rec.Code)
		}
	}
	rec := get("GET", "/api/ready")
	var body map[string]any
	json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != 503 || body["ready"] != false || body["step"] != "lists" || body["label"] != "Checking the word lists" {
		t.Errorf("/api/ready while starting: %d %v", rec.Code, body)
	}

	startupReady()
	if rec := get("GET", "/tv"); rec.Body.String() != "real /tv" {
		t.Errorf("GET /tv once ready: %q", rec.Body.String())
	}
	if rec := get("POST", "/api/rooms"); rec.Body.String() != "real /api/rooms" {
		t.Errorf("POST /api/rooms once ready: %q", rec.Body.String())
	}
	startupStepTo("rooms", "late", "") // a step after ready changes nothing
	if startupPhase() != nil {
		t.Error("ready is final")
	}
}
