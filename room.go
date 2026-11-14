package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	maxRooms          = 500
	maxClientsPerRoom = 16
	roomIdleTTL       = 72 * time.Hour
	gameIdleTTL       = 7 * 24 * time.Hour // rooms with an unfinished game are kept longer
	maxOvertime       = 10 * time.Minute   // NASPA: exceeding 10 min of overtime loses the game
)

var TimeOptions = []int{0, 15, 30, 45, 60, 75, 90, 105, 120} // minutes per player for the whole game; 0 = untimed

var Themes = []string{"woogles", "woogles-dark", "balsa", "forest", "pastel", "midnight"}

type Client struct {
	role   string // "tv" | "player"
	seat   int    // -1 if not seated
	send   chan []byte
	bucket *tokenBucket
	voice  bool // TV only: its announcer is on and can speak (reported by the TV)
}

type Seat struct {
	Name  string `json:"name"`
	Token string `json:"token,omitempty"`
	Bot   bool   `json:"bot,omitempty"`
	Level string `json:"level,omitempty"` // bot strength id
}

type PreviewState struct {
	Seat  int    `json:"seat"`
	Tiles []Tile `json:"tiles"`
	Score *int   `json:"score"`
	Err   string `json:"err,omitempty"`
}

type Settings struct {
	Lexicon string `json:"lexicon"`
	TimeMin int    `json:"timeMin"`
	Theme   string `json:"theme"`
	Bot     string `json:"bot"` // computer opponent strength
}

// Clock is a NASPA-style chess clock: each player has a total time bank for the whole game.
// Remaining is indexed by seat and may go negative (overtime).
type Clock struct {
	InitialMs int64    `json:"initialMs"`
	Remaining [2]int64 `json:"remaining"`
	Running   int      `json:"running"` // seat whose clock runs, -1 = stopped
	Paused    bool     `json:"paused"`
	since     time.Time
}

func (c *Clock) charge(now time.Time) {
	if c.Running >= 0 && !c.Paused && !c.since.IsZero() {
		c.Remaining[c.Running] -= now.Sub(c.since).Milliseconds()
	}
	c.since = now
}

func (c *Clock) live(seat int, now time.Time) int64 {
	r := c.Remaining[seat]
	if c.Running == seat && !c.Paused && !c.since.IsZero() {
		r -= now.Sub(c.since).Milliseconds()
	}
	return r
}

// overtimePenalty: 10 points per minute or fraction of a minute of overtime (NASPA rule).
func overtimePenalty(remainingMs int64) int {
	if remainingMs >= 0 {
		return 0
	}
	over := -remainingMs
	return int(10 * ((over + 59999) / 60000))
}

// Match holds one game's state on top of the Macondo engine.
type Match struct {
	eng       *Engine
	Clock     *Clock    `json:"clock,omitempty"`
	Adj       [2]int    `json:"adj"`                 // score adjustments by seat (time penalties)
	EndReason string    `json:"endReason,omitempty"` // "", "time", "resign"
	Winner    *int      `json:"winner,omitempty"`    // forced winner seat (time/resign)
	Extra     []MoveLog `json:"extra,omitempty"`     // penalty log entries (seat-indexed)
}

type Room struct {
	Code    string
	JoinKey string
	TVKey   string
	mu      sync.Mutex
	seats   [2]*Seat
	clients map[*Client]bool
	m       *Match
	// order[engineIdx] = seat. Swapped on rematch so the other seat starts.
	order     [2]int
	settings  Settings
	preview   *PreviewState
	gameNo    int
	lastUsed  time.Time
	baseURL   string
	deleted   bool
	linkLimit *tokenBucket
	defLimit  *tokenBucket // word definition lookups
	ttsLimit  *tokenBucket // server speech (tts.go), created on first use
}

var globalJoin = newTokenBucket(5, 100) // 300/minute across everyone: code lookups + TV links

