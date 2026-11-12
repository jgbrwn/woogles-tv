package main

// engine.go wraps the Macondo (Woogles.io) game engine.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/domino14/macondo/ai/bot"
	"github.com/domino14/macondo/board"
	"github.com/domino14/macondo/config"
	"github.com/domino14/macondo/game"
	pb "github.com/domino14/macondo/gen/api/proto/macondo"
	"github.com/domino14/macondo/lexicon"
	"github.com/domino14/macondo/move"
	"github.com/domino14/macondo/turnplayer"
	"github.com/domino14/word-golib/tilemapping"
	"google.golang.org/protobuf/encoding/protojson"
)

var (
	macCfg     *config.Config
	botCfg     *bot.BotConfig
	rulesMu    sync.Mutex
	rulesCache = map[string]*game.GameRules{}
)

var Lexicons = []string{"NWL23", "CSW24"}

func initEngine(dataPath string) error {
	macCfg = config.DefaultConfig()
	macCfg.Set(config.ConfigDataPath, dataPath)
	botCfg = &bot.BotConfig{}
	botCfg.Config = *config.DefaultConfig() //nolint:govet // copied once at startup
	botCfg.Config.Set(config.ConfigDataPath, dataPath)
	// word lists are downloaded here on first start (Macondo expects the directory to exist)
	if err := os.MkdirAll(filepath.Join(dataPath, "lexica", "gaddag"), 0o755); err != nil {
		return err
	}
	for _, l := range Lexicons {
		if err := lexicon.EnsureLexiconFile(l, ".kwg", macCfg.WGLConfig()); err != nil {
			return fmt.Errorf("lexicon %s: %w", l, err)
		}
	}
	_, err := getRules(Lexicons[0])
	return err
}

// FetchAll downloads every data file the server can use (word graphs + bot leave files),
// so a machine can run offline afterwards.
func FetchAll() error {
	for _, l := range Lexicons {
		for _, ext := range []string{".kwg", ".klv2"} {
			if err := lexicon.EnsureLexiconFile(l, ext, macCfg.WGLConfig()); err != nil && !errors.Is(err, lexicon.ErrNotPublished) {
				return fmt.Errorf("%s%s: %w", l, ext, err)
			}
		}
	}
	return nil
}

func getRules(lex string) (*game.GameRules, error) {
	rulesMu.Lock()
	defer rulesMu.Unlock()
	if r, ok := rulesCache[lex]; ok {
		return r, nil
	}
	r, err := game.NewBasicGameRules(macCfg, lex, board.CrosswordGameLayout, "english", game.CrossScoreAndSet, game.VarClassic)
	if err != nil {
		return nil, err
	}
	rulesCache[lex] = r
	return r, nil
}

// Tile is a tile placed by a player on the board.
type Tile struct {
	R     int    `json:"r"`
	C     int    `json:"c"`
	L     string `json:"l"`     // uppercase letter shown
	Blank bool   `json:"blank"` // played from a blank
}

type Engine struct {
	tp      *turnplayer.BaseTurnPlayer
	bot     *bot.BotTurnPlayer
	botCode pb.BotRequest_BotCode
	Lexicon string
}

func NewEngine(lex string, names [2]string) (*Engine, error) {
	rules, err := getRules(lex)
	if err != nil {
		return nil, err
	}
	if names[0] == names[1] {
		names[1] += " (2)"
	}
	opts := &turnplayer.GameOptions{ChallengeRule: pb.ChallengeRule_VOID}
	players := []*pb.PlayerInfo{
		{Nickname: "p0_" + names[0], RealName: names[0]},
		{Nickname: "p1_" + names[1], RealName: names[1]},
	}
	tp, err := turnplayer.BaseTurnPlayerFromRules(opts, players, rules)
	if err != nil {
		return nil, err
	}
	return &Engine{tp: tp, Lexicon: lex}, nil
}

