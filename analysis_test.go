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

// A game against the computer: only the person's moves are analysed; spectators and the TV can't start a review;
// the first player to open it drives; the review survives a rematch and a restart.
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
	r.m = &Match{eng: eng, Winner: &w, EndReason: "resign"}
	ann := &Client{role: "player", seat: 0, send: make(chan []byte, 256)}
	spec := &Client{role: "player", seat: -1, send: make(chan []byte, 256)}
	tv := &Client{role: "tv", seat: -1, send: make(chan []byte, 256)}
	r.mu.Lock()
	r.clients[ann], r.clients[spec], r.clients[tv] = true, true, true
	r.mu.Unlock()

	r.handle(spec, inMsg{T: "review", Op: "open"})
	r.handle(tv, inMsg{T: "review", Op: "open"})
	r.mu.Lock()
	if r.rv.open || r.m.Review != nil {
		t.Fatal("a spectator or the TV opened the review")
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
	gcg, file, err := r.gcgLocked()
	r.mu.Unlock()
	if err != nil || !strings.Contains(gcg, "#player1 Ann_Lee Ann Lee") || !strings.HasSuffix(file, "Ann_Lee-vs-STEEBot.gcg") {
		t.Errorf("gcg %q %v:\n%s", file, err, gcg)
	}

	// Rematch: the finished game and its review are kept; while the new game is on, there's nothing to review.
	r.handle(ann, inMsg{T: "start"})
	r.mu.Lock()
	if r.past == nil || r.past.m.Review != rv || r.rv.open || r.reviewTargetLocked() != nil {
		t.Fatalf("after rematch: past %v open %v", r.past, r.rv.open)
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
	// ...and survives a restart
	roomsDir = t.TempDir()
	r.saveLocked()
	r.mu.Unlock()
	if err := loadRooms(roomsDir); err != nil {
		t.Fatal(err)
	}
	roomsDir = ""
	r2 := getRoom(r.Code)
	if r2 == nil || r2.past == nil || r2.past.m.Review == nil || len(r2.past.m.Review.Turns) != 2 || r2.past.seats[0].Token != "" {
		t.Fatalf("restored: %+v", r2.past)
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
