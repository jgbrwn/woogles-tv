package main

// analysis.go: post-game analysis ("Game review") with Macondo's game analyzer, and GCG export.
//
// A seated player opens the review of a finished game. The people's moves are analysed one at a time by a single
// background worker (one game at a time, server-wide, on one core by default), and each result is pushed to the
// room as soon as it is ready, so the walkthrough can start straight away. Results are saved with the game.
// A bot's moves are not analysed: they are shown as context ("STEEBot replied ZONE for 45") in a game against
// the computer, and a game against the computer only steps through the person's moves.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/domino14/macondo/game"
	"github.com/domino14/macondo/gameanalysis"
	"github.com/domino14/macondo/gcgio"
	pb "github.com/domino14/macondo/gen/api/proto/macondo"
	"github.com/domino14/macondo/move"
	"github.com/domino14/macondo/turnplayer"
	"google.golang.org/protobuf/proto"
)

// WT_ANALYSIS: quick (default), deep (Macondo's own settings, about 10x slower) or off.
// WT_ANALYSIS_THREADS: cores one analysis may use (default 1, so live games always have the rest).
var (
	analysisMode    = "quick"
	analysisThreads = 1
)

const (
	reviewQueueMax = 6               // games waiting for the analyser, server-wide
	reviewTurnMax  = 4 * time.Minute // one move's analysis
	reviewAlts     = 4               // "other good plays" shown per move
)

func initAnalysis() {
	switch m := strings.ToLower(strings.TrimSpace(os.Getenv("WT_ANALYSIS"))); m {
	case "", "quick":
	case "deep", "off":
		analysisMode = m
	default:
		slog.Warn("WT_ANALYSIS: expected quick, deep or off", "value", m)
	}
	if n, err := strconv.Atoi(os.Getenv("WT_ANALYSIS_THREADS")); err == nil && n > 0 && n <= 64 {
		analysisThreads = n
	}
	// WT_REVIEW_IDLE: how long a review can sit unmoved before "Still reviewing?" (it closes 5 minutes later, or after
	// half the idle time if that's shorter)
	if d, err := time.ParseDuration(os.Getenv("WT_REVIEW_IDLE")); err == nil && d > 0 {
		reviewIdle, reviewGrace = d, min(reviewGrace, d/2)
	}
	if analysisMode != "off" {
		go reviewWorker()
	}
}

func analysisOn() bool { return analysisMode != "off" }

func analysisConfig() *gameanalysis.AnalysisConfig {
	cfg := gameanalysis.DefaultAnalysisConfig()
	cfg.Threads = analysisThreads
	if analysisMode == "quick" { // measured on 2 cores: 1-4 s a move instead of 15-40 s
		cfg.SimPlaysEarlyMid, cfg.SimPliesEarlyMid, cfg.SimStopEarlyMid = 15, 2, 95
		cfg.SimPlaysEarlyPreEndgame, cfg.SimPliesEarlyPreEndgame, cfg.SimStopEarlyPreEndgame = 15, 4, 95
	}
	return cfg
}

// ---- results, saved with the game ----

// Review is a finished game's analysis: one TurnReview per analysed move, keyed by the move's index in the log.
type Review struct {
	Depth string              `json:"depth"`
	Steps []int               `json:"steps"` // the moves walked through (people's plays, passes and exchanges)
	Turns map[int]*TurnReview `json:"turns"`
}

func (rv *Review) complete() bool { return len(rv.Turns) >= len(rv.Steps) }

type TurnReview struct {
	Phase        string       `json:"phase"`   // sim, peg (one tile in the bag) or endgame (exact)
	Verdict      string       `json:"verdict"` // best, small, medium, large
	MissedBingo  bool         `json:"missedBingo,omitempty"`
	BlownEndgame bool         `json:"blownEndgame,omitempty"`
	Played       ReviewMove   `json:"played"`
	Best         ReviewMove   `json:"best"`
	Alts         []ReviewMove `json:"alts,omitempty"` // other good plays, best first
	Err          string       `json:"err,omitempty"`
}

// ReviewMove is a move as the review shows it. Win is the chance of winning after it (sim and pre-endgame);
// Spread is the final margin with best play after it (endgame).
type ReviewMove struct {
	Kind   string   `json:"kind"` // play, exchange, pass
	Word   string   `json:"word,omitempty"`
	Pos    string   `json:"pos,omitempty"`
	Tiles  string   `json:"tiles,omitempty"` // exchanged tiles
	Leave  string   `json:"leave,omitempty"`
	Score  int      `json:"score"`
	Bingo  bool     `json:"bingo,omitempty"`
	Win    *float64 `json:"win,omitempty"`
	Spread *int     `json:"spread,omitempty"`
	Cells  []Cell   `json:"cells,omitempty"` // the tiles it places
}

