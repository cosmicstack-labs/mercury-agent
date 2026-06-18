#!/usr/bin/env sh
# shellcheck shell=sh
#
# Mercury installer for macOS and Linux.
#
#   curl -fsSL https://mercuryagent.sh/install.sh | sh
#
# Environment variables:
#   MERCURY_VERSION   Version to install (e.g. "1.1.9"). Default: latest.
#   MERCURY_INSTALL   Install prefix.    Default: $HOME/.mercury
#                     The binary lands at $MERCURY_INSTALL/bin/mercury.
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

# Fetch a URL to stdout. Prefers curl, falls back to wget.
fetch() {
  url=$1
  if have curl; then
    curl -fsSL "$url"
  elif have wget; then
    wget -qO- "$url"
  else
    die "Need curl or wget to download files."
  fi
}

# Fetch a URL to a file path.
fetch_to() {
  url=$1; out=$2
  if have curl; then
    curl -fsSL --output "$out" "$url"
  elif have wget; then
    wget -qO "$out" "$url"
  else
    die "Need curl or wget to download files."
  fi
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
  marker='# added by mercury installer'
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

  os=$(detect_os)
  arch=$(detect_arch)
  info "Detected platform: ${os}-${arch}"

  version=${MERCURY_VERSION:-}
  if [ -z "$version" ]; then
    info "Resolving latest version from GitHub..."
    version=$(resolve_latest_version)
  fi
  info "Installing Mercury v${version}"

  asset="mercury-${os}-${arch}"
  url="${GITHUB_DL}/v${version}/${asset}"

  prefix=${MERCURY_INSTALL:-"$HOME/.mercury"}
  bin_dir="$prefix/bin"
  bin_path="$bin_dir/mercury"

  mkdir -p "$bin_dir"
  tmp=$(mktemp -t mercury.XXXXXX)
  # Clean tempfile on any exit path.
  trap 'rm -f "$tmp"' EXIT INT TERM

  info "Downloading $asset ..."
  if ! fetch_to "$url" "$tmp"; then
    die "Failed to download $url
   The binary for v${version} on ${os}-${arch} may not have been published yet.
   Browse releases: https://github.com/${REPO}/releases"
  fi

  # Optional checksum verification.
  checksum_url="${GITHUB_DL}/v${version}/checksums.txt"
  if checksums=$(fetch "$checksum_url" 2>/dev/null); then
    expected=$(printf '%s\n' "$checksums" | awk -v a="$asset" '$2 == a { print $1 }')
    if [ -n "$expected" ]; then
      if have shasum; then
        actual=$(shasum -a 256 "$tmp" | awk '{print $1}')
      elif have sha256sum; then
        actual=$(sha256sum "$tmp" | awk '{print $1}')
      else
        actual=""
      fi
      if [ -n "$actual" ]; then
        if [ "$actual" = "$expected" ]; then
          info "Checksum verified (sha256)"
        else
          die "Checksum mismatch for $asset
   expected: $expected
   actual:   $actual"
        fi
      fi
    fi
  fi

  mv "$tmp" "$bin_path"
  trap - EXIT INT TERM
  chmod +x "$bin_path"

  # Download web dashboard assets (required for the web UI).
  web_tar_url="${GITHUB_DL}/v${version}/web.tar.gz"
  web_tmp=$(mktemp -t mercury-web.XXXXXX.tar.gz)
  if fetch_to "$web_tar_url" "$web_tmp" 2>/dev/null; then
    mkdir -p "$bin_dir/web"
    if tar -xzf "$web_tmp" -C "$bin_dir" 2>/dev/null; then
      info "Web dashboard assets installed"
    else
      warn "Failed to extract web dashboard assets"
    fi
  else
    warn "Web dashboard assets not found for v${version} — web UI will not work"
  fi
  rm -f "$web_tmp"

  # macOS: strip the quarantine attribute so Gatekeeper doesn't bark on
  # unsigned binaries downloaded via curl.
  if [ "$os" = "macos" ] && have xattr; then
    xattr -d com.apple.quarantine "$bin_path" 2>/dev/null || true
  fi

  info "Installed to $bin_path"

  PATH_UPDATED=0
  maybe_update_path "$bin_dir"

  printf '\n%s Mercury v%s is ready.\n' "$(c_green '✓')" "$version"

  if [ "${PATH_UPDATED:-0}" = "1" ]; then
    printf '\n%s Restart your shell or run:\n' "$(c_yellow 'NOTE:')"
    printf '    source %s\n\n' "$(shell_rc_file)"
  fi

  printf 'Get started:\n'
  printf '   %s --help\n' "$bin_path"
  printf '   %s              # first run launches setup wizard\n\n' \
    "$([ "${PATH_UPDATED:-0}" = "1" ] && echo mercury || echo "$bin_path")"
}

main "$@"
