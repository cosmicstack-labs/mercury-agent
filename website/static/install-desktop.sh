#!/usr/bin/env sh
# shellcheck shell=sh
#
# Mercury Desktop installer for macOS.
#
#   curl -fsSL https://mercuryagent.sh/install-desktop.sh | sh
#
# Mercury Desktop isn't signed with an Apple Developer ID yet, so an app
# downloaded in a browser is stopped by Gatekeeper ("Apple could not verify
# Mercury…") until you allow it in System Settings. A download made with curl
# isn't marked as coming from the internet, so the app this script installs
# opens on the first try. What it does, in order:
#
#   1. picks the build for this Mac (Apple Silicon or Intel);
#   2. downloads Mercury.app from the GitHub release;
#   3. checks its SHA-256 against the one GitHub recorded for that file,
#      and checks the app's code signature is intact;
#   4. quits a running Mercury Desktop, puts the new app in /Applications
#      (or ~/Applications), keeping the old one until the new one is in place;
#   5. opens it.
#
# Later updates come from inside the app (they're signed with Mercury's
# update key and verified before they install).
#
# Environment variables:
#   MERCURY_VERSION   Version to install (e.g. "1.5.0"). Default: latest.
#   MERCURY_APP_DIR   Where to put Mercury.app. Default: /Applications if
#                     writable, otherwise ~/Applications.
#   MERCURY_NO_OPEN   If set to "1", don't open the app afterwards.
#
# Windows and Linux: download Mercury Desktop from https://mercuryagent.sh/download

set -eu

REPO="cosmicstack-labs/mercury-agent"
APP_NAME="Mercury.app"
BUNDLE_ID="sh.mercuryagent.desktop"

# ----- helpers ---------------------------------------------------------------

c_red()    { printf '\033[31m%s\033[0m'  "$1"; }
c_green()  { printf '\033[32m%s\033[0m'  "$1"; }
c_yellow() { printf '\033[33m%s\033[0m'  "$1"; }
c_bold()   { printf '\033[1m%s\033[0m'   "$1"; }

info()  { printf '%s %s\n' "$(c_green '→')"  "$1"; }
warn()  { printf '%s %s\n' "$(c_yellow '!')" "$1" >&2; }
err()   { printf '%s %s\n' "$(c_red 'x')"    "$1" >&2; }
die()   { err "$1"; printf '  Help: https://mercuryagent.sh/docs/desktop/macos\n' >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ----- this Mac --------------------------------------------------------------

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS. On Windows and Linux, download Mercury Desktop from https://mercuryagent.sh/download"

for tool in curl tar shasum codesign plutil ditto; do
  have "$tool" || die "Missing '$tool', which comes with macOS. Is this a standard macOS install?"
done

# A Terminal running under Rosetta reports x86_64 on an Apple Silicon Mac:
# ask the kernel instead, so it gets the native build.
arch=$(uname -m)
if [ "$arch" = "x86_64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
  arch="arm64"
fi
case "$arch" in
  arm64)  asset="Mercury_aarch64.app.tar.gz"; chip="Apple Silicon" ;;
  x86_64) asset="Mercury_x64.app.tar.gz";     chip="Intel" ;;
  *)      die "Unsupported Mac processor: $arch" ;;
esac

major=$(sw_vers -productVersion | cut -d. -f1)
[ "$major" -ge 11 ] 2>/dev/null || die "Mercury Desktop needs macOS 11 or newer (this is $(sw_vers -productVersion))."

# ----- which release ---------------------------------------------------------

api="https://api.github.com/repos/${REPO}/releases"
if [ -n "${MERCURY_VERSION:-}" ]; then
  version="${MERCURY_VERSION#v}"
  release_url="${api}/tags/v${version}"
else
  release_url="${api}/latest"
fi

tmp=$(mktemp -d "${TMPDIR:-/tmp}/mercury-desktop.XXXXXX")
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT INT TERM

info "Finding the release…"
status=$(curl -sSL --retry 3 -H "Accept: application/vnd.github+json" -w '%{http_code}' -o "$tmp/release.json" "$release_url" 2>/dev/null) || status="000"
case "$status" in
  200) ;;
  404) die "There's no Mercury ${MERCURY_VERSION:+${MERCURY_VERSION} }release on GitHub. See https://mercuryagent.sh/docs/releases" ;;
  403|429) die "GitHub is limiting requests from this network right now. Wait a few minutes and try again." ;;
  *) die "Couldn't reach GitHub (answer: ${status}). Check your connection and try again." ;;