type Cell struct {
	R int    `json:"r"`
	C int    `json:"c"`
	L string `json:"l"` // lower case: a blank
}

// ---- which game is reviewed ----

const keepGames = 5 // finished games a room keeps (for their review and game file) once the next one starts

// pastGame is a finished game, kept when a rematch starts (or the players go back to the lobby) so its review and
// game file stay available, and it stays listed under the players' finished games.
type pastGame struct {
	m      *Match
	order  [2]int
	seats  [2]*Seat // names and bots as they were; no tokens
	gameNo int
	ended  time.Time
}

type savedPast struct {
	Match   *Match          `json:"match"`
	Lexicon string          `json:"lexicon"`
	History json.RawMessage `json:"history"`
	Order   [2]int          `json:"order"`
	Seats   [2]*Seat        `json:"seats"`
	GameNo  int             `json:"gameNo"`
	Ended   time.Time       `json:"ended"`
}

// reviewGame is a finished game a review is about: the current one once it's over, or a kept one.
type reviewGame struct {
	m      *Match
	order  [2]int
	seats  [2]*Seat
	gameNo int
	past   bool
}

func (p *pastGame) review() *reviewGame {
	return &reviewGame{m: p.m, order: p.order, seats: p.seats, gameNo: p.gameNo, past: true}
}

// reviewTargetLocked is the game the room's own review buttons are about: the current game once it's over, else
// (back in the lobby) the last one.
func (r *Room) reviewTargetLocked() *reviewGame {
	if r.overLocked() {
		return &reviewGame{m: r.m, order: r.order, seats: r.seats, gameNo: r.gameNo}
	}
	if r.m == nil && len(r.games) > 0 {
		return r.games[len(r.games)-1].review()
	}
	return nil
}

// gameLocked finds a finished game by number (0: the room's default, above).
func (r *Room) gameLocked(no int) *reviewGame {
	if no == 0 {
		return r.reviewTargetLocked()
	}
	if r.overLocked() && r.gameNo == no {
		return r.reviewTargetLocked()
	}
	for _, p := range r.games {
		if p.gameNo == no {
			return p.review()
		}
	}
	return nil
}

// gameByReviewLocked finds the game an analysis belongs to (nil once it's no longer kept).
func (r *Room) gameByReviewLocked(rv *Review) *reviewGame {
	if r.overLocked() && r.m.Review == rv {
		return r.reviewTargetLocked()
	}
	for _, p := range r.games {
		if p.m.Review == rv {
			return p.review()
		}
	}
	return nil
}

// archiveLocked keeps the current game if it's finished (called before a rematch or going back to the lobby).
func (r *Room) archiveLocked() {
	r.closeReviewLocked()
	if !r.overLocked() {
		return
	}
	if n := len(r.games); n > 0 && r.games[n-1].m == r.m {
		return
	}
	var seats [2]*Seat
	for i, s := range r.seats {
		if s != nil {
			seats[i] = &Seat{Name: s.Name, Bot: s.Bot, Level: s.Level}
		}
	}
	r.games = append(r.games, &pastGame{m: r.m, order: r.order, seats: seats, gameNo: r.gameNo, ended: time.Now()})
	if len(r.games) > keepGames {
		r.games = r.games[len(r.games)-keepGames:]
	}
}

// player reports whether the client had a seat (as a person) in this game. Seat tokens stay with the room, so the
// seat's holder now is the person who played it then.
func (g *reviewGame) player(cl *Client) bool {
	return cl.role == "player" && cl.seat >= 0 && g.human(cl.seat)
}

func (g *reviewGame) human(seat int) bool { return g.seats[seat] != nil && !g.seats[seat].Bot }

func (g *reviewGame) names() [2]string {
	var n [2]string
	for i, s := range g.seats {
		n[i] = fmt.Sprintf("Player %d", i+1)
		if s != nil && s.Name != "" {
			n[i] = s.Name
		}
	}
	return n
}

// steps lists the moves to walk through: plays, passes and exchanges by people.
func (g *reviewGame) steps() []int {
	out := []int{}
	for i, ev := range g.m.eng.tp.History().Events {
		switch ev.Type {
		case pb.GameEvent_TILE_PLACEMENT_MOVE, pb.GameEvent_EXCHANGE, pb.GameEvent_PASS:
			if g.human(g.order[ev.PlayerIndex]) {
				out = append(out, i)
			}
		}
	}
	return out
}

