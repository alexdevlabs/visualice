#!/usr/bin/env bash
# Build fixture.apk, the WebView app the Android integration test crawls, without
# Gradle: javac, d8, aapt2, zipalign and apksigner from the Android SDK's build tools.
# Needs ANDROID_HOME (or ANDROID_SDK_ROOT) with platforms;android-34 and
# build-tools;34.0.0 installed, and a JDK 17.
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:?set ANDROID_HOME to the Android SDK}}"
BT="$SDK/build-tools/34.0.0"
JAR="$SDK/platforms/android-34/android.jar"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

mkdir -p "$OUT/classes" "$OUT/assets"
cp index.html "$OUT/assets/index.html"
javac -source 1.8 -target 1.8 -nowarn -classpath "$JAR" -d "$OUT/classes" \
  src/com/visualice/fixture/MainActivity.java 2>&1 | grep -v "^warning" || true
"$BT/d8" --lib "$JAR" --output "$OUT" $(find "$OUT/classes" -name '*.class')
"$BT/aapt2" link -o "$OUT/base.apk" -I "$JAR" --manifest AndroidManifest.xml -A "$OUT/assets" \
  --min-sdk-version 24 --target-sdk-version 34 --debug-mode
(cd "$OUT" && zip -q -j base.apk classes.dex)
"$BT/zipalign" -f 4 "$OUT/base.apk" "$OUT/aligned.apk"
# A throwaway key: the APK only has to be signed, not by anyone in particular.
keytool -genkeypair -keystore "$OUT/debug.keystore" -storepass android -keypass android \
  -alias debug -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=visualice fixture" >/dev/null 2>&1
"$BT/apksigner" sign --ks "$OUT/debug.keystore" --ks-pass pass:android --v4-signing-enabled false \
  --out fixture.apk "$OUT/aligned.apk"
echo "built $(pwd)/fixture.apk"
