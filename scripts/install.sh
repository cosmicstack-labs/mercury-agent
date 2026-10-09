#!/usr/bin/env sh
# shellcheck shell=sh
#
# Mercury installer for macOS and Linux.
#
#   curl -fsSL https://mercuryagent.sh/install.sh | sh
#
# Environment variables:
#   MERCURY_VERSION   Version to install (e.g. "1.1.9"). Default: latest.
#                     (Stable channel only — dev installs always track the
#                     latest dev build.)
#   MERCURY_CHANNEL   Distribution channel: "stable" (default) or "dev".
#   MERCURY_INSTALL   Install prefix.    Default: $HOME/.mercury
#                     ($HOME/.mercury-dev for the dev channel.)
#                     The binary lands at $MERCURY_INSTALL/bin/mercury.
#                     (mercury-dev on the dev channel.)
#   MERCURY_NO_PATH   If set to "1", skip modifying shell rc files.
#
# Windows users: use install.ps1 instead.

set -eu

REPO="cosmicstack-labs/mercury-agent"
GITHUB_API="https://api.github.com/repos/${REPO}"
GITHUB_DL="https://github.com/${REPO}/releases/download"

# ----- helpers ---------------------------------------------------------------

c_red()    { printf '\033[31m%s\033[0m'  "$1"; }
c_green()  { printf '\033[32m%s\033[0m'  "$1"; }
c_yellow() { printf '\033[33m%s\033[0m'  "$1"; }
c_bold()   { printf '\033[1m%s\033[0m'   "$1"; }

info()  { printf '%s %s\n' "$(c_green '→')"  "$1"; }
warn()  { printf '%s %s\n' "$(c_yellow '!')" "$1" >&2; }
err()   { printf '%s %s\n' "$(c_red 'x')"    "$1" >&2; }
die()   { err "$1"; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ----- channel ---------------------------------------------------------------
#
# Stable is the default distribution channel — it resolves the numbered
# GitHub release current users should install. The dev channel tracks the
# rolling `mercury-dev-latest` PRE-release (feature previews that are NOT
# "latest" on GitHub, so the stable installer and users never see them).
# The two channels install under different prefixes with different binary
# names, so a dev install coexists with a stable one on the same machine.
CHANNEL="${MERCURY_CHANNEL:-stable}"

case "$CHANNEL" in
  stable)
    RELEASE_TAG=""                 # resolved to v<version> at install time
    DEFAULT_PREFIX="$HOME/.mercury"
    BIN_NAME="mercury"
    ;;
  dev)
    RELEASE_TAG="mercury-dev-latest"
    DEFAULT_PREFIX="$HOME/.mercury-dev"
    BIN_NAME="mercury-dev"
    ;;
  *)
    err "Unknown MERCURY_CHANNEL '$CHANNEL' (expected stable or dev)."
    exit 1
    ;;
esac

# Detect OS in Mercury's release naming (macos | linux).
detect_os() {
  uname_s=$(uname -s 2>/dev/null || echo unknown)
  case "$uname_s" in
    Darwin)  echo macos ;;
    Linux)   echo linux ;;
    MINGW*|MSYS*|CYGWIN*)
      die "This installer doesn't support Windows shells. Use install.ps1 in PowerShell instead." ;;
    *) die "Unsupported operating system: $uname_s" ;;
  esac
}

# Detect arch in Mercury's release naming (arm64 | x64). We don't ship 32-bit.
detect_arch() {
  uname_m=$(uname -m 2>/dev/null || echo unknown)
  case "$uname_m" in
    arm64|aarch64) echo arm64 ;;
    x86_64|amd64)  echo x64 ;;
    *) die "Unsupported architecture: $uname_m (Mercury ships arm64 and x64 only)." ;;
  esac
}

# Fetch a URL to a file path.
fetch_to() {
  if have curl; then
    curl -fsSL --output "$2" "$1"
  elif have wget; then
    wget -qO "$2" "$1"
  else
    die "Need curl or wget to download files."
  fi
}

sha256_file() {
  file=$1
  if have shasum; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif have sha256sum; then
    sha256sum "$file" | awk '{print $1}'
  else
    die "Need shasum or sha256sum to verify release downloads."
  fi
}

checksum_for() {
  checksums_file=$1; asset_name=$2
  matches=$(awk -v a="$asset_name" '$2 == a { print $1 }' "$checksums_file")
  count=$(printf '%s\n' "$matches" | awk 'NF { count++ } END { print count + 0 }')
  [ "$count" = "1" ] || die "checksums.txt must contain exactly one checksum for $asset_name"
  printf '%s\n' "$matches"
}

