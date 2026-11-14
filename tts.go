package main

// tts.go: optional server-side text-to-speech for the announcer.
//
// The TV page (and phones) write the sentences to announce; when WT_TTS_URL is set they can send them to
// POST /api/tts and get audio back, streamed as it is generated. The speech engine is a separate local service
// (audio.cpp serving Kyutai's Pocket TTS, see docs/TTS.md) that speaks the OpenAI-style /v1/audio/speech API.
// Only a room's TV or a seated player can use it, text is capped, and requests are rate limited per room and
// overall, so it can't be used as a general-purpose speech service. Devices fall back to their own speech
// (Android TV app bridge or Web Speech) when this fails or isn't configured.

import (
	"bytes"
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	ttsMaxText    = 700 // characters; a definition with two senses is ~400
	ttsSampleRate = 24000
	ttsSeed       = 7 // fixed noise seed: a voice always sounds the same, and audio can be cached
	ttsCacheBytes = 48 << 20
	ttsCacheItem  = 2 << 20
)

// Voices that start and stop too abruptly. Their recording has no breath before the first word, so the model starts
// mid-sound and the first consonant is lost ("Jon" heard as "on"), and they sometimes stop before the last word has
// finished. Commas, which aren't spoken, fix both: one in front gives a short breath (60-90 ms) first, one at the end
// lets the last word fade out. (The engine's frames_after_eos option has no effect.)
var ttsBreathFirst = map[string]bool{"cosette": true, "marius": true}

var defaultTTSVoices = "cosette,caro_davy,anna,azelma,charles,eve,fantine,jane,marius,mary,michael,paul,peter_yearsley,stuart_bell,vera"

type ttsVoice struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type ttsService struct {
	url, model string
	voices     []ttsVoice
	allowed    map[string]bool
	client     *http.Client
	slots      chan struct{} // requests in flight to the engine (it handles one at a time per model)
	global     *tokenBucket
	cache      *pcmCache
}

var tts *ttsService

// initTTS reads WT_TTS_URL, WT_TTS_MODEL and WT_TTS_VOICES. Voices are listed in menu order; the first is the default.
func initTTS() {
	u := strings.TrimRight(os.Getenv("WT_TTS_URL"), "/")
	if u == "" {
		return
	}
	model := os.Getenv("WT_TTS_MODEL")
	if model == "" {
		model = "pocket"
	}
	list := os.Getenv("WT_TTS_VOICES")
	if list == "" {
		list = defaultTTSVoices
	}
	s := &ttsService{url: u, model: model, allowed: map[string]bool{},
		client: &http.Client{Timeout: 90 * time.Second},
		slots:  make(chan struct{}, 3),
		global: newTokenBucket(3, 60), // 180 per minute across all rooms
		cache:  newPCMCache(ttsCacheBytes)}
	for _, id := range strings.Split(list, ",") {
		id = strings.TrimSpace(id)
		if id == "" || s.allowed[id] || !validVoiceID(id) {
			continue
		}
		s.allowed[id] = true
		s.voices = append(s.voices, ttsVoice{ID: id, Name: voiceName(id)})
	}
	if len(s.voices) == 0 {
		slog.Warn("WT_TTS_VOICES has no valid voices; server speech is off")
		return
	}
	tts = s
	slog.Info("server speech on", "url", u, "model", model, "voices", len(s.voices), "default", s.voices[0].ID)
}

func validVoiceID(id string) bool {
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return len(id) <= 40
}

// "peter_yearsley" -> "Peter Yearsley"
func voiceName(id string) string {
	parts := strings.FieldsFunc(id, func(r rune) bool { return r == '_' || r == '-' })
	for i, p := range parts {
		rs := []rune(p)
		rs[0] = unicode.ToUpper(rs[0])
		parts[i] = string(rs)
	}
	return strings.Join(parts, " ")
}

// ttsConfig is sent to pages in /api/config.
func ttsConfig() any {
	if tts == nil {
		return nil
	}
	return map[string]any{"voices": tts.voices, "sampleRate": ttsSampleRate}
}

// cleanTTSText removes control characters and collapses whitespace.
func cleanTTSText(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	return strings.Join(strings.Fields(s), " ")
}

var errTTSBusy = errors.New("speech engine busy")

// handleTTS: POST /api/tts {code, tvKey | token, text, voice}. Streams raw 16-bit mono PCM at 24 kHz.
func handleTTS(w http.ResponseWriter, r *http.Request) {
	if tts == nil {
		writeJSON(w, 404, map[string]string{"error": "server speech is off"})
		return
	}
	var req struct{ Code, TVKey, Token, Text, Voice string }
	if !readJSON(w, r, &req) {
		return
	}
	room := getRoom(req.Code)
	if room == nil {
		writeJSON(w, 403, map[string]string{"error": "forbidden"})
		return
	}
	// The room's TV, or a phone sitting in a seat (the join key alone isn't enough).
	ok := false
	if req.TVKey != "" {
		_, ok = room.authorize("tv", req.TVKey, "")
	} else if req.Token != "" {
		seat, _ := room.authorize("player", "", req.Token)
		ok = seat >= 0
	}
	if !ok {
		writeJSON(w, 403, map[string]string{"error": "forbidden"})
		return
	}
	text := cleanTTSText(req.Text)
	voice := req.Voice
	if voice == "" {
		voice = tts.voices[0].ID
	}
	if text == "" || len([]rune(text)) > ttsMaxText || !tts.allowed[voice] {
		writeJSON(w, 400, map[string]string{"error": "bad request"})
		return
	}
	key := ttsKey(tts.model, voice, text)
	stats.TTSRequests.Add(1)
	if pcm := tts.cache.get(key); pcm != nil {
		stats.TTSCacheHits.Add(1)
		writePCMHeaders(w, "hit")
		w.Write(pcm)
		return
	}
	if !room.ttsAllow() || !tts.global.allow() {
		stats.LimitTTS.Add(1)
		writeJSON(w, 429, map[string]string{"error": "too many announcements"})
		return
	}
	if err := tts.stream(r.Context(), w, key, voice, text); err != nil {
		if errors.Is(err, errTTSBusy) {
			stats.TTSBusy.Add(1)
			writeJSON(w, 503, map[string]string{"error": "speech engine busy"})
		} else {
			slog.Warn("tts", "err", err)
			stats.TTSErrors.Add(1)
			writeJSON(w, 502, map[string]string{"error": "speech engine unavailable"})
		}
	}
}

