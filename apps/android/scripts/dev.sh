#!/usr/bin/env bash
# Mercury for Android: build, test and install, always on the external SSD.
#
#   scripts/dev.sh build            assembleDebug
#   scripts/dev.sh test             JVM unit tests of every module
#   scripts/dev.sh install          build, adb install -r, launch
#   scripts/dev.sh apk              print the debug APK's path
#   scripts/dev.sh <gradle args…>   anything else goes to Gradle as is
#
# The Mac's internal disk is nearly full, so Gradle's home (caches, wrapper, daemons) and every
# build directory live on the SSD. Override with GRADLE_USER_HOME / MERCURY_BUILD_ROOT / JAVA_HOME.
set -euo pipefail

SSD="/Volumes/MacbookPro SSD 0.5TB/dev-android"
export JAVA_HOME="${JAVA_HOME:-/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$SSD/gradle-home}"
BUILD_ROOT="${MERCURY_BUILD_ROOT:-$SSD/build}"
ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$ANDROID_HOME/platform-tools/adb"
APP_ID="sh.mercuryagent.android"
APK="$BUILD_ROOT/app/outputs/apk/debug/app-debug.apk"

if [[ ! -d "$SSD" && -z "${MERCURY_BUILD_ROOT:-}" ]]; then
  echo "The SSD isn't mounted ($SSD). Mount it, or set MERCURY_BUILD_ROOT and GRADLE_USER_HOME." >&2
  exit 1
fi
mkdir -p "$GRADLE_USER_HOME" "$BUILD_ROOT"

# Builds can push macOS into swap, which lives on the internal disk: refuse to start when it's
# nearly full (MERCURY_MIN_FREE_MB, default 1200). The daemon stops after an idle minute.
free_mb=$(df -m /System/Volumes/Data 2>/dev/null | awk 'NR==2 {print $4}')
if [[ -n "${free_mb:-}" && "$free_mb" -lt "${MERCURY_MIN_FREE_MB:-1200}" ]]; then
  echo "Only ${free_mb} MB free on the internal disk: not building (swap could fill it). Free some space first." >&2
  exit 2
fi
export GRADLE_OPTS="${GRADLE_OPTS:-} -Dorg.gradle.daemon.idletimeout=60000"

cd "$(dirname "$0")/.."
gradle() { ./gradlew "-Pmercury.buildRoot=$BUILD_ROOT" --project-cache-dir "$BUILD_ROOT/project-cache" "$@"; }

cmd="${1:-build}"
case "$cmd" in
  build) shift || true; gradle assembleDebug "$@" ;;
  test) shift || true; gradle testDebugUnitTest "$@" ;;
  install)
    shift || true
    gradle assembleDebug "$@"
    "$ADB" install -r "$APK"
    "$ADB" shell am start -n "$APP_ID/sh.mercuryagent.MainActivity"
    ;;
  apk) echo "$APK" ;;
  *) gradle "$@" ;;
esac