// linkTV sends room `to` (credentials included) to the TV clients currently showing room `code`.
func linkTV(code string, to *Room, from string) error {
	tvRoom := getRoom(code)
	if tvRoom == to {
		return errors.New("That TV is already showing this game")
	}
	if tvRoom == nil {
		time.Sleep(300 * time.Millisecond)
		return errors.New("No TV is showing that code")
	}
	to.mu.Lock()
	msg := map[string]any{"t": "switch", "code": to.Code, "tvKey": to.TVKey, "from": from}
	to.mu.Unlock()
	tvRoom.mu.Lock()
	defer tvRoom.mu.Unlock()
	msg["ask"] = tvRoom.playingLocked() // don't yank a TV out of a game in progress without OK
	n := 0
	for c := range tvRoom.clients {
		if c.role == "tv" {
			sendJSON(c, msg)
			n++
		}
	}
	if n == 0 {
		return errors.New("That TV isn't connected right now")
	}
	return nil
}

var (
	roomsMu  sync.Mutex
	rooms    = map[string]*Room{}
	roomsDir string
)

const codeAlphabet = "BCDFGHJKLMNPQRSTVWXZ" // no vowels -> no accidental words
const codeLen = 6

func newCode() string {
	var sb strings.Builder
	for i := 0; i < codeLen; i++ {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(codeAlphabet))))
		sb.WriteByte(codeAlphabet[n.Int64()])
	}
	return sb.String()
}

// newSecret returns 128 bits of randomness, URL-safe.
func newSecret() string {
	b := make([]byte, 16)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func secretEq(a, b string) bool {
	return a != "" && b != "" && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

var errTooManyRooms = errors.New("server is busy, try again later")

func createRoom(base string) (*Room, error) {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	if len(rooms) >= maxRooms {
		return nil, errTooManyRooms
	}
	code := newCode()
	for rooms[code] != nil {
		code = newCode()
	}
	r := &Room{Code: code, JoinKey: newSecret(), TVKey: newSecret(), clients: map[*Client]bool{}, linkLimit: newTokenBucket(0.1, 5), defLimit: newTokenBucket(0.2, 8),
		order: [2]int{0, 1}, settings: Settings{Lexicon: Lexicons[0], Theme: Themes[0], Bot: "better"}, lastUsed: time.Now(), baseURL: base}
	rooms[code] = r
	r.mu.Lock()
	r.saveLocked()
	r.mu.Unlock()
	return r, nil
}

func getRoom(code string) *Room {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	return rooms[strings.ToUpper(strings.TrimSpace(code))]
}

func (r *Room) joinURL() string {
	base := r.baseURL
	if pub := os.Getenv("PUBLIC_URL"); pub != "" {
		base = strings.TrimRight(pub, "/")
	}
	return base + "/p/" + r.Code + "#k=" + r.JoinKey
}

func reapRooms() {
	for range time.Tick(10 * time.Minute) {
		roomsMu.Lock()
		for k, r := range rooms {
			r.mu.Lock()
			idle := len(r.clients) == 0 && time.Since(r.lastUsed) > r.ttlLocked()
			if idle {
				r.deleted = true
				os.Remove(r.file())
			}
			r.mu.Unlock()
			if idle {
				delete(rooms, k)
			}
		}
		roomsMu.Unlock()
	}
}

// clockWatch enforces the NASPA 10-minutes-of-overtime limit.
func clockWatch() {
	for range time.Tick(500 * time.Millisecond) {
		roomsMu.Lock()
		list := make([]*Room, 0, len(rooms))
		for _, r := range rooms {
			list = append(list, r)
		}
		roomsMu.Unlock()
		now := time.Now()
		for _, r := range list {
			r.mu.Lock()
			if r.m != nil && !r.overLocked() && r.m.Clock != nil {
				c := r.m.Clock
				if c.Running >= 0 && c.live(c.Running, now) < -maxOvertime.Milliseconds() {
					r.timeLossLocked(c.Running)
				}
			}
			r.mu.Unlock()
		}
	}
}

// ---- persistence ----

type savedRoom struct {
	Code     string          `json:"code"`
	JoinKey  string          `json:"joinKey"`
	TVKey    string          `json:"tvKey"`
	Seats    [2]*Seat        `json:"seats"`
	Order    [2]int          `json:"order"`
	Settings Settings        `json:"settings"`
	GameNo   int             `json:"gameNo"`
	LastUsed time.Time       `json:"lastUsed"`
	BaseURL  string          `json:"baseUrl"`
	Match    *Match          `json:"match,omitempty"`
	Lexicon  string          `json:"lexicon,omitempty"` // lexicon of the current match
	History  json.RawMessage `json:"history,omitempty"`
}

func (r *Room) file() string { return filepath.Join(roomsDir, r.Code+".json") }

func (r *Room) saveLocked() {
	if roomsDir == "" || r.deleted {
		return
	}
	sr := savedRoom{Code: r.Code, JoinKey: r.JoinKey, TVKey: r.TVKey, Seats: r.seats, Order: r.order,
		Settings: r.settings, GameNo: r.gameNo, LastUsed: r.lastUsed, BaseURL: r.baseURL}
	if r.m != nil {
		if r.m.Clock != nil {
			r.m.Clock.charge(time.Now())
		}
		h, err := r.m.eng.HistoryJSON()
		if err != nil {
			slog.Error("save history", "room", r.Code, "err", err)
			return
		}
		sr.Match, sr.Lexicon, sr.History = r.m, r.m.eng.Lexicon, h
	}
	b, err := json.Marshal(sr)
	if err != nil {
		slog.Error("save room", "room", r.Code, "err", err)
		return
	}
	tmp := r.file() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		slog.Error("save room", "room", r.Code, "err", err)
		return
	}
	os.Rename(tmp, r.file())
}

func loadRooms(dir string) error {
	roomsDir = dir
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	n := 0
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var sr savedRoom
		if err := json.Unmarshal(b, &sr); err != nil || sr.Code == "" {
			slog.Warn("bad room file", "file", f, "err", err)
			continue
		}
		ttl := roomIdleTTL
		if sr.Match != nil && sr.Match.EndReason == "" {
			ttl = gameIdleTTL // may be finished; the reaper re-checks precisely
		}
		if time.Since(sr.LastUsed) > ttl {
			os.Remove(f)
			continue
		}
		r := &Room{Code: sr.Code, JoinKey: sr.JoinKey, TVKey: sr.TVKey, seats: sr.Seats, order: sr.Order,
			settings: sr.Settings, gameNo: sr.GameNo, lastUsed: sr.LastUsed, baseURL: sr.BaseURL, clients: map[*Client]bool{}, linkLimit: newTokenBucket(0.1, 5), defLimit: newTokenBucket(0.2, 8)}
		if r.settings.Bot == "" {
			r.settings.Bot = "better"
		}
		if sr.Match != nil && len(sr.History) > 0 {
			eng, err := RestoreEngine(sr.Lexicon, sr.History)
			if err != nil {
				slog.Warn("restore game", "room", sr.Code, "err", err)
			} else {
				r.m = sr.Match
				r.m.eng = eng
				if r.m.Clock != nil {
					r.m.Clock.since = time.Now() // downtime isn't charged to anyone
				}
			}
		}
		rooms[r.Code] = r
		r.mu.Lock()
		r.maybeBotLocked()
		r.mu.Unlock()
		n++
	}
	slog.Info("rooms restored", "count", n)
	return nil
}

