// sim is a dev helper: it joins a room as a player, adds the computer opponent, starts a game
// and then only exchanges/passes, so the computer fills the board. Useful for eyeballing the TV.
//
//	go run ./tools/sim -url http://localhost:8420 -code ABCDEF -key JOINKEY [-time 30] [-delay 2s]
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
)

func main() {
	base := flag.String("url", "http://localhost:8420", "server")
	code := flag.String("code", "", "room code")
	key := flag.String("key", "", "join key")
	name := flag.String("name", "Sim", "player name")
	tmin := flag.Int("time", 0, "clock minutes")
	delay := flag.Duration("delay", 1500*time.Millisecond, "think time")
	maxTurns := flag.Int("turns", 1000, "stop after N own turns")
	flag.Parse()
	u, _ := url.Parse(*base)
	u.Scheme = strings.Replace(u.Scheme, "http", "ws", 1)
	u.Path = "/ws"
	u.RawQuery = url.Values{"room": {*code}, "role": {"player"}, "key": {*key}}.Encode()
	ctx := context.Background()
	c, _, err := websocket.Dial(ctx, u.String(), &websocket.DialOptions{HTTPHeader: map[string][]string{"Origin": {*base}}})
	if err != nil {
		log.Fatal(err)
	}
	send := func(v any) { b, _ := json.Marshal(v); c.Write(ctx, websocket.MessageText, b) }
	send(map[string]any{"t": "join", "seat": 0, "name": *name})
	started, lastLog, turns := false, -1, 0
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			log.Fatal(err)
		}
		var st struct {
			T, Phase, Rack string
			You, Turn, Bag int
			Seats          []struct{ Taken bool }
			Log            []any
		}
		json.Unmarshal(data, &st)
		if st.T != "state" || st.You != 0 {
			continue
		}
		if st.Phase == "lobby" && !started {
			if !st.Seats[1].Taken {
				send(map[string]any{"t": "settings", "timeMin": *tmin})
				send(map[string]any{"t": "addbot"})
				continue
			}
			started = true
			time.Sleep(time.Second)
			send(map[string]any{"t": "start"})
			continue
		}
		if st.Phase == "over" {
			log.Println("game over")
			return
		}
		if st.Phase == "playing" && st.Turn == 0 && len(st.Log) != lastLog {
			lastLog = len(st.Log)
			turns++
			if turns > *maxTurns {
				continue
			}
			time.Sleep(*delay)
			if st.Bag >= 7 {
				send(map[string]any{"t": "exchange", "letters": st.Rack})
			} else {
				send(map[string]any{"t": "pass"})
			}
		}
	}
}