esac

# The release JSON, read with plutil (part of macOS, reads JSON properly).
json() { plutil -extract "$1" raw -o - "$tmp/release.json" 2>/dev/null; }

tag=$(json tag_name) || die "That release wasn't found."
version="${tag#v}"

download_url=""
expected=""
i=0
while name=$(json "assets.$i.name"); do
  if [ "$name" = "$asset" ]; then
    download_url=$(json "assets.$i.browser_download_url") || true
    digest=$(json "assets.$i.digest") || true
    case "$digest" in sha256:*) expected="${digest#sha256:}" ;; esac
    break
  fi
  i=$((i + 1))
done
[ -n "$download_url" ] || die "Mercury ${version} has no Mercury Desktop for ${chip} Macs. See https://mercuryagent.sh/download"
printf '%s' "$expected" | grep -Eq '^[0-9a-f]{64}$' \
  || die "GitHub has no checksum for ${asset}, so it can't be verified. Download it from https://mercuryagent.sh/download instead."

# ----- download and check ----------------------------------------------------

info "Downloading Mercury Desktop ${version} for ${chip} Macs…"
curl -fL --retry 3 --progress-bar "$download_url" -o "$tmp/$asset" \
  || die "The download failed. Try again; if it keeps failing, use https://mercuryagent.sh/download"

actual=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')
[ "$actual" = "$expected" ] || die "The download doesn't match its checksum (got ${actual}, expected ${expected}). Nothing was installed."
info "Checksum verified (SHA-256)"

mkdir -p "$tmp/app"
tar -xzf "$tmp/$asset" -C "$tmp/app" || die "Couldn't unpack the download. Nothing was installed."
new_app="$tmp/app/$APP_NAME"
[ -d "$new_app" ] || die "The download didn't contain ${APP_NAME}. Nothing was installed."

# The app is ad-hoc signed: this proves no file in it changed since the build.
codesign --verify --deep --strict "$new_app" 2>/dev/null \
  || die "The app's code signature is broken. Nothing was installed."
id=$(defaults read "$new_app/Contents/Info.plist" CFBundleIdentifier 2>/dev/null || true)
[ "$id" = "$BUNDLE_ID" ] || die "The download isn't Mercury Desktop (bundle id '${id}'). Nothing was installed."

# ----- install ---------------------------------------------------------------

if [ -n "${MERCURY_APP_DIR:-}" ]; then
  app_dir="$MERCURY_APP_DIR"
elif [ -w /Applications ]; then
  app_dir="/Applications"
else
  app_dir="$HOME/Applications"
fi
mkdir -p "$app_dir" || die "Can't create ${app_dir}."
target="$app_dir/$APP_NAME"

# Quit a running copy so its files can be replaced; Mercury itself (the
# runtime) keeps running, so no chat or bot is interrupted.
if pgrep -f "$target/Contents/MacOS/" >/dev/null 2>&1; then
  info "Quitting Mercury Desktop…"
  osascript -e "tell application id \"${BUNDLE_ID}\" to quit" >/dev/null 2>&1 || true
  i=0
  while pgrep -f "$target/Contents/MacOS/" >/dev/null 2>&1 && [ "$i" -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
  pgrep -f "$target/Contents/MacOS/" >/dev/null 2>&1 && die "Mercury Desktop is still open. Quit it and run this again."
fi

# The old app stays aside until the new one is in place.
backup=""
if [ -e "$target" ]; then
  backup="$tmp/previous-$APP_NAME"
  mv "$target" "$backup" || die "Couldn't move the old ${APP_NAME} aside (is ${app_dir} writable?)."
fi
if ! ditto "$new_app" "$target"; then
  rm -rf "$target"
  [ -n "$backup" ] && mv "$backup" "$target"
  die "Couldn't copy the app into ${app_dir}. The previous version is back in place."
fi

# Belt and braces: nothing in it is marked as downloaded from the internet.
xattr -dr com.apple.quarantine "$target" 2>/dev/null || true

printf '\n%s %s\n' "$(c_green '✓')" "$(c_bold "Mercury Desktop ${version} installed in ${app_dir}")"
printf '  Updates arrive inside the app. To remove it, drag %s to the Trash.\n' "$APP_NAME"
printf '  Guide and fixes: https://mercuryagent.sh/docs/desktop/macos\n\n'

if [ "${MERCURY_NO_OPEN:-}" != "1" ]; then
  open "$target" || warn "Open Mercury from ${app_dir} to start it."
fi
