package main

import (
	"embed"
	"encoding/json"
	"flag"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"strings"

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
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
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

func main() {
	addr := flag.String("addr", ":8420", "listen address")
	data := flag.String("data", "./data", "macondo data path")
	flag.Parse()
	zerolog.SetGlobalLevel(zerolog.InfoLevel)
	if err := initEngine(*data); err != nil {
		slog.Error("engine init", "err", err)
		os.Exit(1)
	}
	go reapRooms()

	sub, _ := fs.Sub(webFS, "web")
	static := http.FileServer(http.FS(sub))
	page := func(name string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			b, _ := fs.ReadFile(sub, name)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			w.Write(b)
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", page("index.html"))
	mux.HandleFunc("GET /tv", page("tv.html"))
	mux.HandleFunc("GET /p/{code}", page("play.html"))
	mux.Handle("GET /static/", noCache(static))

	mux.HandleFunc("POST /api/rooms", func(w http.ResponseWriter, r *http.Request) {
		room := createRoom()
		room.joinURL = baseURL(r) + "/p/" + room.Code
		json.NewEncoder(w).Encode(map[string]string{"code": room.Code, "joinUrl": room.joinURL})
	})
	mux.HandleFunc("GET /api/rooms/{code}", func(w http.ResponseWriter, r *http.Request) {
		if getRoom(r.PathValue("code")) == nil {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("GET /qr", func(w http.ResponseWriter, r *http.Request) {
		png, err := qrcode.Encode(r.URL.Query().Get("d"), qrcode.Medium, 512)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Write(png)
	})
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		room := getRoom(q.Get("room"))
		if room == nil {
			http.Error(w, "no such room", 404)
			return
		}
		role := q.Get("role")
		if role != "tv" {
			role = "player"
		}
		if room.joinURL == "" {
			room.joinURL = baseURL(r) + "/p/" + room.Code
		}
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer c.CloseNow()
		room.serve(r.Context(), c, role, q.Get("token"))
	})
	slog.Info("listening", "addr", *addr)
	if err := http.ListenAndServe(*addr, mux); err != nil {
		slog.Error("serve", "err", err)
		os.Exit(1)
	}
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		h.ServeHTTP(w, r)
	})
}