// ---- the live walkthrough ----

// The review closes by itself if nobody moves it on: after reviewIdle the TV and the driving phone ask
// "Still reviewing?", and reviewGrace later it closes (the TV goes back to the result).
var (
	reviewIdle  = 10 * time.Minute
	reviewGrace = 5 * time.Minute
)

// reviewSession is a walkthrough in progress (not saved). The room has one shared session, shown on the TV, used
// while no game is being played; while a new game is on, a player looks back at an earlier one on their phone only
// (a private session, kept on their connection).
type reviewSession struct {
	open   bool
	game   int // the game's number
	driver int // seat of the phone driving it; -1: the TV remote
	pos    int // index into Steps; -1 = the overview
	view   *stepView
	id     int       // which opening this is, for the idle timers
	warn   time.Time // "Still reviewing?" is showing; the review closes at this time
}

type prevMove struct {
	Seat  int    `json:"seat"`
	Text  string `json:"text"`
	Pos   string `json:"pos,omitempty"`
	Score int    `json:"score"`
}

// stepView is one move of the walkthrough as everyone sees it: the board before the move, the mover's rack,
// the move before it (for context) and what was played; the analysis arrives in the review's turns.
type stepView struct {
	Ev        int        `json:"ev"`
	Seat      int        `json:"seat"`
	Rack      string     `json:"rack"`
	Board     []string   `json:"board"`
	Scores    [2]int     `json:"scores"` // before the move, by seat
	Bag       int        `json:"bag"`
	Prev      *prevMove  `json:"prev,omitempty"`
	PrevCells []Cell     `json:"prevCells,omitempty"`
	Played    ReviewMove `json:"played"`
}

// openReviewLocked: a player (or the TV remote) opens the review of a finished game (0: the room's default one).
// In the shared session the first one drives; while their phone is connected, the other player follows along.
func (r *Room) openReviewLocked(cl *Client, no int) {
	g := r.gameLocked(no)
	if !analysisOn() || g == nil || !(g.player(cl) || cl.role == "tv" && g.human(0) || cl.role == "tv" && g.human(1)) {
		return
	}
	driver := cl.seat
	if cl.role == "tv" {
		driver = -1
	}
	private := r.playingLocked() // a new game is on: look back on this phone only
	if private && cl.role == "tv" {
		return
	}
	if !private && r.rv.open && r.rv.driver != driver && r.driverHereLocked() {
		who := "The TV remote"
		if r.rv.driver >= 0 {
			who = g.names()[r.rv.driver]
		}
		sendJSON(cl, map[string]any{"t": "notice", "msg": who + " is going through a game review — follow along here or on the TV"})
		return
	}
	if g.m.Review == nil {
		g.m.Review = &Review{Depth: analysisMode, Steps: g.steps(), Turns: map[int]*TurnReview{}}
	}
	if !g.m.Review.complete() && !reviewQ.has(g.m.Review) {
		if !reviewQ.add(r, g.m.Review) {
			stats.LimitReview.Add(1)
			r.errTo(cl, "The analyser is busy with other games — try again in a few minutes")
			return
		}
		stats.Reviews.Add(1)
	}
	if private {
		if cl.rv == nil || !cl.rv.open || cl.rv.game != g.gameNo {
			cl.rv = &reviewSession{open: true, game: g.gameNo, driver: cl.seat, pos: -1}
		}
		r.setStepLocked(cl.rv, g, cl.rv.pos)
		sendJSON(cl, r.stateFor(cl))
		return
	}
	cl.rv = nil
	if !r.rv.open || r.rv.game != g.gameNo {
		r.reviewIDs++
		r.rv = reviewSession{open: true, game: g.gameNo, pos: -1, id: r.reviewIDs}
	}
	r.rv.driver = driver
	r.setStepLocked(&r.rv, g, r.rv.pos)
	r.touchReviewLocked()
	r.broadcastLocked()
}

// driverHereLocked: the shared session's driver is still around (a connected phone; the remote counts as gone, so a
// phone can always take over from it).
func (r *Room) driverHereLocked() bool {
	d := r.rv.driver
	if d < 0 {
		return false
	}
	g := r.gameLocked(r.rv.game)
	return r.seatConnected(d) && g != nil && g.human(d)
}