func (e *Engine) OnTurn() int     { return e.tp.PlayerOnTurn() }
func (e *Engine) Over() bool      { return e.tp.Playing() == pb.PlayState_GAME_OVER }
func (e *Engine) Score(i int) int { return e.tp.PointsFor(i) }
func (e *Engine) BagCount() int   { return e.tp.Bag().TilesRemaining() }
func (e *Engine) Rack(i int) string {
	return e.tp.RackLettersFor(i)
}

// Board returns 15 strings of 15 chars: '.' empty, 'A'-'Z' tile, 'a'-'z' blank.
func (e *Engine) Board() []string {
	b := e.tp.Board()
	alph := e.tp.Alphabet()
	out := make([]string, b.Dim())
	for r := 0; r < b.Dim(); r++ {
		var sb strings.Builder
		for c := 0; c < b.Dim(); c++ {
			ml := b.GetLetter(r, c)
			if ml == 0 {
				sb.WriteByte('.')
			} else {
				sb.WriteString(ml.UserVisible(alph, false))
			}
		}
		out[r] = sb.String()
	}
	return out
}

// Bonuses returns 15 strings with codes: '=' TW, '-' DW, '"' TL, '\” DL, ' ' none.
func (e *Engine) Bonuses() []string {
	b := e.tp.Board()
	out := make([]string, b.Dim())
	for r := 0; r < b.Dim(); r++ {
		var sb strings.Builder
		for c := 0; c < b.Dim(); c++ {
			bs := b.GetBonus(r, c)
			if bs == 0 {
				bs = ' '
			}
			sb.WriteByte(byte(bs))
		}
		out[r] = sb.String()
	}
	return out
}

// buildMove converts loose placed tiles into a Macondo move (not yet validated for words).
func (e *Engine) buildMove(tiles []Tile) (*move.Move, error) {
	if len(tiles) == 0 {
		return nil, errors.New("place some tiles first")
	}
	b := e.tp.Board()
	dim := b.Dim()
	seen := map[[2]int]bool{}
	for _, t := range tiles {
		if t.R < 0 || t.C < 0 || t.R >= dim || t.C >= dim {
			return nil, errors.New("tile off the board")
		}
		if b.HasLetter(t.R, t.C) {
			return nil, errors.New("square already occupied")
		}
		if seen[[2]int{t.R, t.C}] {
			return nil, errors.New("two tiles on one square")
		}
		seen[[2]int{t.R, t.C}] = true
		if len(t.L) != 1 || t.L[0] < 'A' || t.L[0] > 'Z' {
			return nil, errors.New("bad letter")
		}
	}
	sameRow, sameCol := true, true
	for _, t := range tiles {
		sameRow = sameRow && t.R == tiles[0].R
		sameCol = sameCol && t.C == tiles[0].C
	}
	if !sameRow && !sameCol {
		return nil, errors.New("tiles must be in one row or column")
	}
	vertical := !sameRow
	if len(tiles) == 1 {
		// choose the direction that forms the longer word
		t := tiles[0]
		h := (t.C > 0 && b.HasLetter(t.R, t.C-1)) || (t.C < dim-1 && b.HasLetter(t.R, t.C+1))
		v := (t.R > 0 && b.HasLetter(t.R-1, t.C)) || (t.R < dim-1 && b.HasLetter(t.R+1, t.C))
		vertical = v && !h
	}
	pos := func(t Tile) int {
		if vertical {
			return t.R
		}
		return t.C
	}
	sort.Slice(tiles, func(i, j int) bool { return pos(tiles[i]) < pos(tiles[j]) })
	fixed := tiles[0].R
	if vertical {
		fixed = tiles[0].C
	}
	has := func(p int) bool {
		if vertical {
			return b.HasLetter(p, fixed)
		}
		return b.HasLetter(fixed, p)
	}
	start, end := pos(tiles[0]), pos(tiles[len(tiles)-1])
	for start > 0 && has(start-1) {
		start--
	}
	for end < dim-1 && has(end+1) {
		end++
	}
	placed := map[int]Tile{}
	for _, t := range tiles {
		placed[pos(t)] = t
	}
	var word strings.Builder
	for p := start; p <= end; p++ {
		if t, ok := placed[p]; ok {
			if t.Blank {
				word.WriteString(strings.ToLower(t.L))
			} else {
				word.WriteString(t.L)
			}
		} else if has(p) {
			word.WriteByte('.')
		} else {
			return nil, errors.New("tiles must be connected with no gaps")
		}
	}
	var coords string
	if vertical {
		coords = fmt.Sprintf("%c%d", 'A'+fixed, start+1)
	} else {
		coords = fmt.Sprintf("%d%c", fixed+1, 'A'+start)
	}
	m, err := e.tp.NewPlacementMove(e.OnTurn(), coords, word.String(), false)
	if err != nil {
		return nil, prettyErr(err)
	}
	return m, nil
}

