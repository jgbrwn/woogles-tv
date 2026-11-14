package main

// Background music on the TV (optional). WT_MUSIC_STREAMS lists internet radio stations; the TV plays the chosen
// stream itself with a plain <audio> element, so the audio never passes through this server. The server lists
// the stations (GET /api/config), adds their hosts to the pages' Content-Security-Policy, and reads "now playing"
// from each stream's ICY metadata: the song titles Icecast and Shoutcast servers send to any player that asks with
// "Icy-MetaData: 1". That needs no knowledge of the station. Some stations (Radio Paradise, for one) also put a
// cover image URL in the metadata's StreamUrl field; the server fetches it and serves it from /api/music/cover.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

var (
	MusicModes = []string{"always", "breaks", "off"}
	MusicVols  = []string{"low", "med", "high"}
)

const (
	maxStations   = 12
	nowPlayingTTL = 20 * time.Second // how long a title is reused before the stream is asked again
	nowFailTTL    = time.Minute      // after a failed read, wait this long before trying again
	maxCoverBytes = 2 << 20
)

type musicStation struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

var (
	musicStations   []musicStation
	musicNowPlaying bool // WT_MUSIC_NOWPLAYING=off stops the server from reading titles from the streams
	musicNow        []*nowEntry
)

// parseStations reads WT_MUSIC_STREAMS: comma-separated entries, each "Name=URL" or just "URL".
func parseStations(raw string) []musicStation {
	var out []musicStation
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		name, link := "", item
		if i := strings.Index(item, "="); i > 0 && !strings.Contains(item[:i], "://") {
			name, link = strings.TrimSpace(item[:i]), strings.TrimSpace(item[i+1:])
		}
		u, err := url.Parse(link)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			slog.Warn("WT_MUSIC_STREAMS: skipping an entry that isn't an http(s) URL", "entry", item)
			continue
		}
		if u.Scheme == "http" {
			slog.Warn("WT_MUSIC_STREAMS: browsers block http:// streams on https:// pages; use https if the station has it", "url", link)
		}
		if name == "" {
			name = u.Hostname()
		}
		if len(out) == maxStations {
			slog.Warn("WT_MUSIC_STREAMS: too many stations, keeping the first", "max", maxStations)
			break
		}
		out = append(out, musicStation{Name: name, URL: link})
	}
	return out
}

func initMusic() {
	musicStations = parseStations(os.Getenv("WT_MUSIC_STREAMS"))
	musicNowPlaying = !strings.EqualFold(os.Getenv("WT_MUSIC_NOWPLAYING"), "off")
	musicNow = make([]*nowEntry, len(musicStations))
	for i := range musicNow {
		musicNow[i] = &nowEntry{}
	}
	if len(musicStations) > 0 {
		names := make([]string, len(musicStations))
		for i, s := range musicStations {
			names[i] = s.Name
		}
		slog.Info("music on", "stations", strings.Join(names, ", "), "nowPlaying", musicNowPlaying)
	}
	setMediaSources(musicOrigins())
}

// musicOrigins: the stations' origins, for the CSP's media-src.
func musicOrigins() []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range musicStations {
		u, _ := url.Parse(s.URL)
		o := u.Scheme + "://" + u.Host
		if !seen[o] {
			seen[o] = true
			out = append(out, o)
		}
	}
	return out
}

func musicConfig() any {
	if len(musicStations) == 0 {
		return nil
	}
	return map[string]any{"stations": musicStations, "nowPlaying": musicNowPlaying}
}

// ---- now playing ----

type nowPlaying struct {
	Title  string `json:"title,omitempty"`  // as the station sends it, usually "Artist - Song"
	Artist string `json:"artist,omitempty"` // split from Title when it has " - "
	Song   string `json:"song,omitempty"`
	Cover  string `json:"cover,omitempty"` // a /api/music/cover URL, when the station sends a cover image
}

type nowEntry struct {
	mu       sync.Mutex // one read of the stream at a time per station; others wait for its result
	np       nowPlaying
	at       time.Time
	coverURL string
	cover    []byte
	coverCT  string
}

func (e *nowEntry) get(ctx context.Context, i int) nowPlaying {
	e.mu.Lock()
	defer e.mu.Unlock()
	if time.Since(e.at) < nowPlayingTTL {
		return e.np
	}
	title, streamURL, err := readICY(ctx, musicStations[i].URL)
	if err != nil {
		e.at = time.Now().Add(nowFailTTL - nowPlayingTTL)
		if !errors.Is(err, errNoICY) {
			slog.Debug("now playing", "station", musicStations[i].Name, "err", err)
		}
		e.np = nowPlaying{}
		return e.np
	}
	e.at = time.Now()
	np := nowPlaying{Title: title}
	if a, s, ok := strings.Cut(title, " - "); ok {
		np.Artist, np.Song = strings.TrimSpace(a), strings.TrimSpace(s)
	}
	if isImageURL(streamURL) {
		if streamURL != e.coverURL {
			e.coverURL, e.cover, e.coverCT = streamURL, nil, ""
			if b, ct, err := fetchCover(ctx, streamURL); err == nil {
				e.cover, e.coverCT = b, ct
			}
		}
	} else {
		e.coverURL, e.cover, e.coverCT = "", nil, ""
	}
	if e.cover != nil {
		h := sha256.Sum256([]byte(e.coverURL))
		np.Cover = fmt.Sprintf("/api/music/cover?s=%d&v=%s", i, hex.EncodeToString(h[:6]))
	}
	e.np = np
	return np
}

