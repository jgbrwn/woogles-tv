package main

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	pb "github.com/domino14/macondo/gen/api/proto/macondo"
)

var startWorker sync.Once

// A game against the computer: only the person's moves are analysed; spectators can't start a review; the first
// player to open it drives; the game is kept after a rematch (and a restart) and can be looked back at privately
// while the next one is on; the TV remote can open it; an idle review closes itself.
func TestReview(t *testing.T) {
	r := newTestRoom(t)
	defer func() { roomsMu.Lock(); delete(rooms, r.Code); roomsMu.Unlock() }()
	startWorker.Do(func() { go reviewWorker() })
	r.seats = [2]*Seat{{Name: "Ann Lee", Token: "tok"}, {Name: "STEEBot", Bot: true, Level: "stee"}}
	eng, err := NewEngine("NWL23", [2]string{"Ann Lee", "STEEBot"})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ { // Ann, the bot, Ann
		if err := eng.BotMove(pb.BotRequest_HASTY_BOT); err != nil {
			t.Fatal(err)
		}
	}
	w := 1
	r.m, r.gameNo = &Match{eng: eng, Winner: &w, EndReason: "resign"}, 1
	ann := &Client{role: "player", seat: 0, send: make(chan []byte, 256)}
	spec := &Client{role: "player", seat: -1, send: make(chan []byte, 256)}
	tv := &Client{role: "tv", seat: -1, send: make(chan []byte, 256)}
	r.mu.Lock()
	r.clients[ann], r.clients[spec], r.clients[tv] = true, true, true
	r.mu.Unlock()

	r.handle(spec, inMsg{T: "review", Op: "open"})
	r.mu.Lock()
	if r.rv.open || r.m.Review != nil {
		t.Fatal("a spectator opened the review")
	}
	if r.reviewViewLocked(spec) != nil {
		t.Error("spectators' phones should get no review")
	}
	r.mu.Unlock()

	r.handle(ann, inMsg{T: "review", Op: "open"})
	r.mu.Lock()
	rv := r.m.Review
	if !r.rv.open || r.rv.driver != 0 || rv == nil || len(rv.Steps) != 2 || rv.Steps[0] != 0 || rv.Steps[1] != 2 {
		t.Fatalf("open: %+v steps %v", r.rv, rv)
	}
	if v := r.reviewViewLocked(tv); v == nil || v["open"] != true {
		t.Error("the TV should show the open review")
	}
	r.mu.Unlock()

	two := 1
	r.handle(spec, inMsg{T: "review", Op: "step", Pos: &two})
	r.handle(ann, inMsg{T: "review", Op: "step", Pos: &two})
	r.mu.Lock()
	if v := r.rv.view; r.rv.pos != 1 || v == nil || v.Ev != 2 || v.Seat != 0 || v.Prev == nil || v.Prev.Seat != 1 || len(v.PrevCells) == 0 {
		t.Fatalf("step: pos %d view %+v", r.rv.pos, r.rv.view)
	}
	r.mu.Unlock()

	deadline := time.Now().Add(90 * time.Second)
	for {
		r.mu.Lock()
		done := rv.complete()
		r.mu.Unlock()
		if done {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("analysis didn't finish")
		}
		time.Sleep(200 * time.Millisecond)
	}
	r.mu.Lock()
	for _, ev := range rv.Steps {
		tr := rv.Turns[ev]
		if tr.Err != "" || tr.Verdict == "" || tr.Best.Kind == "" || tr.Played.Kind == "" {
			t.Errorf("turn %d: %+v", ev, tr)
		}
		if tr.Best.Kind == "play" && (tr.Best.Word == "" || len(tr.Best.Cells) == 0 || tr.Best.Win == nil) {
			t.Errorf("turn %d best: %+v", ev, tr.Best)
		}
	}
	if b, err := json.Marshal(rv); err == nil {
		t.Logf("review: %s", b)
	}
	gcg, file, err := r.gcgLocked(0)
	r.mu.Unlock()
	if err != nil || !strings.Contains(gcg, "#player1 Ann_Lee Ann Lee") || !strings.HasSuffix(file, "Ann_Lee-vs-STEEBot.gcg") {
		t.Errorf("gcg %q %v:\n%s", file, err, gcg)
	}

	// Rematch: the finished game and its review are kept; while the new game is on, there's nothing to review in
	// the room, but Ann can look back at it on her phone alone.
	r.handle(ann, inMsg{T: "start"})
	r.mu.Lock()
	if len(r.games) != 1 || r.games[0].m.Review != rv || r.rv.open || r.reviewTargetLocked() != nil {
		t.Fatalf("after rematch: games %v open %v", r.games, r.rv.open)
	}
	sm, _, _ := r.summaryForLocked(0)
	if len(sm.Past) != 1 || sm.Past[0].Game != 1 || !sm.Past[0].Analysed || sm.Past[0].Winner != 1 || sm.Past[0].Names[1] != "STEEBot" {
		t.Errorf("summary past: %+v", sm.Past)
	}
	r.mu.Unlock()
	r.handle(ann, inMsg{T: "review", Op: "open", Game: 1})
	r.mu.Lock()
	if ann.rv == nil || !ann.rv.open || r.rv.open {
		t.Fatal("looking back during a game should be private")
	}
	if v := r.reviewViewLocked(tv); v != nil {
		t.Error("the TV shouldn't see a private look back")
	}
	if v := r.reviewViewLocked(ann); v == nil || v["game"] != 1 || v["shared"] != false {
		t.Errorf("ann's view: %v", v)
	}
	r.mu.Unlock()
	one := 1
	r.handle(ann, inMsg{T: "review", Op: "step", Pos: &one})
	r.handle(ann, inMsg{T: "review", Op: "close"})
	r.mu.Lock()
	if ann.rv != nil {
		t.Error("close should end the private look back")
	}
	if _, _, err := r.gcgLocked(1); err != nil {
		t.Error("game 1's file:", err)
	}
	r.mu.Unlock()

	r.handle(ann, inMsg{T: "end"})
	r.mu.Lock()
	if g := r.reviewTargetLocked(); g == nil || !g.past || g.m.Review != rv {
		t.Fatal("back in the lobby, the last game should be reviewable")
	}
	if r.ttlLocked() != gameIdleTTL {
		t.Error("an analysed game should be kept as long as an unfinished one")
	}
	r.mu.Unlock()

	// The TV remote can open it too (no phone drives), a phone takes over, and an idle review closes itself.
	reviewIdle, reviewGrace = 50*time.Millisecond, 50*time.Millisecond
	defer func() { reviewIdle, reviewGrace = 10*time.Minute, 5*time.Minute }()
	r.handle(tv, inMsg{T: "review", Op: "open"})
	r.mu.Lock()
	if !r.rv.open || r.rv.driver != -1 || !r.canDriveLocked(tv, &r.rv) {
		t.Fatalf("tv open: %+v", r.rv)
	}
	r.mu.Unlock()
	r.handle(ann, inMsg{T: "review", Op: "open"})
	r.mu.Lock()
	if r.rv.driver != 0 || r.canDriveLocked(tv, &r.rv) {
		t.Fatalf("take over: %+v", r.rv)
	}
	r.mu.Unlock()
	time.Sleep(75 * time.Millisecond)
	r.mu.Lock()
	if v := r.reviewViewLocked(tv); v == nil || v["closeIn"] == nil {
		t.Errorf("\"Still reviewing?\" should be showing: %v", v)
	}
	r.mu.Unlock()
	r.handle(tv, inMsg{T: "review", Op: "still"})
	r.mu.Lock()
	if !r.rv.open || !r.rv.warn.IsZero() {
		t.Error("still: the review should stay open")
	}
	r.mu.Unlock()
	time.Sleep(200 * time.Millisecond)
	r.mu.Lock()
	if r.rv.open {
		t.Error("an idle review should close")
	}
	// ...and survives a restart
	roomsDir = t.TempDir()
	r.saveLocked()
	r.mu.Unlock()
	if err := loadRooms(roomsDir); err != nil {
		t.Fatal(err)
	}
	roomsDir = ""
	r2 := getRoom(r.Code)
	if r2 == nil || len(r2.games) != 1 || r2.games[0].m.Review == nil || len(r2.games[0].m.Review.Turns) != 2 || r2.games[0].seats[0].Token != "" || r2.games[0].ended.IsZero() {
		t.Fatalf("restored: %+v", r2.games)
	}
}

