#!/usr/bin/env bash
# Builds Mercury's shared Rust voice engine (crates/mercury-voice-mobile, the
# same links Optimus runs) for Android and refreshes the :voice module:
#
#   voice/src/main/jniLibs/<abi>/libmercury_voice_mobile.so   (built here, gitignored)
#   voice/src/main/java/app/mercury/voice/mercury_voice_mobile.kt   (generated, committed)
#
# ABIs: arm64-v8a (phones) and x86_64 (emulators; skip with ABIS=arm64-v8a).
# The crate is a staticlib for iOS; Android needs a shared library, so it is
# built with `cargo rustc --crate-type cdylib` (no change to the crate).
#
# Needs Rust (rustup) with the Android targets, cargo-ndk and the NDK:
#
#   rustup target add aarch64-linux-android x86_64-linux-android
#   cargo install cargo-ndk
#   apps/android/scripts/build-voice-engine.sh
#
# The Mac's internal disk is nearly full: Cargo's target directory is on the SSD
# (CARGO_TARGET_DIR overrides it).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
android="$(cd "$here/.." && pwd)"
repo="$(cd "$android/../.." && pwd)"
crate="$repo/crates/mercury-voice-mobile"
module="$android/voice/src/main"
lib="libmercury_voice_mobile.so"

[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
export PATH="$HOME/.cargo/bin:$PATH"

SSD="/Volumes/MacbookPro SSD 0.5TB"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$SSD/dev-android/cargo-target/mobile-android}"
if [[ "$CARGO_TARGET_DIR" == "$SSD"/* && ! -d "$SSD" ]]; then
  echo "error: the SSD isn't mounted ($SSD). Mount it, or set CARGO_TARGET_DIR." >&2
  exit 1
fi
mkdir -p "$CARGO_TARGET_DIR"

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$ANDROID_HOME/ndk/27.1.12297006}"
if [[ ! -d "$ANDROID_NDK_HOME" ]]; then
  echo "error: no NDK at $ANDROID_NDK_HOME (install NDK 27.1.12297006 or set ANDROID_NDK_HOME)." >&2
  exit 1
fi
if ! command -v cargo-ndk >/dev/null 2>&1; then
  echo "error: cargo-ndk is missing: cargo install cargo-ndk" >&2
  exit 1
fi
strip_tool="$(ls -d "$ANDROID_NDK_HOME"/toolchains/llvm/prebuilt/*/bin/llvm-strip | head -1)"

read -r -a abis <<<"${ABIS:-arm64-v8a x86_64}"
jobs="${JOBS:-4}"

triple() {
  case "$1" in
    arm64-v8a) echo aarch64-linux-android ;;
    armeabi-v7a) echo armv7-linux-androideabi ;;
    x86_64) echo x86_64-linux-android ;;
    x86) echo i686-linux-android ;;
    *) echo "error: unknown ABI $1" >&2; exit 1 ;;
  esac
}

cd "$crate"
for abi in "${abis[@]}"; do
  t="$(triple "$abi")"
  echo "==> cargo ndk -t $abi rustc --release --crate-type cdylib"
  # minSdk 29, as the app. 16 KB pages (Android 15+) need the max-page-size flag. Symbols are
  # kept here (uniffi-bindgen reads its metadata from them) and stripped from the copy below.
  cargo ndk -t "$abi" --platform 29 rustc --release --locked --lib --crate-type cdylib -j "$jobs" \
    -- -C strip=none -C link-arg=-Wl,-z,max-page-size=16384
  mkdir -p "$module/jniLibs/$abi"
  "$strip_tool" --strip-all -o "$module/jniLibs/$abi/$lib" "$CARGO_TARGET_DIR/$t/release/$lib"
done

# Kotlin bindings from the built (unstripped) library, with the bindgen pinned in Cargo.lock.
first="$(triple "${abis[0]}")"
gen="$CARGO_TARGET_DIR/uniffi-kotlin"
rm -rf "$gen" && mkdir -p "$gen"
echo "==> uniffi-bindgen generate (kotlin)"
cargo run --quiet --release --locked --features cli --bin uniffi-bindgen -j "$jobs" -- \
  generate --library "$CARGO_TARGET_DIR/$first/release/$lib" --language kotlin --no-format --out-dir "$gen"

out="$module/java/app/mercury/voice"
mkdir -p "$out"
cp "$gen/app/mercury/voice/"*.kt "$out/"

echo "==> $module"
for abi in "${abis[@]}"; do
  printf '   %-12s %s\n' "$abi" "$(du -h "$module/jniLibs/$abi/$lib" | cut -f1)"
done
