#!/usr/bin/env bash
# Builds android/out/woogles-tv.apk without Gradle:
#   aapt2 (resources + manifest) -> javac -> d8 (dex) -> zipalign -> apksigner
# Installs the Android SDK pieces into $ANDROID_HOME (default ~/android-sdk) if missing.
set -euo pipefail
cd "$(dirname "$0")"

ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
BUILD_TOOLS_VER=35.0.0
PLATFORM=android-34
MIN_SDK=21
TARGET_SDK=34
# versionCode must increase for upgrades to install over an older APK; default = git commit count.
VERSION_CODE="${VERSION_CODE:-$(git rev-list --count HEAD 2>/dev/null || echo 1)}"
VERSION_NAME="${VERSION_NAME:-1.0.$VERSION_CODE}"
KEYSTORE="${KEYSTORE:-woogles-tv.keystore}"
KS_PASS="${KS_PASS:-wooglestv}"
KS_ALIAS="${KS_ALIAS:-wooglestv}"

BT="$ANDROID_HOME/build-tools/$BUILD_TOOLS_VER"
JAR="$ANDROID_HOME/platforms/$PLATFORM/android.jar"

need() { command -v "$1" >/dev/null || { echo "missing $1 (e.g. apt install openjdk-21-jdk-headless zip unzip curl)" >&2; exit 1; }; }
need javac; need keytool; need java; need zip; need unzip; need curl

if [[ ! -x "$BT/aapt2" || ! -f "$JAR" ]]; then
  echo "== installing Android SDK into $ANDROID_HOME"
  SDKM="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
  if [[ ! -x "$SDKM" ]]; then
    mkdir -p "$ANDROID_HOME/cmdline-tools"
    tmp=$(mktemp -d)
    curl -fsSLo "$tmp/cmd.zip" https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
    unzip -q "$tmp/cmd.zip" -d "$tmp"
    rm -rf "$ANDROID_HOME/cmdline-tools/latest"
    mv "$tmp/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
    rm -rf "$tmp"
  fi
  yes | "$SDKM" --sdk_root="$ANDROID_HOME" --licenses >/dev/null || true
  "$SDKM" --sdk_root="$ANDROID_HOME" "platforms;$PLATFORM" "build-tools;$BUILD_TOOLS_VER" >/dev/null
fi

if [[ ! -f "$KEYSTORE" ]]; then
  echo "== generating signing key $KEYSTORE"
  keytool -genkeypair -noprompt -keystore "$KEYSTORE" -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -alias "$KS_ALIAS" -keyalg RSA -keysize 2048 -validity 36500 \
    -dname "CN=Woogles-TV, O=Woogles-TV" >/dev/null
fi

B=build
rm -rf "$B"; mkdir -p "$B/res" "$B/gen" "$B/classes" "$B/dex" out

echo "== aapt2 (version $VERSION_NAME / code $VERSION_CODE)"
"$BT/aapt2" compile --dir res -o "$B/res.zip"
"$BT/aapt2" link -o "$B/unsigned.apk" -I "$JAR" --manifest AndroidManifest.xml \
  --min-sdk-version $MIN_SDK --target-sdk-version $TARGET_SDK \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  --java "$B/gen" "$B/res.zip"

echo "== javac"
javac --release 11 -encoding UTF-8 -Xlint:-options -nowarn -classpath "$JAR" -d "$B/classes" \
  $(find src "$B/gen" -name '*.java')

echo "== d8"
"$BT/d8" --release --min-api $MIN_SDK --lib "$JAR" --output "$B/dex" $(find "$B/classes" -name '*.class')
(cd "$B/dex" && zip -q -X ../unsigned.apk classes.dex)

echo "== zipalign + sign"
"$BT/zipalign" -f -p 4 "$B/unsigned.apk" "$B/aligned.apk"
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass "pass:$KS_PASS" --ks-key-alias "$KS_ALIAS" \
  --min-sdk-version $MIN_SDK --out out/woogles-tv.apk "$B/aligned.apk"
"$BT/apksigner" verify out/woogles-tv.apk
rm -f out/woogles-tv.apk.idsig
echo "== built android/out/woogles-tv.apk ($(du -h out/woogles-tv.apk | cut -f1), $VERSION_NAME)"