// sessionFor is the walkthrough a client sees: their private one, else the shared one if the game was theirs (the
// TV always sees the shared one).
func (r *Room) sessionFor(cl *Client) (*reviewSession, *reviewGame) {
	if cl.rv != nil && cl.rv.open {
		if g := r.gameLocked(cl.rv.game); g != nil {
			return cl.rv, g
		}
		cl.rv = nil
	}
	if r.rv.open {
		if g := r.gameLocked(r.rv.game); g != nil && (cl.role == "tv" || g.player(cl)) {
			return &r.rv, g
		}
	}
	return nil, nil
}

// canDriveLocked: the phone driving it (or owning a private one), or the TV remote once no phone drives.
func (r *Room) canDriveLocked(cl *Client, s *reviewSession) bool {
	if s == nil || !s.open {
		return false
	}
	if s != &r.rv {
		return s == cl.rv
	}
	if cl.role == "player" && cl.seat >= 0 && cl.seat == s.driver {
		return true
	}
	return cl.role == "tv" && !r.driverHereLocked()
}

func (r *Room) reviewMsgLocked(cl *Client, m inMsg) {
	if m.Op == "open" {
		r.openReviewLocked(cl, m.Game)
		return
	}
	s, g := r.sessionFor(cl)
	if s == nil {
		return
	}
	shared := s == &r.rv
	switch m.Op {
	case "step":
		if m.Pos == nil || !r.canDriveLocked(cl, s) {
			return
		}
		r.setStepLocked(s, g, *m.Pos)
	case "still": // "Still reviewing?" answered: anyone who can see it
		if !shared {
			return
		}
	case "close":
		if !r.canDriveLocked(cl, s) {
			return
		}
		if !shared {
			cl.rv = nil
			sendJSON(cl, r.stateFor(cl))
			return
		}
		r.closeReviewLocked()
		r.broadcastLocked()
		return
	default:
		return
	}
	if !shared {
		sendJSON(cl, r.stateFor(cl))
		return
	}
	r.touchReviewLocked()
	r.broadcastLocked()
}

func (r *Room) closeReviewLocked() {
	r.rv = reviewSession{}
	if r.rvTimer != nil {
		r.rvTimer.Stop()
		r.rvTimer = nil
	}
}

// touchReviewLocked restarts the shared session's idle countdown (it was opened, moved on, or "Still reviewing?"
// was answered).
func (r *Room) touchReviewLocked() {
	r.rv.warn = time.Time{}
	if r.rvTimer != nil {
		r.rvTimer.Stop()
	}
	id := r.rv.id
	r.rvTimer = time.AfterFunc(reviewIdle, func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		if !r.rv.open || r.rv.id != id || r.deleted {
			return
		}
		r.rv.warn = time.Now().Add(reviewGrace)
		r.broadcastLocked()
		r.rvTimer = time.AfterFunc(reviewGrace, func() {
			r.mu.Lock()
			defer r.mu.Unlock()
			if !r.rv.open || r.rv.id != id || r.rv.warn.IsZero() || r.deleted {
				return
			}
			r.closeReviewLocked()
			r.broadcastLocked()
		})
	})
}

func (r *Room) setStepLocked(s *reviewSession, g *reviewGame, pos int) {
	rv := g.m.Review
	pos = max(-1, min(pos, len(rv.Steps)-1))
	s.pos, s.view = pos, nil
	if pos < 0 {
		return
	}
	v, err := buildStepView(g, rv.Steps[pos])
	if err != nil {
		slog.Warn("review step", "room", r.Code, "err", err)
		return
	}
	s.view = v
}

func buildStepView(g *reviewGame, ev int) (*stepView, error) {
	h := g.m.eng.tp.History()
	rules, err := getRules(g.m.eng.Lexicon)
	if err != nil {
		return nil, err
	}
	gm, err := game.NewFromHistory(h, rules, ev)
	if err != nil {
		return nil, err
	}
	e := &Engine{tp: &turnplayer.BaseTurnPlayer{Game: gm}, Lexicon: g.m.eng.Lexicon}
	evt := h.Events[ev]
	v := &stepView{Ev: ev, Seat: g.order[evt.PlayerIndex], Rack: evt.Rack, Board: e.Board(), Bag: e.BagCount()}
	for i := 0; i < 2; i++ {
		v.Scores[g.order[i]] = e.Score(i)
	}
	v.Played = eventMove(evt)
	// the move just before, by the other player (a bot's reply, in a game against the computer)
	for i := ev - 1; i >= 0; i-- {
		pe := h.Events[i]
		if pe.PlayerIndex == evt.PlayerIndex {
			break
		}
		pm := eventMove(pe)
		if pm.Kind == "" {
			continue
		}
		text := pm.Word
		switch pm.Kind {
		case "exchange":
			text = fmt.Sprintf("exchanged %d", len([]rune(pe.Exchanged)))
		case "pass":
			text = "passed"
		}
		v.Prev = &prevMove{Seat: g.order[pe.PlayerIndex], Text: text, Pos: pm.Pos, Score: pm.Score}
		v.PrevCells = pm.Cells
		break
	}
	return v, nil
}