# Resolve "latest" via the GitHub redirect (no API rate limits, no jq needed).
resolve_latest_version() {
  # /releases/latest redirects to /releases/tag/vX.Y.Z — read Location header.
  if have curl; then
    redirect=$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
      "https://github.com/${REPO}/releases/latest")
  else
    # wget --max-redirect=0 prints the Location header on stderr.
    redirect=$(wget --max-redirect=0 -S -O /dev/null \
      "https://github.com/${REPO}/releases/latest" 2>&1 \
      | awk '/Location:/ { print $2 }' | tail -1)
  fi
  # Strip everything up to the last /v and any trailing slash.
  v=$(printf '%s\n' "$redirect" | sed -E 's|.*/v?([0-9][^/]*)/?$|\1|')
  if [ -z "$v" ] || [ "$v" = "$redirect" ]; then
    die "Could not determine the latest Mercury version from $redirect"
  fi
  printf '%s\n' "$v"
}

# Detect which shell rc file to update (best-effort).
shell_rc_file() {
  user_shell=$(basename "${SHELL:-}")
  case "$user_shell" in
    zsh)  echo "$HOME/.zshrc" ;;
    bash)
      # macOS uses .bash_profile by convention for login shells; Linux uses .bashrc.
      if [ "$(uname -s)" = "Darwin" ] && [ -f "$HOME/.bash_profile" ]; then
        echo "$HOME/.bash_profile"
      else
        echo "$HOME/.bashrc"
      fi
      ;;
    fish) echo "$HOME/.config/fish/config.fish" ;;
    *)    echo "$HOME/.profile" ;;
  esac
}

# Append a PATH export to the user's shell rc if it's not already on PATH.
# Idempotent: looks for a sentinel comment before appending.
maybe_update_path() {
  bin_dir=$1
  [ "${MERCURY_NO_PATH:-0}" = "1" ] && return 0
  case ":$PATH:" in *":$bin_dir:"*) return 0 ;; esac

  rc=$(shell_rc_file)
  # Channel-suffixed sentinel: stable and dev installs must not shadow each
  # other's rc entries — a shared marker made the second channel's PATH
  # append a silent no-op ("already present" while never adding its dir).
  marker="# added by mercury installer ($CHANNEL)"
  if [ -f "$rc" ] && grep -Fq "$marker" "$rc" 2>/dev/null; then
    info "PATH entry already present in $(basename "$rc")"
    return 0
  fi

  mkdir -p "$(dirname "$rc")"
  case "$rc" in
    *config.fish)
      printf '\n%s\nset -gx PATH %s $PATH\n' "$marker" "$bin_dir" >> "$rc" ;;
    *)
      printf '\n%s\nexport PATH="%s:$PATH"\n' "$marker" "$bin_dir" >> "$rc" ;;
  esac
  info "Added $bin_dir to PATH in $(basename "$rc")"
  PATH_UPDATED=1
}

# ----- main ------------------------------------------------------------------

main() {
  printf '\n%s\n' "$(c_bold '☿ Mercury installer')"
  printf '   Soul-driven AI agent · https://mercuryagent.sh\n\n'
  if [ "$CHANNEL" = "dev" ]; then
    printf '%s Dev channel — unstable preview builds.\n' "$(c_yellow '!')"
    printf '  Installs as %s (coexists with stable).\n\n' "$DEFAULT_PREFIX/bin/$BIN_NAME"
  fi

  termux_prefix=0
  case "${PREFIX:-}" in *com.termux*) termux_prefix=1 ;; esac
  if [ -n "${TERMUX_VERSION:-}" ] || [ "$termux_prefix" = "1" ]; then
    die "Standalone Linux binaries use glibc and cannot run on Android/Termux.
