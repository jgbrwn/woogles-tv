# Server voice for the announcer

The announcer can use a natural-sounding voice generated on your server instead of the TV's or phone's built-in
speech. That also gives a voice to TVs whose browsers have no speech support (LG webOS, many smart-TV browsers):
anything that can play sound can play the server's audio.

It's optional. Without it, the announcer uses the device's own speech, as before.

## How it works

```
 TV / phone page                    Woogles-TV (Go)                         speech engine (Docker, localhost)
 announcer.js writes the sentence   POST /api/tts                           audio.cpp serving Kyutai's
 "Alex plays zoea for 34 points." ─▶ checks the room credential, text,  ──▶ Pocket TTS (100M, English)
                                    voice and rate limits; small cache      /v1/audio/speech, streamed PCM
 plays each chunk via Web Audio  ◀── streams the audio back as it comes ◀──
```

- The page sends the sentence it was going to speak, with its room credential: the **TV key** on the TV, or the
  **seat token** on a seated phone. Spectators and anyone with only the join key can't use it.
- Audio is 16-bit mono PCM at 24 kHz, streamed: the first sound plays about a third of a second after a move, while
  the rest is still being generated (roughly 1.3× faster than real time on one CPU core).
- **Fallback:** if the server voice fails, is too slow to start (5 s), or isn't configured, the page speaks with
  the device: the Android TV app's text-to-speech, or the browser's Web Speech, in the *backup voice* chosen in the
  settings. After two failures in a row it uses the device for a minute before trying the server again.
- A fixed random seed makes each voice sound the same every time, and finished clips (clock warnings, "The bag is
  empty.", menu samples) are cached in memory (48 MB).
- Speaking speed: Pocket TTS can't change its speed, so *Slow* and *Fast* play the audio at 0.9× and 1.12×,
  which shifts the pitch a little.

## Setup

Needs Docker and about 300 MB of disk for the model and voices, and ~400 MB of RAM while running.

```sh
tts/fetch-models.sh                              # once: model (~130 MB) + 26 English voices (~165 MB)
docker compose -f tts/docker-compose.yml up -d   # engine on 127.0.0.1:8431 only, restarts with Docker
```

Then start Woogles-TV with `WT_TTS_URL=http://127.0.0.1:8431` (systemd: add it to the unit's `EnvironmentFile`)
and restart it. The log says `server speech on … voices=15 default=cosette`.

**All in Docker:** run `tts/fetch-models.sh`, uncomment `WT_TTS_URL: http://tts:8431` in `docker-compose.yml`, then
`docker compose --profile tts up -d`.

The image is pinned by digest in both compose files. audio.cpp changes quickly; update the digest deliberately and
listen to a few announcements afterwards. (Its prebuilt binaries need glibc 2.43, e.g. Ubuntu 26.04; the Docker
image avoids that.)

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `WT_TTS_URL` | empty (off) | Base URL of the speech engine, e.g. `http://127.0.0.1:8431` |
| `WT_TTS_MODEL` | `pocket` | Model id in `tts/server.json` |
| `WT_TTS_VOICES` | `cosette,caro_davy,anna,azelma,charles,eve,fantine,jane,marius,mary,michael,paul,peter_yearsley,stuart_bell,vera` | Voices offered, in menu order. **The first is the default.** Names are the files in `tts/models/PocketTTS-GGUF/english/embeddings/` |

The default list leaves out voices that made mistakes in testing (javert, juergen, rafael, jean) and a few others;
the remaining English voices (alba, bill_boerst, eponine, estelle, george, giovanni, lola) can be added.

Each TV and phone remembers its own voice choice; a device that hasn't chosen one uses the first in the list.

## Limits and security

- `/api/tts` accepts only a room's TV key or a seat token, text up to 700 characters, and voices from
  `WT_TTS_VOICES`. It allows 60 requests per minute per room (bursts of 30) and 180 per minute overall; cached
  clips don't count.
- At most three requests go to the engine at a time (it works through them one by one); a request that can't start
  within 4 s gets a 503 and the page falls back to device speech.
- The engine listens on 127.0.0.1 only (or only on the Compose network), runs as a read-only container with no
  capabilities, and is limited to 1.5 CPUs and 1 GB of RAM.
- It runs with **one CPU thread**. On a 2-core server, two threads competing with a bot's move search slowed speech
  to a third of real time; with one thread it stays ahead of playback either way.

## Credits

[audio.cpp](https://github.com/0xShug0/audio.cpp) (Apache-2.0) runs the model.
[Pocket TTS](https://huggingface.co/kyutai/pocket-tts) is by Kyutai (CC-BY-4.0), in the GGUF packaging published by
audio.cpp. See [NOTICE](../NOTICE).