// ---- websocket handling ----

type inMsg struct {
	T       string `json:"t"`
	Name    string `json:"name"`
	Seat    int    `json:"seat"`
	Tiles   []Tile `json:"tiles"`
	Letters string `json:"letters"`
	Lexicon string `json:"lexicon"`
	TimeMin *int   `json:"timeMin"`
	Theme   string `json:"theme"`
	Bot     string `json:"bot"`
	Code    string `json:"code"`
	Move    *int   `json:"move"`  // define: index into the game log
	Voice   *bool  `json:"voice"` // tvprefs: the TV's announcer is on
}

// authorize decides the client's role. Players need the room's join key (from the QR code)
// or a seat token from an earlier join; the TV needs the TV key it received when creating the room.
func (r *Room) authorize(role, key, token string) (seat int, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if role == "tv" {
		return -1, secretEq(key, r.TVKey)
	}
	for i, s := range r.seats {
		if s != nil && !s.Bot && secretEq(token, s.Token) {
			return i, true
		}
	}
	return -1, secretEq(key, r.JoinKey)
}

func (r *Room) serve(ctx context.Context, c *websocket.Conn, role string, seat int) {
	c.SetReadLimit(16 << 10)
	cl := &Client{role: role, seat: seat, send: make(chan []byte, 64), bucket: newTokenBucket(15, 40)}
	r.mu.Lock()
	if len(r.clients) >= maxClientsPerRoom {
		r.mu.Unlock()
		c.Close(websocket.StatusTryAgainLater, "room full")
		return
	}
	r.clients[cl] = true
	r.lastUsed = time.Now()
	r.broadcastLocked()
	r.mu.Unlock()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		ping := time.NewTicker(20 * time.Second)
		defer ping.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case b := <-cl.send:
				wctx, wc := context.WithTimeout(ctx, 10*time.Second)
				err := c.Write(wctx, websocket.MessageText, b)
				wc()
				if err != nil {
					cancel()
					return
				}
			case <-ping.C:
				pctx, pc := context.WithTimeout(ctx, 10*time.Second)
				err := c.Ping(pctx)
				pc()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			break
		}
		if !cl.bucket.allow() {
			continue // flood protection
		}
		var m inMsg
		if json.Unmarshal(data, &m) != nil || len(m.Tiles) > 7 || len(m.Letters) > 7 {
			continue
		}
		r.handle(cl, m)
	}
	r.mu.Lock()
	delete(r.clients, cl)
	r.broadcastLocked()
	r.mu.Unlock()
}