Install the supported Node.js package instead:
   pkg install nodejs-lts git python build-essential
   npm install -g @cosmicstack/mercury-agent"
  fi

  os=$(detect_os)
  arch=$(detect_arch)
  info "Detected platform: ${os}-${arch}"

  version=${MERCURY_VERSION:-}
  if [ "$CHANNEL" = "dev" ]; then
    release_dir="${GITHUB_DL}/${RELEASE_TAG}"
    version_label="dev (rolling ${RELEASE_TAG})"
  else
    release_dir="${GITHUB_DL}/v${version}"
    if [ -z "$version" ]; then
      info "Resolving latest version from GitHub..."
      version=$(resolve_latest_version)
    fi
    release_dir="${GITHUB_DL}/v${version}"
    version_label="v${version}"
  fi
  info "Installing Mercury ${version_label}"

  asset="mercury-${os}-${arch}"
  url="${release_dir}/${asset}"

  prefix=${MERCURY_INSTALL:-"$DEFAULT_PREFIX"}
  bin_dir="$prefix/bin"
  bin_path="$bin_dir/$BIN_NAME"

  tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/mercury.XXXXXX")
  binary_tmp="$tmp_dir/$asset"
  web_tmp="$tmp_dir/web.tar.gz"
  checksums_tmp="$tmp_dir/checksums.txt"
  stage_dir="$tmp_dir/stage"
  trap 'rm -rf "$tmp_dir"' EXIT INT TERM

  checksum_url="${release_dir}/checksums.txt"
  info "Downloading checksums.txt ..."
  fetch_to "$checksum_url" "$checksums_tmp" || die "Failed to download required checksums from $checksum_url"
  expected_binary=$(checksum_for "$checksums_tmp" "$asset")
  expected_web=$(checksum_for "$checksums_tmp" "web.tar.gz")

  info "Downloading $asset ..."
  if ! fetch_to "$url" "$binary_tmp"; then
    die "Failed to download $url
   The binary for ${version_label} on ${os}-${arch} may not have been published yet.
   Browse releases: https://github.com/${REPO}/releases"
  fi

  web_tar_url="${release_dir}/web.tar.gz"
  info "Downloading web.tar.gz ..."
  fetch_to "$web_tar_url" "$web_tmp" || die "Failed to download required web dashboard assets from $web_tar_url"

  actual_binary=$(sha256_file "$binary_tmp")
  [ "$actual_binary" = "$expected_binary" ] || die "Checksum mismatch for $asset
   expected: $expected_binary
   actual:   $actual_binary"
  actual_web=$(sha256_file "$web_tmp")
  [ "$actual_web" = "$expected_web" ] || die "Checksum mismatch for web.tar.gz
   expected: $expected_web
   actual:   $actual_web"
  info "Checksums verified (sha256)"

  tar -tzf "$web_tmp" > "$tmp_dir/web-files.txt" || die "Failed to inspect web.tar.gz"
  # Safe = the `web/` tree itself. AppleDouble sidecars (`._web` — macOS
  # tar's xattr artifact, invisible to bsdtar but LISTED by GNU tar) are
  # ignored, not rejected: they are inert files the extraction stage
  # discards, and a hard reject bricked every Linux install of tarballs
  # built before the COPYFILE_DISABLE fix (#122). Traversal stays fatal.
  awk '$0 ~ /(^|\/)\.\.(\/|$)/ || ($0 !~ /^web(\/|$)/ && $0 !~ /^\._/) { bad=1 } END { exit bad }' \
    "$tmp_dir/web-files.txt" || die "web.tar.gz contains an unsafe path"
  mkdir -p "$stage_dir"
  tar -xzf "$web_tmp" -C "$stage_dir" || die "Failed to extract web dashboard assets"
  [ -d "$stage_dir/web" ] || die "web.tar.gz does not contain the required web directory"

  mkdir -p "$bin_dir"
  mv "$binary_tmp" "$bin_path"
  chmod +x "$bin_path"
  rm -rf "$bin_dir/web"
  mv "$stage_dir/web" "$bin_dir/web"
  info "Web dashboard assets installed"

  # macOS: strip the quarantine attribute so Gatekeeper doesn't bark on
  # unsigned binaries downloaded via curl.
  if [ "$os" = "macos" ] && have xattr; then
    xattr -d com.apple.quarantine "$bin_path" 2>/dev/null || true
  fi

  info "Installed to $bin_path"

  # Post-install smoke: the binary must at least report its version. A
  # wrong-arch download, a glibc mismatch or a quarantined binary fails
  # here with a readable message instead of at first use.
  if smoke_out=$("$bin_path" --version 2>&1); then
    info "Smoke test passed: $BIN_NAME --version → $smoke_out"
  else
    err "The installed binary failed to run: $bin_path --version"
    printf '%s\n' "$smoke_out" | sed 's/^/    /' >&2
    die "Mercury ${version_label} is installed but not runnable on ${os}-${arch}. Please report this at https://github.com/${REPO}/issues (include the lines above)."
  fi

  rm -rf "$tmp_dir"
  trap - EXIT INT TERM

  PATH_UPDATED=0
  maybe_update_path "$bin_dir"

  printf '\n%s Mercury %s is ready.\n' "$(c_green '✓')" "$version_label"

  if [ "${PATH_UPDATED:-0}" = "1" ]; then
    printf '\n%s Restart your shell or run:\n' "$(c_yellow 'NOTE:')"
    printf '    source %s\n\n' "$(shell_rc_file)"
  fi

  printf 'Get started:\n'
  printf '   %s --help\n' "$bin_path"
  printf '   %s              # first run launches setup wizard\n\n' \
    "$([ "${PATH_UPDATED:-0}" = "1" ] && echo "$BIN_NAME" || echo "$bin_path")"

  if [ "$CHANNEL" = "dev" ]; then
    printf '%s Dev channel — preview builds, may break. Run to check:\n' "$(c_yellow 'NOTE:')"
    printf '    %s version\n' "$bin_path"
    printf 'Re-run this script to update to the latest dev build.\n\n'
  fi
}

main "$@"
