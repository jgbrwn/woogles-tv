package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"math/big"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type Client struct {
	role string // "tv" | "player"
	seat int    // -1 if not seated
	send chan []byte
}

type Seat struct {
	Name  string
	Token string
	Bot   bool
}

type PreviewState struct {
	Seat  int    `json:"seat"`
	Tiles []Tile `json:"tiles"`
	Score *int   `json:"score"`
	Err   string `json:"err,omitempty"`
}

type Room struct {
	Code    string
	mu      sync.Mutex
	seats   [2]*Seat
	clients map[*Client]bool
	eng     *Engine
	// order[engineIdx] = seat. Swapped on rematch so the other seat starts.
	order    [2]int
	lexicon  string
	preview  *PreviewState
	gameNo   int
	lastUsed time.Time
	joinURL  string
}

var (
	roomsMu sync.Mutex
	rooms   = map[string]*Room{}
)

const codeAlphabet = "BCDFGHJKLMNPQRSTVWXZ" // no vowels -> no accidental words

func newCode() string {
	var sb strings.Builder
	for i := 0; i < 4; i++ {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(codeAlphabet))))
		sb.WriteByte(codeAlphabet[n.Int64()])
	}
	return sb.String()
}

func newToken() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func createRoom() *Room {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	code := newCode()
	for rooms[code] != nil {
		code = newCode()
	}
	r := &Room{Code: code, clients: map[*Client]bool{}, order: [2]int{0, 1}, lexicon: Lexicons[0], lastUsed: time.Now()}
	rooms[code] = r
	return r
}

func getRoom(code string) *Room {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	return rooms[strings.ToUpper(code)]
}

func reapRooms() {
	for range time.Tick(10 * time.Minute) {
		roomsMu.Lock()
		for k, r := range rooms {
			r.mu.Lock()
			idle := len(r.clients) == 0 && time.Since(r.lastUsed) > 24*time.Hour
			r.mu.Unlock()
			if idle {
				delete(rooms, k)
			}
		}
		roomsMu.Unlock()
	}
}

// ---- websocket handling ----

type inMsg struct {
	T       string `json:"t"`
	Name    string `json:"name"`
	Seat    int    `json:"seat"`
	Tiles   []Tile `json:"tiles"`
	Letters string `json:"letters"`
	Lexicon string `json:"lexicon"`
}

func (r *Room) serve(ctx context.Context, c *websocket.Conn, role, token string) {
	cl := &Client{role: role, seat: -1, send: make(chan []byte, 32)}
	r.mu.Lock()
	if role == "player" && token != "" {
		for i, s := range r.seats {
			if s != nil && s.Token == token {
				cl.seat = i
			}
		}
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
				c.Ping(pctx)
				pc()
			}
		}
	}()
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			break
		}
		var m inMsg
		if json.Unmarshal(data, &m) != nil {
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

func (r *Room) seatOnTurn() int {
	if r.eng == nil {
		return -1
	}
	return r.order[r.eng.OnTurn()]
}

func (r *Room) handle(cl *Client, m inMsg) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lastUsed = time.Now()
	defer func() {
		if p := recover(); p != nil {
			slog.Error("panic in handler", "err", p, "msg", m.T)
			r.errTo(cl, "Something went wrong")
		}
	}()
	switch m.T {
	case "join":
		if cl.role != "player" || m.Seat < 0 || m.Seat > 1 {
			return
		}
		name := strings.TrimSpace(m.Name)
		if name == "" {
			name = []string{"Player 1", "Player 2"}[m.Seat]
		}
		if len([]rune(name)) > 16 {
			name = string([]rune(name)[:16])
		}
		s := r.seats[m.Seat]
		if s != nil && r.seatConnected(m.Seat) {
			r.errTo(cl, "That seat is taken")
			return
		}
		if s == nil {
			s = &Seat{}
			r.seats[m.Seat] = s
		}
		// Taking over a disconnected seat gets a fresh token (old phone is locked out).
		s.Name, s.Token = name, newToken()
		cl.seat = m.Seat
		sendJSON(cl, map[string]any{"t": "joined", "seat": m.Seat, "token": s.Token})
		r.broadcastLocked()
	case "addbot":
		if cl.seat < 0 || r.eng != nil && !r.eng.Over() {
			return
		}
		other := 1 - cl.seat
		if r.seats[other] != nil && !r.seats[other].Bot && r.seatConnected(other) {
			r.errTo(cl, "Seat is taken by a player")
			return
		}
		r.seats[other] = &Seat{Name: "Macondo 🤖", Bot: true}
		r.broadcastLocked()
	case "removebot":
		for i, s := range r.seats {
			if s != nil && s.Bot && (r.eng == nil || r.eng.Over()) {
				r.seats[i] = nil
			}
		}
		r.broadcastLocked()
	case "leave":
		if cl.seat >= 0 && r.eng == nil {
			r.seats[cl.seat] = nil
		}
		cl.seat = -1
		r.broadcastLocked()
	case "lexicon":
		for _, l := range Lexicons {
			if l == m.Lexicon {
				r.lexicon = l
			}
		}
		r.broadcastLocked()
	case "start":
		if cl.seat < 0 || r.seats[0] == nil || r.seats[1] == nil {
			r.errTo(cl, "Need two players to start")
			return
		}
		if r.eng != nil && !r.eng.Over() {
			return
		}
		if r.eng != nil { // rematch: other seat starts
			r.order = [2]int{r.order[1], r.order[0]}
		}
		eng, err := NewEngine(r.lexicon, [2]string{r.seats[r.order[0]].Name, r.seats[r.order[1]].Name})
		if err != nil {
			r.errTo(cl, err.Error())
			return
		}
		r.eng = eng
		r.gameNo++
		r.preview = nil
		r.eventLocked(map[string]any{"t": "event", "kind": "start"})
		r.broadcastLocked()
		r.maybeBotLocked()
	case "end": // abandon current game, back to lobby
		if cl.seat < 0 {
			return
		}
		r.eng = nil
		r.preview = nil
		r.broadcastLocked()
	case "preview":
		if r.eng == nil || cl.seat != r.seatOnTurn() || r.eng.Over() {
			return
		}
		p := &PreviewState{Seat: cl.seat, Tiles: m.Tiles}
		if len(m.Tiles) > 0 {
			tiles := append([]Tile(nil), m.Tiles...)
			if sc, err := r.eng.Preview(tiles); err == nil {
				p.Score = &sc
			} else {
				p.Err = err.Error()
			}
		}
		r.preview = p
		for c := range r.clients {
			if c.role == "tv" || c.seat == cl.seat {
				sendJSON(c, map[string]any{"t": "preview", "preview": p})
			}
		}
	case "play", "pass", "exchange":
		if r.eng == nil || r.eng.Over() {
			return
		}
		if cl.seat != r.seatOnTurn() {
			r.errTo(cl, "It's not your turn")
			return
		}
		var err error
		switch m.T {
		case "play":
			err = r.eng.Play(append([]Tile(nil), m.Tiles...))
		case "pass":
			err = r.eng.Pass()
		case "exchange":
			err = r.eng.Exchange(strings.ToUpper(m.Letters))
		}
		if err != nil {
			r.errTo(cl, err.Error())
			if m.T == "play" {
				r.eventLocked(map[string]any{"t": "event", "kind": "rejected", "seat": cl.seat, "msg": err.Error()})
			}
			return
		}
		r.preview = nil
		r.eventLocked(map[string]any{"t": "event", "kind": m.T, "seat": cl.seat})
		r.broadcastLocked()
		r.maybeBotLocked()
	}
}