func sendJSON(cl *Client, v any) {
	b, _ := json.Marshal(v)
	select {
	case cl.send <- b:
	default: // slow client; drop
	}
}

func (r *Room) errTo(cl *Client, msg string) {
	sendJSON(cl, map[string]any{"t": "error", "msg": msg})
}

func (r *Room) engIdx(seat int) int {
	if r.order[0] == seat {
		return 0
	}
	return 1
}

// enginePlayer maps a seat to the engine's player index (seats and engine order differ when the second seat starts).
func (r *Room) enginePlayer(seat int) int {
	for i, s := range r.order {
		if s == seat {
			return i
		}
	}
	return -1
}

func (r *Room) seatOnTurn() int {
	if r.m == nil {
		return -1
	}
	return r.order[r.m.eng.OnTurn()]
}

func (r *Room) overLocked() bool {
	return r.m != nil && (r.m.eng.Over() || r.m.EndReason != "")
}

func (r *Room) playingLocked() bool { return r.m != nil && !r.overLocked() }

// score returns the seat's score including time penalties/adjustments.
func (r *Room) score(seat int) int {
	return r.m.eng.Score(r.engIdx(seat)) + r.m.Adj[seat]
}

func (r *Room) winnerLocked() int {
	if r.m.Winner != nil {
		return *r.m.Winner
	}
	a, b := r.score(0), r.score(1)
	switch {
	case a > b:
		return 0
	case b > a:
		return 1
	}
	return -1
}

func validName(name string, seat int) string {
	name = strings.Map(func(r rune) rune {
		if r < 32 || r == 0x7f || (r >= 0x200b && r <= 0x200f) || (r >= 0x202a && r <= 0x202e) {
			return -1
		}
		return r
	}, strings.TrimSpace(name))
	if len([]rune(name)) > 16 {
		name = string([]rune(name)[:16])
	}
	if name == "" {
		name = []string{"Player 1", "Player 2"}[seat]
	}
	return name
}

