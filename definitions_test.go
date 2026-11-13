package main

import "testing"

func TestParseWooglesDef(t *testing.T) {
	cases := map[string][]Sense{
		"to treat with a cleansing agent [v SOAPED, SOAPING, SOAPS]":          {{"verb", "to treat with a cleansing agent"}},
		"a larval form of certain crustaceans [n ZOEAE, ZOEAS] : ZOEAL [adj]": {{"noun", "a larval form of certain crustaceans"}},
		"(Chinese) a life force, also KI [n -S]":                              {{"noun", "a life force"}},
		"(Greek) expressing Bacchic frenzy, also EVOE, EVHOE, EVOHE [interj]": {{"interjection", "expressing Bacchic frenzy"}},
		"to cover with the chemical element whose atomic number is 82 [v LEADED, LEADING, LEADS] / to show the way to by going in advance [v LEADING, LEADS, LED] : LEADABLE [adj]": {
			{"verb", "to cover with the chemical element whose atomic number is 82"}, {"verb", "to show the way to by going in advance"}},
		"(Arabic) a shrub of East Africa, Arabia, etc., or its leaves, chewed or taken as tea for their stimulant effect, also KAT, KHAT [n -S]": {
			{"noun", "a shrub of East Africa, Arabia, etc., or its leaves, chewed or taken as tea for their stimulant effect"}},
		"chiao (a monetary unit of China) [n JIAO, JIAOS]": {{"noun", "chiao (a monetary unit of China)"}},
	}
	for in, want := range cases {
		got := parseWooglesDef(in)
		if len(got) != len(want) {
			t.Errorf("%q: got %v", in, got)
			continue
		}
		for i := range got {
			if got[i] != want[i] {
				t.Errorf("%q: sense %d = %+v, want %+v", in, i, got[i], want[i])
			}
		}
	}
}