// maybeBotLocked schedules a computer move if a bot is on turn.
func (r *Room) maybeBotLocked() {
	if r.eng == nil || r.eng.Over() {
		return
	}
	seat := r.seatOnTurn()
	if s := r.seats[seat]; s == nil || !s.Bot {
		return
	}
	eng, gameNo := r.eng, r.gameNo
	go func() {
		time.Sleep(1800 * time.Millisecond) // feel less robotic
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.eng != eng || r.gameNo != gameNo || eng.Over() || r.seatOnTurn() != seat {
			return
		}
		if err := eng.BotMove(); err != nil {
			slog.Error("bot move", "err", err)
			eng.Pass()
		}
		r.preview = nil
		r.eventLocked(map[string]any{"t": "event", "kind": "bot", "seat": seat})
		r.broadcastLocked()
		r.maybeBotLocked()
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

func (r *Room) stateFor(cl *Client) map[string]any {
	phase := "lobby"
	if r.eng != nil {
		phase = "playing"
		if r.eng.Over() {
			phase = "over"
		}
	}
	seats := make([]seatView, 2)
	for i := 0; i < 2; i++ {
		if s := r.seats[i]; s != nil {
			seats[i].Name, seats[i].Taken, seats[i].Bot = s.Name, true, s.Bot
		}
		seats[i].Connected = r.seatConnected(i)
		if r.eng != nil {
			ei := r.engIdx(i)
			seats[i].Score = r.eng.Score(ei)
			seats[i].RackCount = len([]rune(r.eng.Rack(ei)))
			if phase == "over" {
				seats[i].Rack = r.eng.Rack(ei)
			}
		}
	}
	st := map[string]any{
		"t": "state", "code": r.Code, "phase": phase, "lexicon": r.lexicon, "lexicons": Lexicons,
		"seats": seats, "you": cl.seat, "role": cl.role, "gameNo": r.gameNo, "joinUrl": r.joinURL,
	}
	if r.eng != nil {
		st["board"] = r.eng.Board()
		st["bonuses"] = r.eng.Bonuses()
		st["bag"] = r.eng.BagCount()
		st["turn"] = r.seatOnTurn()
		log := r.eng.Log()
		for i := range log {
			log[i].Player = r.order[log[i].Player]
		}
		st["log"] = log
		if phase == "over" {
			w := r.eng.Winner()
			if w >= 0 {
				w = r.order[w]
			}
			st["winner"] = w
		}
		if cl.seat >= 0 {
			st["rack"] = r.eng.Rack(r.engIdx(cl.seat))
			st["unseen"] = r.eng.Unseen(r.engIdx(cl.seat))
		}
		if cl.role == "tv" && r.preview != nil {
			st["preview"] = r.preview
		}
	}
	return st
}

func (r *Room) broadcastLocked() {
	for c := range r.clients {
		sendJSON(c, r.stateFor(c))
	}
}