// Preview scores a tentative placement. Returns score and whether placement is geometrically legal.
func (e *Engine) Preview(tiles []Tile) (int, error) {
	m, err := e.buildMove(tiles)
	if err != nil {
		return 0, err
	}
	return m.Score(), nil
}

func (e *Engine) Play(tiles []Tile) error {
	m, err := e.buildMove(tiles)
	if err != nil {
		return err
	}
	if _, err := e.tp.ValidateMove(m); err != nil {
		return prettyErr(err)
	}
	return e.tp.PlayMove(m, true, 0)
}

func (e *Engine) Pass() error {
	m, _ := e.tp.NewPassMove(e.OnTurn())
	return e.tp.PlayMove(m, true, 0)
}

func (e *Engine) Exchange(letters string) error {
	if letters == "" {
		return errors.New("choose tiles to exchange")
	}
	if e.BagCount() < game.DefaultExchangeLimit {
		return errors.New("not enough tiles in the bag to exchange")
	}
	m, err := e.tp.NewExchangeMove(e.OnTurn(), letters)
	if err != nil {
		return prettyErr(err)
	}
	if _, err := e.tp.ValidateMove(m); err != nil {
		return prettyErr(err)
	}
	return e.tp.PlayMove(m, true, 0)
}

func prettyErr(err error) error {
	s := err.Error()
	switch {
	case strings.Contains(s, "invalid words"):
		if i := strings.Index(s, ":"); i >= 0 {
			return fmt.Errorf("Not in the dictionary:%s", s[i+1:])
		}
	case strings.Contains(s, "center square"):
		return errors.New("The first word must cover the center star")
	case strings.Contains(s, "not connected") || strings.Contains(s, "connected"):
		return errors.New("Your word must connect to tiles on the board")
	}
	return errors.New(strings.ToUpper(s[:1]) + s[1:])
}

type MoveLog struct {
	Player int      `json:"player"`
	Type   string   `json:"type"`
	Pos    string   `json:"pos,omitempty"`
	Tiles  string   `json:"tiles,omitempty"`
	Words  []string `json:"words,omitempty"`
	Score  int      `json:"score"`
	Total  int      `json:"total"`
	Bingo  bool     `json:"bingo,omitempty"`
	Row    int      `json:"row"`
	Col    int      `json:"col"`
	Vert   bool     `json:"vert"`
	Count  int      `json:"count,omitempty"`
	Rack   string   `json:"rack,omitempty"` // only for end-game rack events
}

func (e *Engine) Log() []MoveLog {
	h := e.tp.History()
	out := []MoveLog{}
	for _, ev := range h.Events {
		ml := MoveLog{Player: int(ev.PlayerIndex), Score: int(ev.Score), Total: int(ev.Cumulative),
			Row: int(ev.Row), Col: int(ev.Column), Vert: ev.Direction == pb.GameEvent_VERTICAL}
		switch ev.Type {
		case pb.GameEvent_TILE_PLACEMENT_MOVE:
			ml.Type = "play"
			ml.Pos = ev.Position
			ml.Tiles = ev.PlayedTiles
			ml.Words = ev.WordsFormed
			ml.Bingo = ev.IsBingo
		case pb.GameEvent_EXCHANGE:
			ml.Type = "exchange"
			ml.Count = len([]rune(ev.Exchanged))
		case pb.GameEvent_PASS:
			ml.Type = "pass"
		case pb.GameEvent_END_RACK_PTS:
			ml.Type = "endrack"
			ml.Score = int(ev.EndRackPoints)
			ml.Rack = ev.Rack
		case pb.GameEvent_END_RACK_PENALTY:
			ml.Type = "penalty"
			ml.Score = -int(ev.LostScore)
			ml.Rack = ev.Rack
		default:
			ml.Type = strings.ToLower(ev.Type.String())
		}
		out = append(out, ml)
	}
	return out
}