// eventMove describes a move from the game record.
func eventMove(evt *pb.GameEvent) ReviewMove {
	switch evt.Type {
	case pb.GameEvent_TILE_PLACEMENT_MOVE:
		m := ReviewMove{Kind: "play", Pos: evt.Position, Score: int(evt.Score), Bingo: evt.IsBingo}
		if len(evt.WordsFormed) > 0 {
			m.Word = evt.WordsFormed[0]
		}
		for k, ch := range []rune(evt.PlayedTiles) {
			if ch == '.' {
				continue
			}
			c := Cell{R: int(evt.Row), C: int(evt.Column), L: string(ch)}
			if evt.Direction == pb.GameEvent_VERTICAL {
				c.R += k
			} else {
				c.C += k
			}
			m.Cells = append(m.Cells, c)
		}
		return m
	case pb.GameEvent_EXCHANGE:
		return ReviewMove{Kind: "exchange", Tiles: evt.Exchanged}
	case pb.GameEvent_PASS:
		return ReviewMove{Kind: "pass"}
	}
	return ReviewMove{}
}

// reviewViewLocked is the review part of a client's state: whether a review can be opened (for the room's default
// game), and the walkthrough the client is in. Spectators' phones get nothing; the TV shows the shared walkthrough.
func (r *Room) reviewViewLocked(cl *Client) map[string]any {
	var out map[string]any
	if g := r.reviewTargetLocked(); g != nil && (g.player(cl) || cl.role == "tv") {
		// with the analyser off (WT_ANALYSIS=off), players still get the game file
		out = map[string]any{"available": true, "analysis": analysisOn(), "past": g.past, "gameNo": g.gameNo, "you": g.player(cl),
			"tvCan": cl.role == "tv" && analysisOn() && (g.human(0) || g.human(1))}
	}
	s, g := r.sessionFor(cl)
	if s == nil || !analysisOn() {
		return out
	}
	if out == nil {
		out = map[string]any{"available": true, "analysis": true}
	}
	rv := g.m.Review
	h := g.m.eng.tp.History()
	seats := make([]map[string]any, 2)
	names := g.names()
	for i := range seats {
		x := map[string]any{"name": names[i], "bot": g.seats[i] != nil && g.seats[i].Bot}
		if g.seats[i] != nil && g.seats[i].Bot {
			x["level"] = botLevelFor(g.seats[i])
		}
		seats[i] = x
	}
	marks := make([]map[string]any, len(rv.Steps))
	for k, ev := range rv.Steps {
		mk := map[string]any{"ev": ev, "seat": g.order[h.Events[ev].PlayerIndex]}
		if t := rv.Turns[ev]; t != nil {
			mk["verdict"], mk["missedBingo"] = t.Verdict, t.MissedBingo
		}
		marks[k] = mk
	}
	finals := [2]int{}
	for i := 0; i < 2; i++ {
		finals[i] = g.m.eng.Score(g.engIdx(i)) + g.m.Adj[i]
	}
	shared := s == &r.rv
	out["open"] = true
	out["game"] = g.gameNo
	out["shared"] = shared
	out["you"] = g.player(cl)
	out["driver"] = s.driver
	out["driverHere"] = !shared || r.driverHereLocked()
	out["pos"] = s.pos
	out["marks"] = marks
	out["done"] = len(rv.Turns)
	out["depth"] = rv.Depth
	out["queue"] = reviewQ.position(rv)
	out["seats"] = seats
	out["finals"] = finals
	out["lexicon"] = g.m.eng.Lexicon
	out["bonuses"] = g.m.eng.Bonuses()
	out["board"] = g.m.eng.Board() // the final position, for the overview
	if shared && !s.warn.IsZero() {
		out["closeIn"] = max(0, time.Until(s.warn).Milliseconds()) // "Still reviewing?"
	}
	if v := s.view; v != nil {
		out["step"] = v
		out["turn"] = rv.Turns[v.Ev]
	}
	return out
}

func (g *reviewGame) engIdx(seat int) int {
	if g.order[0] == seat {
		return 0
	}
	return 1
}

// ---- the analyser: one game at a time, server-wide ----

type reviewJob struct {
	r  *Room
	rv *Review
}

