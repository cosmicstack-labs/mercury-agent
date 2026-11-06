# Mercury Current Time

An independent, dependency-free adaptation of the useful clock-awareness concept from the installed Hermes live-time plugin. No Hermes implementation is copied or imported. This package reads the host clock on demand through Mercury's SDK.

## Tool

`live-time__now` accepts `{}` for the host timezone or `{"timezone":"America/Chicago"}` for an explicit supported IANA timezone. Returns a UTC ISO instant, epoch milliseconds, timezone, local wall-clock date/time, weekday, and GMT offset. Invalid or unknown arguments produce `{ok:false,error}`; invalid timezone names are not silently replaced with a different zone.

No network, secrets, file access, subprocesses, timers, or dependencies. Host time is not independently synchronized or verified. ICU/timezone data comes from the runtime. Local wall-clock strings are not unique instants around DST transitions: use `utc` or `epoch_ms` for elapsed-time calculations.

## Deliberate limitation

Mercury's current plugin SDK has no pre-call context hook. Unlike Hermes live-time this does **not** inject time into every model call. The agent must invoke the tool when needed. It does not change system time, system timezone, settings, schedules, or prompts. It does not assume the owner's timezone equals the host timezone.

## Verification and deployment

Run `npx vitest run src/plugins/live-time.test.ts` from the checkout. Tests use fixed instants for DST/offset checks and Mercury's native conformance harness for start/stop/hot-restart. They do not prove deployment into a running session.

This is a source package, not automatically installed or enabled. Installation/activation requires separate approval through Mercury's plugin manager. Requires Mercury >=1.5.1 <2 and plugin API ^1.0.0. In-process JavaScript is trusted code, not an OS sandbox.