// Winner: -1 tie, 0/1 index. Only meaningful if Over().
func (e *Engine) Winner() int {
	a, b := e.Score(0), e.Score(1)
	switch {
	case a > b:
		return 0
	case b > a:
		return 1
	}
	return -1
}

// Unseen returns the tiles not visible to player i (bag + opponent rack), as a letter->count map.
func (e *Engine) Unseen(i int) map[string]int {
	out := map[string]int{}
	for _, ml := range e.tp.Bag().Peek() {
		out[ml.UserVisible(e.tp.Alphabet(), false)]++
	}
	for _, ch := range e.Rack(1 - i) {
		out[string(ch)]++
	}
	return out
}

var _ = tilemapping.MachineLetter(0)

// HistoryJSON serializes the full game record (moves, racks, scores) for persistence.
func (e *Engine) HistoryJSON() ([]byte, error) {
	return protojson.Marshal(e.tp.History())
}

// RestoreEngine rebuilds a game from a saved history. Future draws are random,
// which is fine because the bag contents (unseen tiles) are exact.
func RestoreEngine(lex string, hist []byte) (*Engine, error) {
	rules, err := getRules(lex)
	if err != nil {
		return nil, err
	}
	h := &pb.GameHistory{}
	if err := protojson.Unmarshal(hist, h); err != nil {
		return nil, err
	}
	g, err := game.NewFromHistory(h, rules, len(h.Events))
	if err != nil {
		return nil, err
	}
	g.SetBackupMode(game.InteractiveGameplayMode)
	g.SetStateStackLength(1)
	g.SetChallengeRule(pb.ChallengeRule_VOID)
	return &Engine{tp: &turnplayer.BaseTurnPlayer{Game: g}, Lexicon: lex}, nil
}

// BotLevel is a computer opponent, named and calibrated like Woogles.io's bots.
type BotLevel struct {
	ID, Name, Desc string
	Code           pb.BotRequest_BotCode
}

var BotLevels = []BotLevel{
	{"beginner", "BeginnerBot", "Easy · sticks to lower-scoring plays", pb.BotRequest_LEVEL1_PROBABILISTIC},
	{"basic", "BasicBot", "Casual · scores a bit more", pb.BotRequest_LEVEL2_PROBABILISTIC},
	{"better", "BetterBot", "Medium · a step up from BasicBot", pb.BotRequest_LEVEL3_PROBABILISTIC},
	{"stee", "STEEBot", "Hard · strong club player", pb.BotRequest_LEVEL4_PROBABILISTIC},
	{"hasty", "HastyBot", "Expert · always the top static play", pb.BotRequest_HASTY_BOT},
}

func botLevel(id string) BotLevel {
	for _, b := range BotLevels {
		if b.ID == id {
			return b
		}
	}
	return BotLevels[2]
}

// BotMove lets a Macondo bot of the given strength pick and play a move for the player on turn.
func (e *Engine) BotMove(code pb.BotRequest_BotCode) error {
	if e.bot == nil || e.botCode != code {
		b, err := bot.NewBotTurnPlayerFromGame(e.tp.Game, botCfg, code)
		if err != nil {
			return err
		}
		e.bot, e.botCode = b, code
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	m, err := e.bot.BestPlay(ctx)
	if err != nil {
		return err
	}
	return e.tp.PlayMove(m, true, 0)
}