type reviewQueue struct {
	mu   sync.Mutex
	cond *sync.Cond
	jobs []reviewJob // jobs[0] is being analysed
}

var reviewQ = func() *reviewQueue { q := &reviewQueue{}; q.cond = sync.NewCond(&q.mu); return q }()

func (q *reviewQueue) add(r *Room, rv *Review) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.jobs) >= reviewQueueMax {
		return false
	}
	q.jobs = append(q.jobs, reviewJob{r, rv})
	q.cond.Signal()
	return true
}

func (q *reviewQueue) has(rv *Review) bool { return q.position(rv) >= 0 }

// position: -1 not queued, 0 being analysed, n: n games ahead of it.
func (q *reviewQueue) position(rv *Review) int {
	q.mu.Lock()
	defer q.mu.Unlock()
	for i, j := range q.jobs {
		if j.rv == rv {
			return i
		}
	}
	return -1
}

func (q *reviewQueue) next() reviewJob {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.jobs) == 0 {
		q.cond.Wait()
	}
	return q.jobs[0]
}

func (q *reviewQueue) done() {
	q.mu.Lock()
	q.jobs = q.jobs[1:]
	waiting := append([]reviewJob(nil), q.jobs...)
	q.mu.Unlock()
	for _, j := range waiting { // their place in line changed
		j.r.mu.Lock()
		if j.r.rv.open {
			j.r.broadcastLocked()
		}
		j.r.mu.Unlock()
	}
}

func reviewWorker() {
	for {
		j := reviewQ.next()
		runReview(j)
		reviewQ.done()
	}
}

// runReview analyses the job's moves, the one on screen (or the next one after it) first.
func runReview(j reviewJob) {
	r, rv := j.r, j.rv
	r.mu.Lock()
	g := r.gameByReviewLocked(rv)
	if g == nil || r.deleted {
		r.mu.Unlock()
		return
	}
	h := proto.Clone(g.m.eng.tp.History()).(*pb.GameHistory)
	lex := g.m.eng.Lexicon
	r.broadcastLocked() // "analysing" rather than "waiting"
	r.mu.Unlock()
	rules, err := getRules(lex)
	if err != nil {
		slog.Error("review rules", "err", err)
		return
	}
	an := gameanalysis.New(macCfg, analysisConfig(), "woogles-tv")
	for {
		r.mu.Lock()
		if r.gameByReviewLocked(rv) == nil || r.deleted {
			r.mu.Unlock()
			return
		}
		ev := nextTurn(rv, r.onScreenLocked(rv))
		r.mu.Unlock()
		if ev < 0 {
			return
		}
		tr := analyseTurn(an, h, rules, ev)
		stats.ReviewMoves.Add(1)
		r.mu.Lock()
		if r.gameByReviewLocked(rv) != nil {
			rv.Turns[ev] = tr
			r.broadcastLocked()
		}
		r.mu.Unlock()
	}
}

// onScreenLocked: where a walkthrough of this analysis is (the shared one first), or 0.
func (r *Room) onScreenLocked(rv *Review) int {
	if g := r.gameLocked(r.rv.game); r.rv.open && g != nil && g.m.Review == rv {
		return r.rv.pos
	}
	for c := range r.clients {
		if c.rv != nil && c.rv.open {
			if g := r.gameLocked(c.rv.game); g != nil && g.m.Review == rv {
				return c.rv.pos
			}
		}
	}
	return 0
}

// nextTurn picks the move to analyse next: the one on screen, or the first one after it not done yet,
// else the first one not done.
func nextTurn(rv *Review, pos int) int {
	from := max(pos, 0)
	for k := 0; k < len(rv.Steps); k++ {
		ev := rv.Steps[(from+k)%len(rv.Steps)]
		if rv.Turns[ev] == nil {
			return ev
		}
	}
	return -1
}