func writePCMHeaders(w http.ResponseWriter, cache string) {
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Sample-Rate", "24000")
	h.Set("X-Accel-Buffering", "no") // ask nginx-style proxies not to buffer the stream
	h.Set("X-TTS-Cache", cache)
}

func ttsKey(model, voice, text string) string {
	h := sha256.Sum256([]byte(model + "\x00" + voice + "\x00" + text))
	return hex.EncodeToString(h[:])
}

// stream asks the engine for streamed PCM and forwards each chunk as it arrives. It returns an error only if
// nothing has been written yet, so the caller can still send a clean error response (and the page can fall back).
func (s *ttsService) stream(ctx context.Context, w http.ResponseWriter, key, voice, text string) error {
	// Wait briefly for a slot: the engine works through requests one at a time, so a long queue means late speech.
	wait := time.NewTimer(4 * time.Second)
	defer wait.Stop()
	select {
	case s.slots <- struct{}{}:
	case <-wait.C:
		return errTTSBusy
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-s.slots }()

	if ttsBreathFirst[voice] {
		text = ", " + text + ","
	}
	body, _ := json.Marshal(map[string]any{"model": s.model, "voice": voice, "input": text,
		"response_format": "pcm", "stream_format": "audio", "seed": ttsSeed})
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url+"/v1/audio/speech", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return errors.New("engine status " + resp.Status + ": " + strings.TrimSpace(string(msg)))
	}
	// Don't answer until the first audio arrives: an unknown voice or a failed generation returns an empty body.
	buf := make([]byte, 32<<10)
	n, err := io.ReadAtLeast(resp.Body, buf, 2)
	if n == 0 {
		if err == nil || err == io.EOF || err == io.ErrUnexpectedEOF {
			err = errors.New("engine returned no audio")
		}
		return err
	}
	writePCMHeaders(w, "miss")
	fl, _ := w.(http.Flusher)
	var all []byte
	odd := byte(0)
	hasOdd := false
	for {
		chunk := buf[:n]
		if len(all)+len(chunk) <= ttsCacheItem {
			all = append(all, chunk...)
		} else {
			all = nil // too long to cache
		}
		// Keep chunks aligned to whole 16-bit samples so the page can decode each one on its own.
		if hasOdd {
			chunk = append([]byte{odd}, chunk...)
			hasOdd = false
		}
		if len(chunk)%2 == 1 {
			odd, hasOdd = chunk[len(chunk)-1], true
			chunk = chunk[:len(chunk)-1]
		}
		if _, werr := w.Write(chunk); werr != nil {
			return nil // the page went away
		}
		if fl != nil {
			fl.Flush()
		}
		n, err = resp.Body.Read(buf)
		if n == 0 && err != nil {
			break
		}
	}
	if err == io.EOF && all != nil && len(all) > 0 {
		s.cache.put(key, all)
	}
	return nil
}

// ttsAllow: per-room limit, generous for a busy game (moves, clock, definitions) but not for abuse.
func (r *Room) ttsAllow() bool {
	r.mu.Lock()
	if r.ttsLimit == nil {
		r.ttsLimit = newTokenBucket(1, 30) // 60 per minute, bursts of 30
	}
	b := r.ttsLimit
	r.mu.Unlock()
	return b.allow()
}

// pcmCache is a small LRU of finished clips (repeated phrases: clock warnings, "The bag is empty.", menu samples).
type pcmCache struct {
	mu    sync.Mutex
	max   int
	size  int
	order *list.List
	items map[string]*list.Element
}

func (c *pcmCache) megabytes() float64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return float64(c.size) / (1 << 20)
}

type pcmEntry struct {
	key string
	pcm []byte
}

func newPCMCache(max int) *pcmCache {
	return &pcmCache{max: max, order: list.New(), items: map[string]*list.Element{}}
}

func (c *pcmCache) get(key string) []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.items[key]; ok {
		c.order.MoveToFront(e)
		return e.Value.(*pcmEntry).pcm
	}
	return nil
}

func (c *pcmCache) put(key string, pcm []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.items[key]; ok || len(pcm) > c.max {
		return
	}
	c.items[key] = c.order.PushFront(&pcmEntry{key, pcm})
	c.size += len(pcm)
	for c.size > c.max {
		e := c.order.Back()
		pe := e.Value.(*pcmEntry)
		c.order.Remove(e)
		delete(c.items, pe.key)
		c.size -= len(pe.pcm)
	}
}
