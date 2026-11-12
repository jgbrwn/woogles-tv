package main

import (
	"testing"
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
		eng.BotMove()
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
		eng.BotMove()
	}
	raw0 := eng.Score(r.engIdx(0))
	r.afterMoveLocked("bot", 0)
	if r.score(0) != raw0-20 || r.m.Adj[1] != 0 {
		t.Fatalf("expected -20 for 61s overtime, got adj %v", r.m.Adj)
	}
}