func analyseTurn(an *gameanalysis.Analyzer, h *pb.GameHistory, rules *game.GameRules, ev int) *TurnReview {
	ctx, cancel := context.WithTimeout(context.Background(), reviewTurnMax)
	defer cancel()
	evt := h.Events[ev]
	tr := &TurnReview{Played: eventMove(evt)}
	ta, err := an.AnalyzeSingleTurn(ctx, h, rules, ev)
	if err != nil || ta == nil || ta.OptimalMove == nil {
		slog.Warn("analyse move", "move", ev, "err", err)
		tr.Err = "This move couldn't be analysed"
		return tr
	}
	// the board before the move, to spell out words that play through tiles already there
	var board []string
	if gm, err := game.NewFromHistory(h, rules, ev); err == nil {
		board = (&Engine{tp: &turnplayer.BaseTurnPlayer{Game: gm}}).Board()
	}
	tr.Verdict = "best"
	if !ta.WasOptimal {
		tr.Verdict = strings.ToLower(ta.MistakeCategory)
		if tr.Verdict == "" {
			tr.Verdict = "small"
		}
	}
	tr.MissedBingo, tr.BlownEndgame = ta.MissedBingo, ta.BlownEndgame
	tr.Best = engineMove(ta.OptimalMove, board)
	switch ta.Phase {
	case gameanalysis.PhaseEndgame:
		tr.Phase = "endgame"
		best := int(ta.OptimalFinalSpread)
		played := best - int(ta.SpreadLoss)
		tr.Best.Spread, tr.Played.Spread = &best, &played
		for _, v := range ta.OtherVariations {
			if v == nil || len(v.Moves) == 0 {
				continue
			}
			m := describedMove(v.Moves[0].MoveDescription, v.Moves[0].Score, board)
			sp := int(v.FinalSpread)
			m.Spread = &sp
			tr.Alts = append(tr.Alts, m)
		}
	case gameanalysis.PhasePreEndgame:
		tr.Phase = "peg"
		tr.Best.Win, tr.Played.Win = ptr(ta.OptimalWinProb), ptr(ta.PlayedWinProb)
		for _, p := range ta.TopPEGPlays { // plays the sim stopped early ("ignored") still have an estimate
			if p == nil {
				continue
			}
			m := describedMove(p.MoveDescription, p.Score, board)
			m.Leave, m.Bingo, m.Win = p.Leave, p.IsBingo, ptr(p.WinProb)
			tr.Alts = append(tr.Alts, m)
		}
	default:
		tr.Phase = "sim"
		tr.Best.Win, tr.Played.Win = ptr(ta.OptimalWinProb), ptr(ta.PlayedWinProb)
		for _, p := range ta.TopSimPlays { // plays the sim stopped early ("ignored") still have an estimate
			if p == nil {
				continue
			}
			m := describedMove(p.MoveDescription, p.Score, board)
			m.Leave, m.Bingo, m.Win = p.Leave, p.IsBingo, ptr(p.WinProb)
			tr.Alts = append(tr.Alts, m)
		}
	}
	alts := tr.Alts[:0] // "other good plays": not the best or the played move again
	for _, a := range tr.Alts {
		if !(a.Kind == tr.Best.Kind && a.Pos == tr.Best.Pos && a.Word == tr.Best.Word) && !(a.Kind == tr.Played.Kind && a.Pos == tr.Played.Pos && a.Word == tr.Played.Word) {
			alts = append(alts, a)
		}
	}
	sort.SliceStable(alts, func(i, j int) bool { return altKey(alts[i]) > altKey(alts[j]) })
	tr.Alts = alts[:min(len(alts), reviewAlts)]
	if ta.WasOptimal { // ties count as best: show what was played
		w, sp := tr.Best.Win, tr.Best.Spread
		tr.Best = tr.Played
		tr.Best.Win, tr.Best.Spread = w, sp
		if tr.Played.Win == nil {
			tr.Played.Win = w
		}
	}
	return tr
}

func ptr[T any](v T) *T { return &v }

// altKey orders other plays: by winning chances, or in the endgame by the final margin.
func altKey(m ReviewMove) float64 {
	if m.Win != nil {
		return *m.Win
	}
	if m.Spread != nil {
		return float64(*m.Spread)
	}
	return -1e9
}

// engineMove describes one of Macondo's moves; play-through letters come from the board before the move.
func engineMove(m *move.Move, board []string) ReviewMove {
	switch m.Action() {
	case move.MoveTypeExchange:
		return ReviewMove{Kind: "exchange", Tiles: m.TilesStringExchange(), Leave: m.LeaveString()}
	case move.MoveTypePass:
		return ReviewMove{Kind: "pass", Leave: m.LeaveString()}
	}
	row, col, vert := m.CoordsAndVertical()
	rm := ReviewMove{Kind: "play", Pos: strings.TrimSpace(m.BoardCoords()), Score: m.Score(), Bingo: m.BingoPlayed(), Leave: m.LeaveString()}
	var word strings.Builder
	alph := m.Alphabet()
	for k, t := range m.Tiles() {
		r, c := row, col+k
		if vert {
			r, c = row+k, col
		}
		if t == 0 {
			if board != nil && r < len(board) && c < len(board[r]) {
				word.WriteString(strings.ToUpper(string(board[r][c])))
			}
			continue
		}
		l := t.UserVisible(alph, false)
		word.WriteString(strings.ToUpper(l))
		rm.Cells = append(rm.Cells, Cell{R: r, C: c, L: l})
	}
	rm.Word = word.String()
	return rm
}

