#!/usr/bin/env sh
# shellcheck shell=sh
#
# Mercury DEV-channel installer for macOS and Linux.
#
#   curl -fsSL https://mercuryagent.sh/install-dev.sh | sh
#
# Installs the rolling `mercury-dev-latest` GitHub pre-release as
# `mercury-dev` under $HOME/.mercury-dev — it coexists with a stable install
# (`mercury` under $HOME/.mercury) on the same machine. Re-run to update.
#
# This is a thin wrapper around the stable installer with MERCURY_CHANNEL=dev;
# ALL logic lives in install.sh so the two can never drift.

set -eu

CHANNEL_ENV="MERCURY_CHANNEL=dev"

# Running inside a repo checkout: prefer the sibling stable installer.
# (POSIX sh has no "$0"-safe dirname in every case; guard rather than trust.)
case "$0" in
  */*)
    here=$(CDPATH='' cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)
    ;;
  *)
    here=""
    ;;
esac
if [ -n "$here" ] && [ -f "$here/install.sh" ]; then
  exec env MERCURY_CHANNEL=dev sh "$here/install.sh"
fi

# Otherwise pull the stable installer from the always-current site URL.
# The MERCURY_CHANNEL env var is set in the child shell's environment, so it
# flows through the pipe into install.sh.
if command -v curl >/dev/null 2>&1; then
  curl -fsSL https://mercuryagent.sh/install.sh | env MERCURY_CHANNEL=dev sh
elif command -v wget >/dev/null 2>&1; then
  wget -qO- https://mercuryagent.sh/install.sh | env MERCURY_CHANNEL=dev sh
else
  printf 'x Need curl or wget to fetch the Mercury installer.\n' >&2
  exit 1
fi