package main

import "testing"

func TestEnginePlays(t *testing.T) {
	if err := initEngine("./data"); err != nil {
		t.Fatal(err)
	}
	e, err := NewEngine("NWL23", [2]string{"A", "B"})
	if err != nil {
		t.Fatal(err)
	}
	e.tp.SetPlayerRack(0, "QUIZERS")
	if err := e.Play([]Tile{{7, 6, "Z", false}, {7, 4, "Q", false}, {7, 5, "U", false}, {7, 7, "I", false}}); err == nil {
		t.Fatal("QUZI should be invalid")
	}
	if err := e.Play([]Tile{{7, 4, "Q", false}, {7, 5, "U", false}, {7, 6, "I", false}, {7, 7, "Z", false}}); err != nil {
		t.Fatal(err)
	}
	if e.Score(0) != 44 {
		t.Fatal(e.Score(0))
	}
	// player 1: play through the Z vertically: Z at (7,7). Make "ZA" downward with blank A.
	e.tp.SetPlayerRack(1, "?BCDEFG")
	if err := e.Play([]Tile{{8, 7, "A", true}}); err != nil {
		t.Fatal(err)
	}
	t.Log(e.Score(1), e.Board()[7], e.Board()[8])
	// gap check
	e.tp.SetPlayerRack(0, "AEIOTRS")
	if err := e.Play([]Tile{{9, 1, "A", false}, {9, 3, "T", false}}); err == nil {
		t.Fatal("gap should fail")
	}
	// playthrough horizontal: ZAS? play S at (8,8) forming "AS" horizontally with blank a at (8,7)
	if err := e.Play([]Tile{{8, 8, "S", false}}); err != nil {
		t.Fatal(err)
	}
	t.Log(e.Log())
}

func TestBotGame(t *testing.T) {
	if err := initEngine("./data"); err != nil {
		t.Fatal(err)
	}
	e, _ := NewEngine("NWL23", [2]string{"A", "B"})
	for i := 0; i < 60 && !e.Over(); i++ {
		if err := e.BotMove(); err != nil {
			t.Fatal(err)
		}
	}
	t.Log(e.Over(), e.Score(0), e.Score(1), len(e.Log()))
	if !e.Over() {
		t.Fatal("not over")
	}
}

func TestRestore(t *testing.T) {
	if err := initEngine("./data"); err != nil {
		t.Fatal(err)
	}
	e, _ := NewEngine("NWL23", [2]string{"A", "B"})
	for i := 0; i < 6; i++ {
		if err := e.BotMove(); err != nil {
			t.Fatal(err)
		}
	}
	h, err := e.HistoryJSON()
	if err != nil {
		t.Fatal(err)
	}
	r, err := RestoreEngine("NWL23", h)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if r.Rack(i) != e.Rack(i) || r.Score(i) != e.Score(i) {
			t.Fatalf("seat %d: %s/%d vs %s/%d", i, r.Rack(i), r.Score(i), e.Rack(i), e.Score(i))
		}
	}
	if r.BagCount() != e.BagCount() || r.OnTurn() != e.OnTurn() {
		t.Fatal("bag/turn mismatch")
	}
	for i, row := range e.Board() {
		if r.Board()[i] != row {
			t.Fatal("board mismatch")
		}
	}
	for i := 0; i < 80 && !r.Over(); i++ {
		if err := r.BotMove(); err != nil {
			t.Fatal(err)
		}
	}
	if !r.Over() {
		t.Fatal("restored game didn't finish")
	}
	h2, _ := r.HistoryJSON()
	r2, err := RestoreEngine("NWL23", h2)
	if err != nil {
		t.Fatal(err)
	}
	if !r2.Over() || r2.Score(0) != r.Score(0) || r2.Score(1) != r.Score(1) {
		t.Fatal("over-state restore mismatch")
	}
}
