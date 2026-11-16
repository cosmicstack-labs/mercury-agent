#!/usr/bin/env bash
# Builds Mercury's shared Rust voice engine (crates/mercury-voice-mobile, the
# same links Optimus runs) for iOS and packages it as a Swift package:
#
#   apps/ios/MercuryVoice/MercuryVoiceFFI.xcframework   (built here, gitignored)
#   apps/ios/MercuryVoice/Sources/MercuryVoice/MercuryVoice.swift   (generated, committed)
#
# Slices: iPhone (aarch64-apple-ios), Simulator on Apple silicon
# (aarch64-apple-ios-sim) and macOS (aarch64-apple-darwin, so `swift build`
# and `swift test` work on the Mac). Needs Rust (rustup) with those targets
# and Xcode (not just the Command Line Tools):
#
#   rustup target add aarch64-apple-ios aarch64-apple-ios-sim
#   DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer apps/ios/scripts/build-voice-engine.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
crate="$repo/crates/mercury-voice-mobile"
pkg="$repo/apps/ios/MercuryVoice"
lib="libmercury_voice_mobile.a"

[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
if ! xcrun --sdk iphoneos --show-sdk-path >/dev/null 2>&1; then
  echo "error: the iOS SDK isn't available. Point DEVELOPER_DIR at Xcode.app/Contents/Developer." >&2
  exit 1
fi

export IPHONEOS_DEPLOYMENT_TARGET=17.0
export MACOSX_DEPLOYMENT_TARGET=14.0
targets=(aarch64-apple-ios aarch64-apple-ios-sim aarch64-apple-darwin)

cd "$crate"
for t in "${targets[@]}"; do
  echo "==> cargo build --release --target $t"
  cargo build --release --locked --lib --target "$t"
done

# Swift bindings from the built library, with the bindgen pinned in Cargo.lock.
gen="$crate/target/uniffi-swift"
rm -rf "$gen" && mkdir -p "$gen"
echo "==> uniffi-bindgen generate (swift)"
cargo run --quiet --release --locked --features cli --bin uniffi-bindgen -- \
  generate --library "target/aarch64-apple-ios/release/$lib" --language swift --out-dir "$gen"

headers="$crate/target/uniffi-headers"
rm -rf "$headers" && mkdir -p "$headers"
cp "$gen/MercuryVoiceFFI.h" "$headers/"
cp "$gen/MercuryVoiceFFI.modulemap" "$headers/module.modulemap"

# Cargo's `strip = true` doesn't touch static archives: drop their debug and
# local symbols here (the app's linker dead-strips the rest).
args=()
for t in "${targets[@]}"; do
  mkdir -p "$crate/target/$t/release/xcf"
  strip -S -x -o "$crate/target/$t/release/xcf/$lib" "$crate/target/$t/release/$lib"
  args+=(-library "$crate/target/$t/release/xcf/$lib" -headers "$headers")
done

rm -rf "$pkg/MercuryVoiceFFI.xcframework"
xcodebuild -create-xcframework "${args[@]}" -output "$pkg/MercuryVoiceFFI.xcframework" >/dev/null
mkdir -p "$pkg/Sources/MercuryVoice"
cp "$gen/MercuryVoice.swift" "$pkg/Sources/MercuryVoice/MercuryVoice.swift"

echo "==> $pkg"
for t in "${targets[@]}"; do
  printf '   %-22s %s\n' "$t" "$(du -h "$crate/target/$t/release/xcf/$lib" | cut -f1)"
done
