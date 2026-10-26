#!/bin/sh
# Optimus launcher for Linux (installed as bin/mercury-optimus).
#
# The companion links ALSA and libxcb. Desktops have both; servers and minimal
# installs often don't. Start it with the system's own libraries, and when the
# loader reports one missing, add the copy shipped in ../lib/<name>/ for that
# library only, then try again. System libraries always win when present.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bin="$here/mercury-optimus-bin"
libs="$here/../lib"

extra=""
tries=0
while [ "$tries" -lt 12 ]; do
  path="$extra"
  [ -n "${LD_LIBRARY_PATH:-}" ] && path="${path:+$path:}$LD_LIBRARY_PATH"
  err=$(LD_LIBRARY_PATH="$path" "$bin" --probe 2>&1 >/dev/null) && break
  lib=$(printf '%s\n' "$err" | sed -n 's/.*error while loading shared libraries: \([^:]*\):.*/\1/p' | head -n 1)
  # Not a missing library, or one we don't ship: start anyway so Mercury sees the real error.
  { [ -n "$lib" ] && [ -d "$libs/$lib" ]; } || break
  case ":$extra:" in *":$libs/$lib:"*) break ;; esac
  extra="${extra:+$extra:}$libs/$lib"
  tries=$((tries + 1))
done

if [ -n "$extra" ]; then
  # The companion puts the owner's value back before it opens any app.
  export OPTIMUS_SYSTEM_LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}"
  [ -n "${LD_LIBRARY_PATH+x}" ] && export OPTIMUS_LD_LIBRARY_PATH_SET=1
  LD_LIBRARY_PATH="$extra${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export LD_LIBRARY_PATH
fi
exec "$bin" "$@"