var descRe = regexp.MustCompile(`^\s*([A-O]?)(\d{1,2})([A-O]?)\s+(\S+)`)

// describedMove reads a move from Macondo's short notation ("C7 G.NTLER", "8K .EIKI", "(exch ABC)", "(Pass)").
func describedMove(desc string, score int, board []string) ReviewMove {
	d := strings.TrimSpace(desc)
	low := strings.ToLower(d)
	switch {
	case strings.HasPrefix(low, "(exch"):
		return ReviewMove{Kind: "exchange", Tiles: strings.TrimSuffix(strings.TrimSpace(d[5:]), ")")}
	case strings.HasPrefix(low, "(pass"):
		return ReviewMove{Kind: "pass"}
	}
	m := descRe.FindStringSubmatch(d)
	if m == nil {
		return ReviewMove{Kind: "play", Word: d, Score: score}
	}
	rowN, _ := strconv.Atoi(m[2])
	vert := m[1] != "" // column letter first: down
	colL := m[1] + m[3]
	if colL == "" {
		return ReviewMove{Kind: "play", Word: d, Score: score}
	}
	row, col := rowN-1, int(colL[0]-'A')
	rm := ReviewMove{Kind: "play", Pos: m[1] + m[2] + m[3], Score: score}
	var word strings.Builder
	for k, ch := range []rune(m[4]) {
		r, c := row, col+k
		if vert {
			r, c = row+k, col
		}
		if ch == '.' {
			if board != nil && r >= 0 && r < len(board) && c >= 0 && c < len(board[r]) {
				word.WriteString(strings.ToUpper(string(board[r][c])))
			}
			continue
		}
		word.WriteString(strings.ToUpper(string(ch)))
		rm.Cells = append(rm.Cells, Cell{R: r, C: c, L: string(ch)})
	}
	rm.Word = word.String()
	return rm
}

// ---- GCG: the standard game file (Woogles.io, Macondo, Quackle) ----

var gcgNick = regexp.MustCompile(`[^A-Za-z0-9_\-]+`)

// gcgLocked returns a finished game (0: the room's default one) as GCG, with the players' names as they appear in
// the game.
func (r *Room) gcgLocked(no int) (string, string, error) {
	g := r.gameLocked(no)
	if g == nil {
		return "", "", fmt.Errorf("no finished game")
	}
	h := proto.Clone(g.m.eng.tp.History()).(*pb.GameHistory)
	names := g.names()
	for i, p := range h.Players {
		n := names[g.order[i]]
		nick := strings.Trim(gcgNick.ReplaceAllString(n, "_"), "_")
		if nick == "" {
			nick = fmt.Sprintf("player%d", i+1)
		}
		if i == 1 && h.Players[0].Nickname == nick {
			nick += "2"
		}
		p.Nickname, p.RealName = nick, n
	}
	s, err := gcgio.GameHistoryToGCG(h, true)
	if err != nil {
		return "", "", err
	}
	file := fmt.Sprintf("woogles-tv-%s-%s-vs-%s.gcg", time.Now().Format("2006-01-02"), h.Players[0].Nickname, h.Players[1].Nickname)
	return s, file, nil
}

// POST /api/gcg {code, token, game}: a finished game's file, for its players only.
func handleGCG(w http.ResponseWriter, req *http.Request) {
	var in struct {
		Code, Token string
		Game        int
	}
	if !readJSON(w, req, &in) {
		return
	}
	r := getRoom(in.Code)
	if r == nil {
		writeJSON(w, 404, map[string]string{"error": "not found"})
		return
	}
	seat, ok := r.authorize("player", "", in.Token)
	if !ok || seat < 0 {
		writeJSON(w, 403, map[string]string{"error": "only the players can download the game"})
		return
	}
	r.mu.Lock()
	var s, file string
	err := fmt.Errorf("not your game")
	if g := r.gameLocked(in.Game); g != nil && g.human(seat) {
		s, file, err = r.gcgLocked(in.Game)
	}
	r.mu.Unlock()
	if err != nil {
		writeJSON(w, 404, map[string]string{"error": err.Error()})
		return
	}
	stats.GCGDownloads.Add(1)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+file+`"`)
	w.Header().Set("X-Filename", file)
	w.Write([]byte(s))
}