func (r *Room) handle(cl *Client, m inMsg) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lastUsed = time.Now()
	defer func() {
		if p := recover(); p != nil {
			slog.Error("panic in handler", "err", p, "msg", m.T, "room", r.Code)
			r.errTo(cl, "Something went wrong")
		}
	}()
	isPlayer := cl.role == "player"
	switch m.T {
	case "join":
		if !isPlayer || m.Seat < 0 || m.Seat > 1 {
			return
		}
		s := r.seats[m.Seat]
		if s != nil && r.seatConnected(m.Seat) {
			r.errTo(cl, "That seat is taken")
			return
		}
		if cl.seat >= 0 && cl.seat != m.Seat {
			r.errTo(cl, "You already have a seat")
			return
		}
		if s == nil {
			s = &Seat{}
			r.seats[m.Seat] = s
		}
		name := validName(m.Name, m.Seat)
		if r.m != nil && s.Name != "" {
			name = s.Name // mid-game takeover keeps the seat's name
		}
		// Taking over a disconnected seat gets a fresh token (old phone is locked out).
		s.Name, s.Token, s.Bot = name, newSecret(), false
		cl.seat = m.Seat
		sendJSON(cl, map[string]any{"t": "joined", "seat": m.Seat, "token": s.Token})
		r.broadcastLocked()
	case "addbot":
		if cl.seat < 0 || r.playingLocked() {
			return
		}
		other := 1 - cl.seat
		if r.seats[other] != nil && !r.seats[other].Bot && r.seatConnected(other) {
			r.errTo(cl, "Seat is taken by a player")
			return
		}
		lv := botLevel(r.settings.Bot)
		r.seats[other] = &Seat{Name: lv.Name, Bot: true, Level: lv.ID}
		r.broadcastLocked()
	case "removebot":
		if cl.seat < 0 || r.playingLocked() {
			return
		}
		for i, s := range r.seats {
			if s != nil && s.Bot {
				r.seats[i] = nil
			}
		}
		r.broadcastLocked()
	case "leave":
		if cl.seat >= 0 && !r.playingLocked() {
			r.seats[cl.seat] = nil
			cl.seat = -1
		}
		r.broadcastLocked()
	case "settings":
		if cl.seat < 0 && cl.role != "tv" {
			return
		}
		for _, t := range Themes {
			if t == m.Theme {
				r.settings.Theme = t
			}
		}
		if !r.playingLocked() && cl.seat >= 0 {
			if m.Bot != "" {
				lv := botLevel(m.Bot)
				r.settings.Bot = lv.ID
				for _, s := range r.seats {
					if s != nil && s.Bot {
						s.Name, s.Level = lv.Name, lv.ID
					}
				}
			}
			for _, l := range Lexicons {
				if l == m.Lexicon {
					r.settings.Lexicon = l
				}
			}
			if m.TimeMin != nil {
				for _, t := range TimeOptions {
					if t == *m.TimeMin {
						r.settings.TimeMin = t
					}
				}
			}
		}
		r.broadcastLocked()
	case "start":
		if cl.seat < 0 || r.seats[0] == nil || r.seats[1] == nil {
			r.errTo(cl, "Need two players to start")
			return
		}
		if r.playingLocked() {
			return
		}
		if r.m != nil { // rematch: other seat starts
			r.order = [2]int{r.order[1], r.order[0]}
		}
		eng, err := NewEngine(r.settings.Lexicon, [2]string{r.seats[r.order[0]].Name, r.seats[r.order[1]].Name})
		if err != nil {
			r.errTo(cl, err.Error())
			return
		}
		r.m = &Match{eng: eng}
		if r.settings.TimeMin > 0 {
			ms := int64(r.settings.TimeMin) * 60000
			r.m.Clock = &Clock{InitialMs: ms, Remaining: [2]int64{ms, ms}, Running: r.seatOnTurn(), since: time.Now()}
		}
		r.gameNo++
		r.preview = nil
		r.eventLocked(map[string]any{"t": "event", "kind": "start"})
		r.broadcastLocked()
		r.maybeBotLocked()
	case "end": // abandon current game, back to lobby
		if cl.seat < 0 || r.m == nil {
			return
		}
		r.m = nil
		r.preview = nil
		r.broadcastLocked()
	case "resign":
		if cl.seat < 0 || !r.playingLocked() {
			return
		}
		if r.m.Clock != nil {
			r.m.Clock.charge(time.Now())
			r.m.Clock.Running = -1
		}
		w := 1 - cl.seat
		r.m.Winner, r.m.EndReason = &w, "resign"
		r.preview = nil
		r.eventLocked(map[string]any{"t": "event", "kind": "resign", "seat": cl.seat})
		r.broadcastLocked()
	case "pause", "resume":
		if cl.seat < 0 || !r.playingLocked() || r.m.Clock == nil {
			return
		}
		r.m.Clock.charge(time.Now())
		r.m.Clock.Paused = m.T == "pause"
		r.eventLocked(map[string]any{"t": "event", "kind": m.T, "seat": cl.seat})
		r.broadcastLocked()
	case "tvprefs":
		if cl.role == "tv" && m.Voice != nil {
			cl.voice = *m.Voice
		}
	case "define":
		// Look up the definition of a word that has been played (never anything else, so this can't be used as a
		// general dictionary proxy). The TVs get it to announce; the asker gets it to show (and speak if no TV will).
		if r.m == nil || m.Move == nil || (cl.seat < 0 && cl.role != "player") {
			return
		}
		log := r.m.eng.Log()
		i := *m.Move
		if i < 0 || i >= len(log) || log[i].Type != "play" || len(log[i].Words) == 0 {
			return
		}
		if !r.defLimit.allow() {
			r.errTo(cl, "Too many lookups — wait a moment")
			return
		}
		mv := log[i]
		mv.Player = r.order[mv.Player]
		lex, gameNo, by := r.m.eng.Lexicon, r.gameNo, ""
		if cl.seat >= 0 && r.seats[cl.seat] != nil {
			by = r.seats[cl.seat].Name
		}
		go r.define(cl, lex, gameNo, i, mv, by)
	case "linktv":
		// A phone asks the TV showing `code` (another room, e.g. the TV app's idle lobby) to show this game.
		// The TV gets this room's TV key; the phone learns nothing about the TV's room.
		if cl.seat < 0 {
			return
		}
		if !r.linkLimit.allow() || !globalJoin.allow() {
			r.errTo(cl, "Too many tries — wait a minute")
			return
		}
		from := r.seats[cl.seat].Name
		r.mu.Unlock()
		err := linkTV(m.Code, r, from)
		r.mu.Lock()
		if err != nil {
			r.errTo(cl, err.Error())
			return
		}
		sendJSON(cl, map[string]any{"t": "notice", "msg": "Sent to the TV — it should switch in a moment"})
	case "preview":
		// Tentative tiles are private: only the placing player's own devices see the score preview. Players may also
		// preview while waiting for their turn (scored against the current board and their own rack).
		if !r.playingLocked() || cl.seat < 0 {
			return
		}
		player := r.enginePlayer(cl.seat)
		if player < 0 {
			return
		}
		p := &PreviewState{Seat: cl.seat, Tiles: m.Tiles}
		if len(m.Tiles) > 0 {
			tiles := append([]Tile(nil), m.Tiles...)
			if sc, err := r.m.eng.Preview(player, tiles); err == nil {
				p.Score = &sc
			} else {
				p.Err = err.Error()
			}
		}
		sendJSON(cl, map[string]any{"t": "preview", "preview": p})
	case "play", "pass", "exchange":
		if !r.playingLocked() {
			return
		}
		if cl.seat < 0 || cl.seat != r.seatOnTurn() {
			r.errTo(cl, "It's not your turn")
			return
		}
		if r.m.Clock != nil && r.m.Clock.Paused {
			r.errTo(cl, "The clock is paused — resume it first")
			return
		}
		var err error
		switch m.T {
		case "play":
			err = r.m.eng.Play(append([]Tile(nil), m.Tiles...))
		case "pass":
			err = r.m.eng.Pass()
		case "exchange":
			err = r.m.eng.Exchange(strings.ToUpper(m.Letters))
		}
		if err != nil {
			r.errTo(cl, err.Error())
			if m.T == "play" {
				r.eventLocked(map[string]any{"t": "event", "kind": "rejected", "seat": cl.seat, "msg": err.Error()})
			}
			return
		}
		r.afterMoveLocked(m.T, cl.seat)
	}
}

