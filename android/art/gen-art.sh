#!/usr/bin/env bash
# Generates the TV banner and launcher icons with ImageMagick.
# Output is committed under res/, so this only needs re-running if you change the art.
set -euo pipefail
cd "$(dirname "$0")/.."
FONT=Helvetica-Bold
BG1='#0b3d3a'; BG2='#14635b'; TILE='#f3e6c4'; EDGE='#c9b48a'; INK='#2a1d0e'
declare -A PTS=([W]=4 [O]=1 [G]=2 [L]=1 [E]=1 [S]=1 [T]=1 [V]=4)
A=()

tile() { # x y size letter
  local x=$1 y=$2 s=$3 l=$4 r=$(( $3 / 7 ))
  local fs=$(( s * 64 / 100 )) ps=$(( s * 26 / 100 ))
  A+=(-fill '#00000066' -draw "roundrectangle $((x+2)),$((y+3)) $((x+s+2)),$((y+s+3)) $r,$r")
  A+=(-fill "$EDGE" -draw "roundrectangle $x,$y $((x+s)),$((y+s)) $r,$r")
  A+=(-fill "$TILE" -draw "roundrectangle $x,$y $((x+s)),$((y+s-2)) $r,$r")
  # letter centred (slightly up-left) on the tile, using offsets from image centre
  local cx=$(( x + s*46/100 - IW/2 )) cy=$(( y + s*46/100 - IH/2 ))
  A+=(-fill "$INK" -font $FONT -gravity Center -pointsize $fs -annotate "$(printf '%+d%+d' $cx $cy)" "$l")
  A+=(-gravity NorthWest -pointsize $ps -annotate "+$((x + s*72/100))+$((y + s*62/100))" "${PTS[$l]}")
}
word() { # word x y size gap
  local w=$1 i
  for ((i=0;i<${#w};i++)); do tile $(( $2 + i*($4+$5) )) $3 $4 "${w:i:1}"; done
}

# Banner 320x180: WOOGLES on row one, TV below.
IW=320; IH=180; A=(); word WOOGLES 22 42 36 4; word TV 118 90 40 4
convert -size 320x180 "gradient:$BG2-$BG1" "${A[@]}" res/drawable/banner.png

# Launcher icon: W / T V tiles on a dark-teal rounded square.
IW=192; IH=192; A=(); tile 20 18 96 W; tile 34 122 54 T; tile 108 106 62 V
convert -size 192x192 xc:none -fill "$BG2" -draw "roundrectangle 4,4 188,188 38,38" "${A[@]}" /tmp/wtv-icon.png
for d in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  convert /tmp/wtv-icon.png -resize "${d#*:}x${d#*:}" "res/mipmap-${d%%:*}/ic_launcher.png"
done
echo "art generated"
