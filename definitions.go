package main

// Word definitions for words already played. Macondo's word lists (KWG files) contain no definitions, so they come
// from Woogles.io's public word service (the definitions behind the NWL/CSW lexica), with dictionaryapi.dev as a
// fallback for common English words. Results are cached; lookups are limited per room and globally.
//
// Config: WT_DEFINITIONS=off disables the feature; WT_DEFINE_URL overrides the Woogles endpoint.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

type Sense struct {
	POS  string `json:"pos,omitempty"` // "noun", "verb", ...
	Text string `json:"text"`
}

type Definition struct {
	Word   string  `json:"word"`
	Senses []Sense `json:"senses"`
	Source string  `json:"source,omitempty"` // "woogles" | "dictionaryapi" | ""
}

type definer struct {
	enabled    bool
	wooglesURL string
	client     *http.Client
	mu         sync.Mutex
	cache      map[string]cachedDef
	limit      *tokenBucket // outgoing lookups, all rooms
}

type cachedDef struct {
	d  Definition
	at time.Time
}

var defs = newDefiner()

func newDefiner() *definer {
	u := os.Getenv("WT_DEFINE_URL")
	if u == "" {
		u = "https://woogles.io/api/word_service.WordService/DefineWords"
	}
	return &definer{
		enabled:    !strings.EqualFold(os.Getenv("WT_DEFINITIONS"), "off"),
		wooglesURL: u,
		client:     &http.Client{Timeout: 6 * time.Second},
		cache:      map[string]cachedDef{},
		limit:      newTokenBucket(1, 30), // ~60 lookups/minute after a burst of 30
	}
}

var errNoDefs = errors.New("Definitions are turned off on this server")

// Define looks up one word (already validated as played on the board).
func (d *definer) Define(ctx context.Context, lexicon, word string) (Definition, error) {
	if !d.enabled {
		return Definition{}, errNoDefs
	}
	word = strings.ToUpper(word)
	key := lexicon + ":" + word
	stats.DefLookups.Add(1)
	d.mu.Lock()
	if c, ok := d.cache[key]; ok && (len(c.d.Senses) > 0 || time.Since(c.at) < 10*time.Minute) {
		d.mu.Unlock()
		stats.DefCacheHits.Add(1)
		return c.d, nil
	}
	d.mu.Unlock()
	if !d.limit.allow() {
		stats.LimitDefine.Add(1)
		return Definition{}, errors.New("Too many lookups — try again in a minute")
	}
	def := Definition{Word: word}
	raw, err := d.woogles(ctx, lexicon, word)
	if err == nil && raw != "" {
		def.Senses, def.Source = parseWooglesDef(raw), "woogles"
	}
	if len(def.Senses) == 0 {
		if s, err2 := d.dictionaryAPI(ctx, word); err2 == nil && len(s) > 0 {
			def.Senses, def.Source = s, "dictionaryapi"
		} else if err != nil && err2 != nil {
			stats.DefFailures.Add(1)
			return def, errors.New("Couldn't reach the dictionary — try again later")
		}
	}
	d.mu.Lock()
	if len(d.cache) > 20000 { // crude cap: start over
		d.cache = map[string]cachedDef{}
	}
	d.cache[key] = cachedDef{def, time.Now()}
	d.mu.Unlock()
	return def, nil
}

func (d *definer) woogles(ctx context.Context, lexicon, word string) (string, error) {
	body, _ := json.Marshal(map[string]any{"lexicon": lexicon, "words": []string{word}, "definitions": true})
	req, err := http.NewRequestWithContext(ctx, "POST", d.wooglesURL, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Woogles-TV (+https://github.com/jgbrwn/woogles-tv)")
	resp, err := d.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("woogles: %s", resp.Status)
	}
	var out struct {
		Results map[string]struct {
			D string `json:"d"`
			V bool   `json:"v"`
		} `json:"results"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 1<<20)).Decode(&out); err != nil {
		return "", err
	}
	return out.Results[word].D, nil
}

func (d *definer) dictionaryAPI(ctx context.Context, word string) ([]Sense, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.dictionaryapi.dev/api/v2/entries/en/"+url.PathEscape(strings.ToLower(word)), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Woogles-TV (+https://github.com/jgbrwn/woogles-tv)")
	resp, err := d.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return nil, nil
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("dictionaryapi: %s", resp.Status)
	}
	var out []struct {
		Meanings []struct {
			PartOfSpeech string `json:"partOfSpeech"`
			Definitions  []struct {
				Definition string `json:"definition"`
			} `json:"definitions"`
		} `json:"meanings"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 1<<20)).Decode(&out); err != nil {
		return nil, err
	}
	var senses []Sense
	for _, e := range out {
		for _, m := range e.Meanings {
			if len(m.Definitions) > 0 && len(senses) < 3 {
				senses = append(senses, Sense{POS: m.PartOfSpeech, Text: strings.TrimSuffix(strings.TrimSpace(m.Definitions[0].Definition), ".")})
			}
		}
	}
	return senses, nil
}

var (
	reBracket = regexp.MustCompile(`\s*\[([^\]]*)\]`)
	reOrigin  = regexp.MustCompile(`^\([^)]*\)\s*`)
	reAlso    = regexp.MustCompile(`,?\s+also\s+[A-Z][A-Z ,]*(\s+or\s+[A-Z]+)*$`)
	reDerived = regexp.MustCompile(`\s+:\s+[A-Z].*$`)
)

var posNames = map[string]string{"n": "noun", "v": "verb", "adj": "adjective", "adv": "adverb", "interj": "interjection",
	"prep": "preposition", "conj": "conjunction", "pron": "pronoun"}

// parseWooglesDef turns e.g.
//
//	"to cover with lead [v LEADED, LEADING, LEADS] / to show the way [v LEADING, LEADS, LED] : LEADABLE [adj]"
//	"(Chinese) a life force, also KI [n -S]"
//
// into readable senses with a part of speech.
func parseWooglesDef(raw string) []Sense {
	var out []Sense
	for _, part := range strings.Split(raw, " / ") {
		part = reDerived.ReplaceAllString(strings.TrimSpace(part), "")
		pos := ""
		if m := reBracket.FindStringSubmatch(part); m != nil {
			f := strings.Fields(m[1])
			if len(f) > 0 {
				pos = posNames[f[0]]
			}
		}
		t := reBracket.ReplaceAllString(part, "")
		t = reOrigin.ReplaceAllString(t, "")
		t = strings.TrimSpace(reAlso.ReplaceAllString(t, ""))
		if t != "" {
			out = append(out, Sense{POS: pos, Text: t})
		}
	}
	return out
}