// afterMoveLocked advances the clock, finalizes the game if it ended, and notifies everyone.
func (r *Room) afterMoveLocked(kind string, seat int) {
	r.preview = nil
	if c := r.m.Clock; c != nil {
		c.charge(time.Now())
		if r.m.eng.Over() {
			c.Running = -1
			for s := 0; s < 2; s++ {
				if p := overtimePenalty(c.Remaining[s]); p > 0 {
					r.m.Adj[s] -= p
					r.m.Extra = append(r.m.Extra, MoveLog{Player: s, Type: "time", Score: -p})
				}
			}
		} else {
			c.Running = r.seatOnTurn()
		}
	}
	r.eventLocked(map[string]any{"t": "event", "kind": kind, "seat": seat})
	r.broadcastLocked()
	r.maybeBotLocked()
}

// timeLossLocked ends the game because `loser` exceeded 10 minutes of overtime (NASPA rule):
// the loser loses 100 points and the game; the opponent pays any overtime of their own;
// if the opponent is still behind, their score is raised to win by one. Unplayed tiles are ignored.
func (r *Room) timeLossLocked(loser int) {
	c := r.m.Clock
	c.charge(time.Now())
	c.Running = -1
	winner := 1 - loser
	r.m.Adj[loser] -= 100
	r.m.Extra = append(r.m.Extra, MoveLog{Player: loser, Type: "time", Score: -100})
	if p := overtimePenalty(c.Remaining[winner]); p > 0 {
		r.m.Adj[winner] -= p
		r.m.Extra = append(r.m.Extra, MoveLog{Player: winner, Type: "time", Score: -p})
	}
	if d := r.score(loser) - r.score(winner); d >= 0 {
		r.m.Adj[winner] += d + 1
		r.m.Extra = append(r.m.Extra, MoveLog{Player: winner, Type: "adjust", Score: d + 1})
	}
	r.m.Winner, r.m.EndReason = &winner, "time"
	r.preview = nil
	r.eventLocked(map[string]any{"t": "event", "kind": "timeout", "seat": loser})
	r.broadcastLocked()
}

