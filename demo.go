package main

import (
	"fmt"
	"time"
)

// seedDemo creates a room with a game in progress (human "Alex" vs STEEBot, both sides played by
// the bot for `moves` turns) and prints links for a TV and for Alex's phone. Used for screenshots
// and for trying the UI without two people: `woogles-tv -demo 12`.
func seedDemo(base string, moves int) error {
	r, err := createRoom(base)
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	lv := botLevel("stee")
	r.seats[0] = &Seat{Name: "Alex", Token: newSecret()}
	r.seats[1] = &Seat{Name: lv.Name, Bot: true, Level: lv.ID}
	r.settings.TimeMin = 60
	eng, err := NewEngine(r.settings.Lexicon, [2]string{"Alex", lv.Name})
	if err != nil {
		return err
	}
	r.m = &Match{eng: eng}
	for i := 0; i < moves && !eng.Over(); i++ {
		if err := eng.BotMove(lv.Code); err != nil {
			return err
		}
	}
	if !eng.Over() && r.seatOnTurn() != 0 { // leave it on Alex's turn
		if err := eng.BotMove(lv.Code); err != nil {
			return err
		}
	}
	ms := int64(r.settings.TimeMin) * 60000
	r.m.Clock = &Clock{InitialMs: ms, Remaining: [2]int64{ms - 23*60000 - 41000, ms - 19*60000 - 7000}, Running: r.seatOnTurn(), since: time.Now()}
	r.gameNo = 1
	r.saveLocked()
	fmt.Printf("demo room %s\n  TV:    %s/tv#room=%s&tv=%s\n  phone: %s/p/%s#k=%s&t=%s\n",
		r.Code, base, r.Code, r.TVKey, base, r.Code, r.JoinKey, r.seats[0].Token)
	return nil
}
