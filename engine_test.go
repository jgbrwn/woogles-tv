package main

import "testing"

func TestEnginePlays(t *testing.T) {
	if err := initEngine("./data"); err != nil { t.Fatal(err) }
	e, err := NewEngine("NWL23", [2]string{"A", "B"})
	if err != nil { t.Fatal(err) }
	e.tp.SetPlayerRack(0, "QUIZERS")
	if err := e.Play([]Tile{{7, 6, "Z", false}, {7, 4, "Q", false}, {7, 5, "U", false}, {7, 7, "I", false}}); err == nil {
		t.Fatal("QUZI should be invalid")
	}
	if err := e.Play([]Tile{{7, 4, "Q", false}, {7, 5, "U", false}, {7, 6, "I", false}, {7, 7, "Z", false}}); err != nil { t.Fatal(err) }
	if e.Score(0) != 44 { t.Fatal(e.Score(0)) }
	// player 1: play through the Z vertically: Z at (7,7). Make "ZA" downward with blank A.
	e.tp.SetPlayerRack(1, "?BCDEFG")
	if err := e.Play([]Tile{{8, 7, "A", true}}); err != nil { t.Fatal(err) }
	t.Log(e.Score(1), e.Board()[7], e.Board()[8])
	// gap check
	e.tp.SetPlayerRack(0, "AEIOTRS")
	if err := e.Play([]Tile{{9, 1, "A", false}, {9, 3, "T", false}}); err == nil { t.Fatal("gap should fail") }
	// playthrough horizontal: ZAS? play S at (8,8) forming "AS" horizontally with blank a at (8,7)
	if err := e.Play([]Tile{{8, 8, "S", false}}); err != nil { t.Fatal(err) }
	t.Log(e.Log())
}

func TestBotGame(t *testing.T) {
	if err := initEngine("./data"); err != nil { t.Fatal(err) }
	e, _ := NewEngine("NWL23", [2]string{"A", "B"})
	for i := 0; i < 60 && !e.Over(); i++ {
		if err := e.BotMove(); err != nil { t.Fatal(err) }
	}
	t.Log(e.Over(), e.Score(0), e.Score(1), len(e.Log()))
	if !e.Over() { t.Fatal("not over") }
}