// maybeBotLocked schedules a computer move if a bot is on turn.
func (r *Room) maybeBotLocked() {
	if !r.playingLocked() {
		return
	}
	seat := r.seatOnTurn()
	if s := r.seats[seat]; s == nil || !s.Bot {
		return
	}
	m, gameNo := r.m, r.gameNo
	go func() {
		time.Sleep(1800 * time.Millisecond) // feel less robotic
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.m != m || r.gameNo != gameNo || !r.playingLocked() || r.seatOnTurn() != seat {
			return
		}
		if m.Clock != nil && m.Clock.Paused {
			go func() { time.Sleep(2 * time.Second); r.mu.Lock(); r.maybeBotLocked(); r.mu.Unlock() }()
			return
		}
		if err := m.eng.BotMove(botLevel(r.seats[seat].Level).Code); err != nil {
			slog.Error("bot move", "err", err)
			m.eng.Pass()
		}
		r.afterMoveLocked("bot", seat)
	}()
}

func (r *Room) seatConnected(seat int) bool {
	if s := r.seats[seat]; s != nil && s.Bot {
		return true
	}
	for c := range r.clients {
		if c.role == "player" && c.seat == seat {
			return true
		}
	}
	return false
}

func (r *Room) ttlLocked() time.Duration {
	if r.playingLocked() {
		return gameIdleTTL
	}
	return roomIdleTTL
}

// Summary is a short status for game lists (TV "Games on this TV", phone "Your games").
type Summary struct {
	Code    string   `json:"code"`
	Phase   string   `json:"phase"`
	Names   []string `json:"names"`
	Bots    []bool   `json:"bots"`
	Scores  []int    `json:"scores"`
	Turn    int      `json:"turn"`
	Winner  *int     `json:"winner,omitempty"`
	Lexicon string   `json:"lexicon"`
	Moves   int      `json:"moves"`
	Updated int64    `json:"updated"` // unix ms
}

// summaryFor returns the room's summary if the caller holds the TV key, the join key or a seat token.
func (r *Room) summaryFor(tvKey, key, token string) (*Summary, int, bool) {
	seat := -1
	ok := false
	if tvKey != "" {
		_, ok = r.authorize("tv", tvKey, "")
	} else {
		seat, ok = r.authorize("player", key, token)
	}
	if !ok {
		return nil, -1, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	sm := &Summary{Code: r.Code, Phase: "lobby", Names: []string{"", ""}, Bots: []bool{false, false}, Scores: []int{0, 0},
		Turn: -1, Lexicon: r.settings.Lexicon, Updated: r.lastUsed.UnixMilli()}
	for i, st := range r.seats {
		if st != nil {
			sm.Names[i], sm.Bots[i] = st.Name, st.Bot
		}
	}
	if r.m != nil {
		sm.Phase = "playing"
		sm.Lexicon = r.m.eng.Lexicon
		sm.Scores = []int{r.score(0), r.score(1)}
		sm.Moves = len(r.m.eng.Log())
		if r.overLocked() {
			sm.Phase = "over"
			w := r.winnerLocked()
			sm.Winner = &w
		} else {
			sm.Turn = r.seatOnTurn()
		}
	}
	return sm, seat, true
}

func (r *Room) tvCount() int {
	n := 0
	for c := range r.clients {
		if c.role == "tv" {
			n++
		}
	}
	return n
}

var botLevelViews = func() []map[string]string {
	out := []map[string]string{}
	for _, b := range BotLevels {
		out = append(out, map[string]string{"id": b.ID, "name": b.Name, "desc": b.Desc})
	}
	return out
}()

// define runs outside the room lock (it may call out to the dictionary), then delivers the result.
func (r *Room) define(cl *Client, lexicon string, gameNo, idx int, mv MoveLog, by string) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	d, err := defs.Define(ctx, lexicon, mv.Words[0])
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.gameNo != gameNo || !r.clients[cl] {
		return
	}
	if err != nil {
		r.errTo(cl, err.Error())
		return
	}
	ev := map[string]any{"t": "event", "kind": "define", "move": idx, "player": mv.Player, "word": d.Word, "pos": mv.Pos,
		"score": mv.Score, "senses": d.Senses, "lexicon": lexicon, "by": by}
	tvVoice := false
	for c := range r.clients {
		if c.role == "tv" {
			sendJSON(c, ev)
			tvVoice = tvVoice || c.voice
		}
	}
	reply := map[string]any{"t": "define", "tvVoice": tvVoice}
	for k, v := range ev {
		if k != "t" {
			reply[k] = v
		}
	}
	sendJSON(cl, reply)
}

