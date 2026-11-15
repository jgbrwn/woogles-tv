package main

import "testing"

// Clients draw each bot's face from its level; rooms saved before levels were stored go by the bot's name.
func TestBotLevelFor(t *testing.T) {
	for _, c := range []struct {
		seat Seat
		want string
	}{
		{Seat{Name: "STEEBot", Bot: true, Level: "stee"}, "stee"},
		{Seat{Name: "HastyBot", Bot: true}, "hasty"},
		{Seat{Name: "Robo", Bot: true}, ""},
	} {
		if got := botLevelFor(&c.seat); got != c.want {
			t.Errorf("botLevelFor(%+v) = %q, want %q", c.seat, got, c.want)
		}
	}
}
