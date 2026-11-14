package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseStations(t *testing.T) {
	got := parseStations(" Radio Paradise=https://stream.radioparadise.com/aac-128, https://ice.example.org/live?x=1,ftp://nope, ,Home=http://10.0.0.2:8000/s")
	want := []musicStation{
		{"Radio Paradise", "https://stream.radioparadise.com/aac-128"},
		{"ice.example.org", "https://ice.example.org/live?x=1"}, // a bare URL keeps its "=" and is named after its host
		{"Home", "http://10.0.0.2:8000/s"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d stations: %+v", len(got), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("station %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestMusicCSP(t *testing.T) {
	t.Cleanup(func() { setMediaSources(nil) })
	musicStations = parseStations("A=https://a.example/x,B=https://a.example/y,C=http://b.example:8000/z")
	t.Cleanup(func() { musicStations = nil })
	setMediaSources(musicOrigins())
	if !strings.Contains(cspHeader, "media-src 'self' data: https://a.example http://b.example:8000;") {
		t.Errorf("csp: %s", cspHeader)
	}
	if !strings.Contains(castCSPHeader, "https://a.example http://b.example:8000") {
		t.Errorf("cast csp: %s", castCSPHeader)
	}
}

// icyServer streams fake audio with ICY metadata every 100 bytes, as Icecast does for "Icy-MetaData: 1".
func icyServer(t *testing.T, meta string) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Icy-MetaData") != "1" || meta == "" {
			w.Write(make([]byte, 500))
			return
		}
		w.Header().Set("icy-metaint", "100")
		block := []byte(meta)
		block = append(block, make([]byte, (16-len(block)%16)%16)...)
		w.Write(make([]byte, 100))
		w.Write([]byte{byte(len(block) / 16)})
		w.Write(block)
		w.Write(make([]byte, 100))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestNowPlaying(t *testing.T) {
	srv := icyServer(t, "StreamTitle='Fleetwood Mac - Don't Stop';StreamUrl='"+"http://127.0.0.1:8421/cover.jpg';")
	plain := icyServer(t, "")
	musicStations = []musicStation{{"Test", srv.URL}, {"Plain", plain.URL}}
	musicNow = []*nowEntry{{}, {}}
	musicNowPlaying = true
	t.Cleanup(func() { musicStations, musicNow = nil, nil })

	np := musicNow[0].get(context.Background(), 0)
	if np.Title != "Fleetwood Mac - Don't Stop" || np.Artist != "Fleetwood Mac" || np.Song != "Don't Stop" {
		t.Errorf("now playing = %+v", np)
	}
	// The cover URL points at this machine, so it must not be fetched.
	if np.Cover != "" {
		t.Errorf("cover from a local address was fetched: %+v", np)
	}
	if np := musicNow[1].get(context.Background(), 1); np != (nowPlaying{}) {
		t.Errorf("stream without metadata: %+v", np)
	}

	rec := httptest.NewRecorder()
	handleMusicNow(rec, httptest.NewRequest("GET", "/api/music/now?s=0", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"song":"Don't Stop"`) {
		t.Errorf("GET now: %d %s", rec.Code, rec.Body)
	}
	for _, q := range []string{"s=2", "s=-1", "s=x", ""} {
		rec := httptest.NewRecorder()
		handleMusicNow(rec, httptest.NewRequest("GET", "/api/music/now?"+q, nil))
		if rec.Code != 404 {
			t.Errorf("GET now?%s: %d", q, rec.Code)
		}
	}
}

func TestIcyField(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"StreamTitle='A - B';", "A - B"},
		{"StreamTitle='Guns N' Roses - Don't Cry';StreamUrl='';", "Guns N' Roses - Don't Cry"},
		{"StreamTitle='';", ""},
		{"nothing", ""},
	} {
		if got := icyField(c.in, "StreamTitle"); got != c.want {
			t.Errorf("icyField(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestMusicSettings(t *testing.T) {
	musicStations = parseStations("A=https://a.example/x,B=https://b.example/y")
	t.Cleanup(func() { musicStations = nil })
	r := newTestRoom(t)
	defer func() { roomsMu.Lock(); delete(rooms, r.Code); roomsMu.Unlock() }()
	if r.settings.Music != "always" || r.settings.MusicVol != "med" {
		t.Fatalf("defaults: %+v", r.settings)
	}
	tv := &Client{role: "tv", seat: -1, send: make(chan []byte, 8)}
	watcher := &Client{role: "player", seat: -1, send: make(chan []byte, 8)}
	r.mu.Lock()
	r.clients[tv], r.clients[watcher] = true, true
	r.mu.Unlock()
	one, nine := 1, 9
	r.handle(tv, inMsg{T: "settings", Music: "breaks", MusicVol: "high", Station: &one})
	r.handle(tv, inMsg{T: "settings", Music: "loud", MusicVol: "max", Station: &nine}) // ignored
	r.handle(watcher, inMsg{T: "settings", Music: "off"})                              // spectators can't change it
	if r.settings.Music != "breaks" || r.settings.MusicVol != "high" || r.settings.Station != 1 {
		t.Errorf("settings: %+v", r.settings)
	}
}