func (r *Room) eventLocked(ev map[string]any) {
	for c := range r.clients {
		sendJSON(c, ev)
	}
}

type seatView struct {
	Name      string `json:"name"`
	Taken     bool   `json:"taken"`
	Bot       bool   `json:"bot,omitempty"`
	Connected bool   `json:"connected"`
	Score     int    `json:"score"`
	RackCount int    `json:"rackCount"`
	Rack      string `json:"rack,omitempty"` // revealed at game end
}

type clockView struct {
	Remaining [2]int64 `json:"remaining"`
	Running   int      `json:"running"`
	Paused    bool     `json:"paused"`
	InitialMs int64    `json:"initialMs"`
}

func (r *Room) stateFor(cl *Client) map[string]any {
	phase := "lobby"
	if r.m != nil {
		phase = "playing"
		if r.overLocked() {
			phase = "over"
		}
	}
	seats := make([]seatView, 2)
	for i := 0; i < 2; i++ {
		if s := r.seats[i]; s != nil {
			seats[i].Name, seats[i].Taken, seats[i].Bot = s.Name, true, s.Bot
		}
		seats[i].Connected = r.seatConnected(i)
		if r.m != nil {
			ei := r.engIdx(i)
			seats[i].Score = r.score(i)
			seats[i].RackCount = len([]rune(r.m.eng.Rack(ei)))
			if phase == "over" {
				seats[i].Rack = r.m.eng.Rack(ei)
			}
		}
	}
	st := map[string]any{
		"t": "state", "code": r.Code, "phase": phase, "settings": r.settings,
		"lexicons": Lexicons, "timeOptions": TimeOptions, "themes": Themes, "bots": botLevelViews, "tvs": r.tvCount(),
		"seats": seats, "you": cl.seat, "role": cl.role, "gameNo": r.gameNo, "joinUrl": r.joinURL(),
	}
	if r.m != nil {
		eng := r.m.eng
		st["lexicon"] = eng.Lexicon
		st["board"] = eng.Board()
		st["bonuses"] = eng.Bonuses()
		st["bag"] = eng.BagCount()
		st["turn"] = r.seatOnTurn()
		log := eng.Log()
		for i := range log {
			log[i].Player = r.order[log[i].Player]
		}
		st["log"] = append(log, r.m.Extra...)
		if c := r.m.Clock; c != nil {
			now := time.Now()
			st["clock"] = clockView{Remaining: [2]int64{c.live(0, now), c.live(1, now)}, Running: c.Running, Paused: c.Paused, InitialMs: c.InitialMs}
		}
		if phase == "over" {
			st["winner"] = r.winnerLocked()
			st["endReason"] = r.m.EndReason
		}
		if cl.seat >= 0 {
			st["rack"] = eng.Rack(r.engIdx(cl.seat))
			st["unseen"] = eng.Unseen(r.engIdx(cl.seat))
		}
	}
	return st
}

func (r *Room) broadcastLocked() {
	for c := range r.clients {
		sendJSON(c, r.stateFor(c))
	}
	r.saveLocked()
}