var errNoICY = errors.New("stream sends no ICY metadata")

var musicClient = &http.Client{Timeout: 10 * time.Second}

// readICY connects to the stream, skips to the first metadata block and returns StreamTitle and StreamUrl.
// Only the first block is read (at most a few seconds of audio, typically 16 KB), then the connection is closed.
func readICY(ctx context.Context, link string) (title, streamURL string, err error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", link, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Icy-MetaData", "1")
	req.Header.Set("User-Agent", "Woogles-TV (now playing)")
	resp, err := musicClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", "", fmt.Errorf("status %d", resp.StatusCode)
	}
	every, _ := strconv.Atoi(resp.Header.Get("icy-metaint"))
	if every <= 0 || every > 1<<20 {
		return "", "", errNoICY
	}
	if _, err := io.CopyN(io.Discard, resp.Body, int64(every)); err != nil {
		return "", "", err
	}
	var n [1]byte
	if _, err := io.ReadFull(resp.Body, n[:]); err != nil {
		return "", "", err
	}
	meta := make([]byte, int(n[0])*16)
	if _, err := io.ReadFull(resp.Body, meta); err != nil {
		return "", "", err
	}
	s := strings.TrimRight(string(meta), "\x00")
	if !utf8.ValidString(s) { // older Shoutcast servers send Latin-1
		r := make([]rune, len(meta))
		for i, b := range []byte(s) {
			r[i] = rune(b)
		}
		s = string(r[:len(s)])
	}
	return icyField(s, "StreamTitle"), icyField(s, "StreamUrl"), nil
}

// icyField reads Key='value'; from ICY metadata. Values may contain quotes ("Don't Stop"), so a value ends at the
// "';" that starts the next field, or at the last quote.
func icyField(s, key string) string {
	i := strings.Index(s, key+"='")
	if i < 0 {
		return ""
	}
	v := s[i+len(key)+2:]
	if j := strings.Index(v, "';Stream"); j >= 0 {
		v = v[:j]
	} else if j := strings.LastIndex(v, "'"); j >= 0 {
		v = v[:j]
	}
	v = strings.TrimSpace(v)
	if len(v) > 300 {
		v = v[:300]
	}
	return v
}

func isImageURL(s string) bool {
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return false
	}
	p := strings.ToLower(u.Path)
	for _, ext := range []string{".jpg", ".jpeg", ".png", ".webp", ".gif"} {
		if strings.HasSuffix(p, ext) {
			return true
		}
	}
	return false
}

// Covers come from URLs inside the stream's metadata, so they're only fetched from public addresses: the server
// won't be talked into requesting something on its own machine or network.
var coverClient = &http.Client{
	Timeout: 10 * time.Second,
	Transport: &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{Timeout: 5 * time.Second, Control: func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			ip := net.ParseIP(host)
			if ip == nil || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
				ip.IsUnspecified() || ip.IsMulticast() {
				return errors.New("cover address is not public")
			}
			return nil
		}}).DialContext,
	},
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return errors.New("too many redirects")
		}
		return nil
	},
}

func fetchCover(ctx context.Context, link string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", link, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", "Woogles-TV (now playing)")
	resp, err := coverClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	ct := resp.Header.Get("Content-Type")
	if resp.StatusCode != 200 || !strings.HasPrefix(ct, "image/") || strings.Contains(ct, "svg") {
		return nil, "", fmt.Errorf("cover: status %d, type %q", resp.StatusCode, ct)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxCoverBytes+1))
	if err != nil || len(b) > maxCoverBytes {
		return nil, "", errors.New("cover too large")
	}
	return b, ct, nil
}

func stationParam(r *http.Request) (int, bool) {
	i, err := strconv.Atoi(r.URL.Query().Get("s"))
	return i, err == nil && i >= 0 && i < len(musicStations)
}

// GET /api/music/now?s=N: what station N is playing, {} if it doesn't say.
func handleMusicNow(w http.ResponseWriter, r *http.Request) {
	i, ok := stationParam(r)
	if !ok || !musicNowPlaying {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, musicNow[i].get(r.Context(), i))
}

// GET /api/music/cover?s=N: station N's current cover image (the v= parameter only defeats caching).
func handleMusicCover(w http.ResponseWriter, r *http.Request) {
	i, ok := stationParam(r)
	if !ok || !musicNowPlaying {
		http.NotFound(w, r)
		return
	}
	e := musicNow[i]
	e.mu.Lock()
	b, ct := e.cover, e.coverCT
	e.mu.Unlock()
	if b == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Write(b)
}
