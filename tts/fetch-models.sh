#!/bin/sh
# Downloads Kyutai's Pocket TTS (English, Q8 GGUF packaged by audio.cpp) and its English voices into tts/models.
# Models: CC-BY-4.0, https://huggingface.co/kyutai/pocket-tts — see NOTICE.
set -eu
cd "$(dirname "$0")"
REV=ca0b203eb1bb87f333a7cfbad2d5f6672b4ccba7   # audio-cpp/audio.cpp-gguf revision these were tested with
BASE="https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/$REV/PocketTTS-GGUF/english"
DIR=models/PocketTTS-GGUF/english
mkdir -p "$DIR/embeddings"
get() { [ -s "$DIR/$1" ] || { echo "downloading $1"; curl -fsSL -o "$DIR/$1.part" "$BASE/$1" && mv "$DIR/$1.part" "$DIR/$1"; }; }
get pocket-tts-english-q8_0.gguf
# All English voices (choose which ones the app offers with WT_TTS_VOICES).
for v in alba anna azelma bill_boerst caro_davy charles cosette eponine estelle eve fantine george giovanni jane \
         javert jean juergen lola marius mary michael paul peter_yearsley rafael stuart_bell vera; do
  get "embeddings/$v.safetensors"
done
echo "done: $(du -sh models | cut -f1) in $(pwd)/models"
