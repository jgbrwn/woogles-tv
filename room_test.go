package main

import (
	"strings"
	"testing"

	pb "github.com/domino14/macondo/gen/api/proto/macondo"
	"time"
)

func TestOvertimePenalty(t *testing.T) {
	cases := map[int64]int{0: 0, 5000: 0, -1: 10, -60000: 10, -60001: 20, -599000: 100, -600000: 100}
	for ms, want := range cases {
		if got := overtimePenalty(ms); got != want {
			t.Errorf("overtimePenalty(%d)=%d want %d", ms, got, want)
		}
	}
}

func newTestRoom(t *testing.T) *Room {
	t.Helper()
	if err := initEngine("./data"); err != nil {
		t.Fatal(err)
	}
	roomsDir = ""
	r, err := createRoom("http://x")
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestAuthorize(t *testing.T) {
	r := newTestRoom(t)
	if _, ok := r.authorize("player", "", ""); ok {
		t.Fatal("no key should be rejected")
	}
	if _, ok := r.authorize("player", r.TVKey, ""); ok {
		t.Fatal("tv key must not work as join key")
	}
	if _, ok := r.authorize("tv", r.JoinKey, ""); ok {
		t.Fatal("join key must not open the TV role")
	}
	if _, ok := r.authorize("tv", r.TVKey, ""); !ok {
		t.Fatal("tv key rejected")
	}
	r.seats[1] = &Seat{Name: "B", Token: "tok"}
	if seat, ok := r.authorize("player", "", "tok"); !ok || seat != 1 {
		t.Fatal("seat token should reconnect to seat 1")
	}
}

// NASPA: >10 min overtime loses, -100, and the opponent is bumped to win by 1.
func TestTimeLoss(t *testing.T) {
	r := newTestRoom(t)
	r.seats = [2]*Seat{{Name: "A"}, {Name: "B"}}
	eng, _ := NewEngine("NWL23", [2]string{"A", "B"})
	for i := 0; i < 4; i++ {
		eng.BotMove(pb.BotRequest_HASTY_BOT)
	}
	r.m = &Match{eng: eng, Clock: &Clock{InitialMs: 60000, Remaining: [2]int64{-610000, 30000}, Running: 0, since: time.Now()}}
	before0, before1 := r.score(0), r.score(1)
	r.timeLossLocked(0)
	if !r.overLocked() || r.winnerLocked() != 1 || r.m.EndReason != "time" {
		t.Fatal("seat 1 should win on time")
	}
	if r.score(0) != before0-100 {
		t.Fatalf("loser score %d, want %d", r.score(0), before0-100)
	}
	if r.score(1) <= r.score(0) || (before1 <= before0-100 && r.score(1) != r.score(0)+1) {
		t.Fatalf("winner score %d vs loser %d (before %d)", r.score(1), r.score(0), before1)
	}
}

func TestNormalEndPenalties(t *testing.T) {
	r := newTestRoom(t)
	r.seats = [2]*Seat{{Name: "A"}, {Name: "B"}}
	eng, _ := NewEngine("NWL23", [2]string{"A", "B"})
	r.m = &Match{eng: eng, Clock: &Clock{InitialMs: 60000, Remaining: [2]int64{-61000, 5000}, Running: 0, since: time.Now()}}
	for i := 0; i < 100 && !eng.Over(); i++ {
		eng.BotMove(pb.BotRequest_HASTY_BOT)
	}
	raw0 := eng.Score(r.engIdx(0))
	r.afterMoveLocked("bot", 0)
	if r.score(0) != raw0-20 || r.m.Adj[1] != 0 {
		t.Fatalf("expected -20 for 61s overtime, got adj %v", r.m.Adj)
	}
}

func TestLinkTV(t *testing.T) {
	tvRoom := newTestRoom(t)
	phoneRoom := newTestRoom(t)
	tv := &Client{role: "tv", seat: -1, send: make(chan []byte, 4)}
	tvRoom.clients[tv] = true
	if err := linkTV(phoneRoom.Code, phoneRoom, "Pat"); err == nil {
		t.Fatal("linking to its own room should fail")
	}
	if err := linkTV("ZZZZZZ", phoneRoom, "Pat"); err == nil {
		t.Fatal("unknown TV code should fail")
	}
	if err := linkTV(tvRoom.Code, phoneRoom, "Pat"); err != nil {
		t.Fatal(err)
	}
	msg := string(<-tv.send)
	if !strings.Contains(msg, phoneRoom.TVKey) || !strings.Contains(msg, `"ask":false`) {
		t.Fatalf("unexpected switch message %s", msg)
	}
	eng, _ := NewEngine("NWL23", [2]string{"A", "B"})
	tvRoom.m = &Match{eng: eng}
	linkTV(tvRoom.Code, phoneRoom, "Pat")
	if msg := string(<-tv.send); !strings.Contains(msg, `"ask":true`) {
		t.Fatalf("TV mid-game should be asked first: %s", msg)
	}
}

func TestSummaryNeedsCredential(t *testing.T) {
	r := newTestRoom(t)
	if _, _, ok := r.summaryFor("", "wrong", ""); ok {
		t.Fatal("summary without a valid key")
	}
	if _, _, ok := r.summaryFor("nope", "", ""); ok {
		t.Fatal("summary with a bad TV key")
	}
	sm, seat, ok := r.summaryFor(r.TVKey, "", "")
	if !ok || seat != -1 || sm.Phase != "lobby" {
		t.Fatalf("tv summary: %+v %d %v", sm, seat, ok)
	}
	if _, _, ok := r.summaryFor("", r.JoinKey, ""); !ok {
		t.Fatal("join key should allow a summary")
	}
}
