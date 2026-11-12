package main

import (
	"embed"
	"encoding/json"
	"flag"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/rs/zerolog"
	qrcode "github.com/skip2/go-qrcode"
)

//go:embed web
var webFS embed.FS

func baseURL(r *http.Request) string {
	if pub := os.Getenv("PUBLIC_URL"); pub != "" {
		return strings.TrimRight(pub, "/")
	}
	proto := "http"
	if p := r.Header.Get("X-Forwarded-Proto"); p == "https" || p == "http" {
		proto = p
	} else if r.TLS != nil {
		proto = "https"
	}
	host := r.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}
	return proto + "://" + host
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad request"})
		return false
	}
	return true
}

func main() {
	addr := flag.String("addr", ":8420", "listen address")
	data := flag.String("data", "./data", "macondo data path (lexica etc.); rooms are saved in DATA/rooms")
	apk := flag.String("apk", "./android/out/woogles-tv.apk", "Android TV APK to serve at /app/woogles-tv.apk")
	flag.Parse()
	zerolog.SetGlobalLevel(zerolog.WarnLevel)
	if err := initEngine(*data); err != nil {
		slog.Error("engine init", "err", err)
		os.Exit(1)
	}
	if err := loadRooms(filepath.Join(*data, "rooms")); err != nil {
		slog.Error("load rooms", "err", err)
		os.Exit(1)
	}
	go reapRooms()
	go clockWatch()

	sub, _ := fs.Sub(webFS, "web")
	if os.Getenv("WT_DEV") == "1" { // serve web/ from disk for live editing
		sub = os.DirFS("web")
	}
	static := http.FileServer(http.FS(sub))
	page := func(name string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			b, _ := fs.ReadFile(sub, name)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			w.Write(b)
		}
	}

	createLimit := newIPLimiter(20.0/60, 10) // 20 rooms/hour per IP, burst 10
	joinLimit := newIPLimiter(10, 10)        // 10 code lookups/minute per IP
	qrLimit := newIPLimiter(60, 30)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", page("index.html"))
	mux.HandleFunc("GET /tv", page("tv.html"))
	mux.HandleFunc("GET /p/{code}", page("play.html"))
	mux.HandleFunc("GET /app", page("app.html"))
	// Google Cast Web Receiver: the TV page plus the Cast receiver SDK.
	mux.HandleFunc("GET /cast", func(w http.ResponseWriter, r *http.Request) {
		b, _ := fs.ReadFile(sub, "tv.html")
		h := strings.Replace(string(b), `<body class="tv">`, `<body class="tv" data-cast="1">`, 1)
		h = strings.Replace(h, `<script type="module" src="/static/tv.js">`,
			`<script src="https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js"></script>`+"\n"+`<script type="module" src="/static/tv.js">`, 1)
		w.Header().Set("Content-Security-Policy", castCSP)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write([]byte(h))
	})
	mux.HandleFunc("GET /api/config", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"castAppId": os.Getenv("CAST_APP_ID")})
	})
	mux.HandleFunc("GET /manifest.webmanifest", func(w http.ResponseWriter, r *http.Request) {
		b, _ := fs.ReadFile(sub, "manifest.webmanifest")
		w.Header().Set("Content-Type", "application/manifest+json")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(b)
	})
	mux.HandleFunc("GET /sw.js", func(w http.ResponseWriter, r *http.Request) {
		b, _ := fs.ReadFile(sub, "sw.js")
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(b)
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("GET /app/woogles-tv.apk", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.android.package-archive")
		w.Header().Set("Content-Disposition", `attachment; filename="woogles-tv.apk"`)
		http.ServeFile(w, r, *apk)
	})
	mux.Handle("GET /static/", cacheHeaders(static))

	// TV creates a room. The response holds the TV's private key.
	mux.HandleFunc("POST /api/rooms", func(w http.ResponseWriter, r *http.Request) {
		if !createLimit.allow(clientIP(r)) {
			writeJSON(w, 429, map[string]string{"error": "too many new rooms, slow down"})
			return
		}
		room, err := createRoom(baseURL(r))
		if err != nil {
			writeJSON(w, 503, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]string{"code": room.Code, "tvKey": room.TVKey, "joinKey": room.JoinKey})
	})
	// TV checks that its saved room still exists (needs the TV key; reveals nothing otherwise).
	mux.HandleFunc("POST /api/tv", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Code, TVKey string }
		if !readJSON(w, r, &req) {
			return
		}
		if room := getRoom(req.Code); room != nil {
			if _, ok := room.authorize("tv", req.TVKey, ""); ok {
				writeJSON(w, 200, map[string]bool{"ok": true})
				return
			}
		}
		writeJSON(w, 404, map[string]string{"error": "not found"})
	})
	// Status of several rooms at once, for the TV's and phones' game lists. Each item needs a credential.
	mux.HandleFunc("POST /api/summaries", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Items []struct{ Code, TVKey, Key, Token string }
		}
		if !readJSON(w, r, &req) {
			return
		}
		out := []any{}
		for i, it := range req.Items {
			if i >= 12 {
				break
			}
			room := getRoom(it.Code)
			if room == nil {
				out = append(out, map[string]any{"code": it.Code, "gone": true})
				continue
			}
			sm, seat, ok := room.summaryFor(it.TVKey, it.Key, it.Token)
			if !ok {
				out = append(out, map[string]any{"code": it.Code, "gone": true})
				continue
			}
			out = append(out, map[string]any{"code": it.Code, "summary": sm, "seat": seat})
		}
		writeJSON(w, 200, out)
	})
	// Manual join by typing the room code shown on the TV. Rate limited against guessing.
	mux.HandleFunc("POST /api/join", func(w http.ResponseWriter, r *http.Request) {
		if !joinLimit.allow(clientIP(r)) || !globalJoin.allow() {
			writeJSON(w, 429, map[string]string{"error": "Too many tries — wait a minute and try again"})
			return
		}
		var req struct{ Code string }
		if !readJSON(w, r, &req) {
			return
		}
		room := getRoom(req.Code)
		if room == nil {
			time.Sleep(300 * time.Millisecond)
			writeJSON(w, 404, map[string]string{"error": "No game with that code — check the TV"})
			return
		}
		writeJSON(w, 200, map[string]string{"code": room.Code, "key": room.JoinKey})
	})
	// QR codes are only generated for this site's own join links.
	mux.HandleFunc("GET /qr", func(w http.ResponseWriter, r *http.Request) {
		d := r.URL.Query().Get("d")
		if len(d) > 300 || !strings.HasPrefix(d, baseURL(r)+"/") || !qrLimit.allow(clientIP(r)) {
			http.Error(w, "bad request", 400)
			return
		}
		png, err := qrcode.Encode(d, qrcode.Medium, 512)
		if err != nil {
			http.Error(w, "bad request", 400)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "private, max-age=86400")
		w.Write(png)
	})
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		room := getRoom(q.Get("room"))
		role := q.Get("role")
		if role != "tv" {
			role = "player"
		}
		if room == nil {
			http.Error(w, "forbidden", 403)
			return
		}
		seat, ok := room.authorize(role, q.Get("key"), q.Get("token"))
		if !ok {
			http.Error(w, "forbidden", 403)
			return
		}
		var origins []string
		if u, err := url.Parse(baseURL(r)); err == nil {
			origins = append(origins, u.Host)
		}
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: origins})
		if err != nil {
			return
		}
		defer c.CloseNow()
		room.serve(r.Context(), c, role, seat)
	})

	srv := &http.Server{
		Addr:              *addr,
		Handler:           securityHeaders(mux),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	slog.Info("listening", "addr", *addr)
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}

func cacheHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/static/fonts/") {
			w.Header().Set("Cache-Control", "public, max-age=2592000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		h.ServeHTTP(w, r)
	})
}
