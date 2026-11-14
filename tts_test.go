package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// fakeEngine stands in for audio.cpp: it streams 1000 bytes of "PCM" for known voices and an empty body otherwise
// (which is what audio.cpp does for an unknown voice).
func fakeEngine(t *testing.T, calls *int32) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(calls, 1)
		var req map[string]any
		json.NewDecoder(r.Body).Decode(&req)
		if r.URL.Path != "/v1/audio/speech" || req["response_format"] != "pcm" || req["stream_format"] != "audio" || req["seed"] == nil {
			t.Errorf("unexpected engine request %s %v", r.URL.Path, req)
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		if req["voice"] == "silent" {
			return
		}
		for i := 0; i < 10; i++ {
			w.Write(bytes.Repeat([]byte{byte(i)}, 100))
			w.(http.Flusher).Flush()
		}
	}))
}

func ttsPost(t *testing.T, body map[string]string) (int, []byte, http.Header) {
	t.Helper()
	b, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	handleTTS(rec, httptest.NewRequest("POST", "/api/tts", bytes.NewReader(b)))
	out, _ := io.ReadAll(rec.Body)
	return rec.Code, out, rec.Header()
}

func TestTTS(t *testing.T) {
	var calls int32
	eng := fakeEngine(t, &calls)
	defer eng.Close()
	t.Setenv("WT_TTS_URL", eng.URL)
	t.Setenv("WT_TTS_VOICES", "cosette, caro_davy,silent,bad voice!,cosette")
	initTTS()
	defer func() { tts = nil }()
	if got := len(tts.voices); got != 3 || tts.voices[0].ID != "cosette" || tts.voices[1].Name != "Caro Davy" {
		t.Fatalf("voices: %+v", tts.voices)
	}

	r := newTestRoom(t)
	rooms[r.Code] = r
	defer delete(rooms, r.Code)
	r.seats[0] = &Seat{Name: "Alex", Token: newSecret()}

	cases := []struct {
		name string
		body map[string]string
		code int
	}{
		{"tv key", map[string]string{"code": r.Code, "tvKey": r.TVKey, "text": "Alex plays zoea for 34 points."}, 200},
		{"seat token", map[string]string{"code": r.Code, "token": r.seats[0].Token, "text": "One minute left.", "voice": "caro_davy"}, 200},
		{"join key is not enough", map[string]string{"code": r.Code, "token": r.JoinKey, "text": "hi"}, 403},
		{"wrong tv key", map[string]string{"code": r.Code, "tvKey": "nope", "text": "hi"}, 403},
		{"no room", map[string]string{"code": "ZZZZZZ", "tvKey": r.TVKey, "text": "hi"}, 403},
		{"voice not offered", map[string]string{"code": r.Code, "tvKey": r.TVKey, "text": "hi", "voice": "javert"}, 400},
		{"empty text", map[string]string{"code": r.Code, "tvKey": r.TVKey, "text": " \n "}, 400},
		{"too long", map[string]string{"code": r.Code, "tvKey": r.TVKey, "text": string(bytes.Repeat([]byte("a"), ttsMaxText+1))}, 400},
		{"engine sends nothing", map[string]string{"code": r.Code, "tvKey": r.TVKey, "text": "hi", "voice": "silent"}, 502},
	}
	for _, c := range cases {
		code, body, h := ttsPost(t, c.body)
		if code != c.code {
			t.Errorf("%s: status %d want %d (%s)", c.name, code, c.code, body)
		}
		if code == 200 && (len(body) != 1000 || h.Get("X-Sample-Rate") != "24000") {
			t.Errorf("%s: %d bytes, rate %q", c.name, len(body), h.Get("X-Sample-Rate"))
		}
	}

	// The same sentence again comes from the cache without asking the engine.
	before := atomic.LoadInt32(&calls)
	code, body, h := ttsPost(t, map[string]string{"code": r.Code, "tvKey": r.TVKey, "text": "Alex  plays zoea for 34 points."})
	if code != 200 || len(body) != 1000 || h.Get("X-TTS-Cache") != "hit" || atomic.LoadInt32(&calls) != before {
		t.Errorf("cache: status %d, %d bytes, cache %q, engine calls %d→%d", code, len(body), h.Get("X-TTS-Cache"), before, calls)
	}

	// Engine down: a clean error, so the page can fall back to the device's voice.
	eng.Close()
	if code, _, _ := ttsPost(t, map[string]string{"code": r.Code, "tvKey": r.TVKey, "text": "Engine down."}); code != 502 {
		t.Errorf("engine down: status %d want 502", code)
	}
}

func TestTTSOff(t *testing.T) {
	tts = nil
	if code, _, _ := ttsPost(t, map[string]string{"code": "ABCDEF", "text": "hi"}); code != 404 {
		t.Errorf("tts off: status %d want 404", code)
	}
	if ttsConfig() != nil {
		t.Error("config should be nil when off")
	}
}

func TestPCMCacheEvicts(t *testing.T) {
	c := newPCMCache(250)
	c.put("a", make([]byte, 100))
	c.put("b", make([]byte, 100))
	c.get("a") // a is now the most recent
	c.put("c", make([]byte, 100))
	if c.get("b") != nil || c.get("a") == nil || c.get("c") == nil || c.size != 200 {
		t.Errorf("LRU eviction wrong: size %d", c.size)
	}
}