// A room keeps its last few finished games.
func TestKeepGames(t *testing.T) {
	r := newTestRoom(t)
	defer func() { roomsMu.Lock(); delete(rooms, r.Code); roomsMu.Unlock() }()
	r.seats = [2]*Seat{{Name: "Ann", Token: "tok"}, {Name: "Bo", Token: "tok2"}}
	ann := &Client{role: "player", seat: 0, send: make(chan []byte, 256)}
	for i := 0; i < keepGames+2; i++ {
		r.handle(ann, inMsg{T: "start"})
		r.handle(ann, inMsg{T: "resign"})
	}
	r.handle(ann, inMsg{T: "start"})
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.games) != keepGames || r.games[0].gameNo != 3 || r.games[keepGames-1].gameNo != keepGames+2 {
		t.Fatalf("kept %d, first %d", len(r.games), r.games[0].gameNo)
	}
	if r.gameLocked(2) != nil || r.gameLocked(3) == nil {
		t.Error("game lookup")
	}
	sm, _, _ := r.summaryForLocked(0)
	if len(sm.Past) != keepGames || sm.Past[0].Winner != 1 {
		t.Errorf("past: %+v", sm.Past)
	}
}

func TestDescribedMove(t *testing.T) {
	board := make([]string, 15)
	for i := range board {
		board[i] = strings.Repeat(".", 15)
	}
	board[6] = "..E............" // C7 holds E
	m := describedMove(" C6 G.NTLER", 26, board)
	if m.Pos != "C6" || m.Word != "GENTLER" || len(m.Cells) != 6 || m.Cells[0] != (Cell{5, 2, "G"}) || m.Cells[1] != (Cell{7, 2, "N"}) {
		t.Errorf("down: %+v", m)
	}
	m = describedMove("8K .EIkI", 20, nil)
	if m.Pos != "8K" || len(m.Cells) != 4 || m.Cells[0] != (Cell{7, 11, "E"}) || m.Cells[2].L != "k" {
		t.Errorf("across: %+v", m)
	}
	if m := describedMove("(exch ABC)", 0, nil); m.Kind != "exchange" || m.Tiles != "ABC" {
		t.Errorf("exchange: %+v", m)
	}
	if m := describedMove("(Pass)", 0, nil); m.Kind != "pass" {
		t.Errorf("pass: %+v", m)
	}
}
