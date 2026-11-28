# Mercury for Android

The native Android app for Mercury (Kotlin, Jetpack Compose, Material 3). Like the iPhone app
(`apps/ios`), it is a client only: it connects to a Mercury running on your computer or a server
and never runs Mercury on the phone. It mirrors the iOS app's behaviour and API contract, with an
Android look: Material 3, edge-to-edge, a drawer instead of tabs,
predictive back, dynamic colour on Android 12+.

## Layout

One chat at a time with a drawer, as in the ChatGPT and Grok apps (not a bottom-navigation app):

- The app opens straight into a new chat (Settings → Appearance → "Open the last chat" changes that).
- The chat's bar, as in Grok: a round menu button (the drawer), Ask | Code in the middle (Code sends
  each message as a coding turn: `programming: "auto"` on POST /api/chat/send, with `cwd`, Mercury's
  project folder from GET /api/workspace/info, as Mercury Desktop's Code view does; the folder's name
  shows under the pill) with the chat's name under it (tap: Rename, Save, Delete; "Working…" /
  "Needs you"), and a round New chat button.
- A new chat: a large faint mark, one quiet line, and stacked chips above the composer (Make an image,
  Create a video, Make music, and up to two of the runtime's ideas). Keyboard-aware (`NewChatSpace`):
  while the keyboard is up (`WindowInsets.isImeVisible`) the mark and line fade out, and the chips
  stay just above the composer, as many as fit; on a short screen the mark gets smaller. Nothing
  overlaps at any height (`NewChatLayout`, tested).
- The composer is a card: the text ("Ask anything"), then +, the model pill (Auto or the model's
  name; the picker lists GET /api/chat/models and switches with POST /api/chat/models/switch, which
  changes Mercury's model for every chat; Auto is the configured default), the mic, and one round
  button (call when empty, send, stop).
- The left drawer (`ui/chats/ChatDrawer.kt`, Grok's layout): the connected Mercury at the top, its
  logo and friendly name (tap: the switcher, to switch, rename, pick a logo or add one) and » to
  close; Bots, Artifacts, Saved; "Conversations" over the chats with small day labels between them
  (Today, Yesterday, 3 days ago, Previous 30 days, October), all one scrolling `LazyColumn`; each row
  the title alone (a dot only when a chat works, needs you or failed; unread titles
  semibold with a dot); swipe left to delete with Undo, long-press for Rename, Save, Delete; and at
  the bottom Settings, Search (live, titles and messages) and a white New chat button.
- Bots, Artifacts and Settings open as full screens over the chat; back returns to it.
- Monochrome: white or true black, greys, ink for primary actions (Theme: System, Light, Dark). Mercury's
  green appears only in the mark and the small status dots (working green, needs you amber, failed red).

## Modules

- `:core` (Android library, no UI): models (kotlinx.serialization), `MercuryClient` (OkHttp; the
  same routes and headers as iOS's MercuryClient), server-sent events (`SseParser`,
  `MercuryClient.events`), pairing (ADR-035), `ConnectionStore` (several Mercurys; device tokens
  encrypted with an Android Keystore AES-GCM key), `LocalNetwork` (plain http:// only on the local
  network). Feature calls are extension functions next to their models: `Composing.kt` (attachments,
  the Create switch, effort, suggestions), `Artifacts.kt`, `Bots.kt`/`BotsLive.kt`, `Settings.kt`.
  JVM unit tests with MockWebServer.
- `:app` (Compose, single activity): `AppContainer` (simple DI), theme (`ui/theme`), connect
  (`ui/connect`), routes and the drawer scaffold (`ui/MercuryRoot.kt`), the drawer (`ui/chats`), the
  conversation (`ui/conversation`), media loading and the full-screen viewer (`ui/media`), bots
  (`ui/bots`), artifacts (`ui/artifacts`), settings (`ui/more`) and notifications (`notify`).
- `:voice` (Android library): Mercury's shared Rust voice engine. The UniFFI Kotlin bindings
  (`voice/src/main/java/app/mercury/voice/mercury_voice_mobile.kt`, generated, committed) over the
  JNI libraries in `voice/src/main/jniLibs` (built, not committed; see "Voice engine" below), loaded
  with JNA. The app's calls and dictation live in `app/…/call` and `ui/call`.

### The conversation

`ConversationEvents.reduce` (pure, tested) turns `/api/chat/events` into `ConversationState`;
`TurnTrace` is the turn as it happens (thinking, steps, notes, text, media being made). The screen
shows the live timeline and its status line, each reply's folded thought process, security notices
(🛡, ADR-044), the plan card and the needs-you carousel pinned above the composer, generated media
(placeholders that drift and shimmer while made, the batch grid, video and sound tiles, the viewer
with swipe, zoom, thumbnails, share), other files as cards that open in another app
(`MediaLoader`: token-authenticated download into the cache, FileProvider), copy / share / usage
details under replies, long-press Copy / Edit on your messages, day separators and jump to latest.
The composer's + sheet adds photos (Android photo picker) and files (document picker; HEIC and large
photos become JPEG), sets Image / Video / Music for the next message, and the chat's thinking effort.
A new chat shows the greeting and the runtime's suggestions above the composer.

### Notifications

`notify/NotifyDecider` (pure, tested) decides as Mercury Desktop does (`notify.ts`): needs you; done
with the reply's first words when the turn ran past the long-task threshold (the event's `ms`); held
1.5 s so a research report replaces it; failed; a bot's inbox; never the chat on screen. `Notifier`
posts them on three channels (Needs you, Finished, Failed), one per chat, updated in place (the
launcher badge counts them); a tap opens `mercury://chat/<id>` (or `mercury://bot/<id>`).
`ActivityMonitor` holds the app's one `/api/chat/activity` and `/api/bots/events` stream: it runs while
the app is on screen, and in the background only while a chat works or waits on you, or when
Settings → Notifications → Stay connected is on, kept alive by `ConnectionService`, a foreground
service of type `remoteMessaging` whose quiet notification says why. Android 13+'s notification
permission is asked once, after the first message you send (or when Stay connected is turned on).

## Voice engine

Voice calls and live dictation run **on the phone**, on Mercury's shared Rust voice engine, the same
code Optimus runs on the desktop and the iPhone app runs: `crates/mercury-voice` (OpenAI Realtime,
Gemini Live, dictation) wrapped by `crates/mercury-voice-mobile` (UniFFI). Mercury only mints
short-lived tokens (`src/web/api/mobile-voice.ts`): `POST /api/mobile/voice/session` for a call,
`POST /api/mobile/voice/dictation` for dictation, `GET /api/mobile/voice/capabilities` for what this
Mercury can do. API keys never reach the phone.

Build the JNI libraries once, and again whenever the Rust crates change (needs rustup with the
Android targets, `cargo install cargo-ndk`, and NDK 27.1.12297006 under `~/Library/Android/sdk/ndk`):

    rustup target add aarch64-linux-android x86_64-linux-android
    apps/android/scripts/build-voice-engine.sh        # ABIS=arm64-v8a for the phone only

It builds `arm64-v8a` (phones) and `x86_64` (emulators) as shared libraries (the crate is a
staticlib for iOS, so it uses `cargo rustc --crate-type cdylib`; the crate isn't changed), release,
fat LTO, size-optimised, 16 KB pages, stripped; Cargo's target directory is on the SSD
(`/Volumes/MacbookPro SSD 0.5TB/dev-android/cargo-target/mobile-android`). Then it regenerates the
Kotlin bindings with the uniffi-bindgen pinned in the crate's `Cargo.lock` (UniFFI 0.32); commit
them with the Rust change. The engine is about 1.7 MB per ABI (arm64-v8a 1.75 MB; JNA adds 0.16 MB).

**Calls** (`call/VoiceCallModel.kt`, a port of iOS's VoiceCallModel, CallBrain, CallChat,
CallAudioEngine, CallPCM, CallKitCall and CallHaptics). The top bar's phone button, or the round
button when the box is empty, asks for the microphone (once; a refusal says how to allow it in
Settings) and opens the full-screen call: the orb follows both voices (the engine's `levels` and the
phone's own meters), live captions show what you said and what Mercury says, Mute, Speaker, End, a
timer, haptics, and the transcript. Back leaves the call running; the ongoing-call notification
(Hang up) returns to it.

- Audio (`CallAudio`): `AudioRecord` with the voice-communication source, 16 kHz mono PCM16 in 60 ms
  frames to `pushAudio`, the phone's `AcousticEchoCanceler`, `NoiseSuppressor` and (calls only)
  `AutomaticGainControl` when it has them (each logged under `MercuryCall`), the microphone aimed at
  the owner (`MIC_DIRECTION_TOWARDS_USER`, field dimension 0.5) where the phone supports it, in
  `MODE_IN_COMMUNICATION`; Mercury's voice through an `AudioTrack` (voice-communication usage).
  Barge-in as on iOS: the engine's `speechStarted` stops Mercury's voice and the reply, judged by
  `BargeInGate` while Mercury is audible on OpenAI calls (the owner close to the phone, not someone
  nearby; see the iOS README); tapping the orb always does. The engine side (noise reduction, voice
  detection) is shared with iOS.
- Telecom (`CallTelecom`, Jetpack `core-telecom`): an outgoing self-managed call, so Android shows it
  as an ongoing call, a real phone call holds it (Mercury mutes until it's back), and hanging up from
  the system ends it. `CallService` is the call's foreground service (`phoneCall|microphone`, which
  Android 14+ needs to keep the microphone in the background). Without Telecom the app runs the call itself.
- Route (`CallRouter`, decided by the pure `CallRouting`): the loudspeaker by default; the earpiece
  only while the proximity sensor says the phone is at your ear (with `PROXIMITY_SCREEN_OFF_WAKE_LOCK`
  so the screen goes dark there); a Bluetooth or wired headset takes over whenever it's connected;
  Speaker is a manual override that holds for the call (until a headset arrives). Set with
  `AudioManager.setCommunicationDevice` (the speakerphone switch before Android 12) and mirrored to Telecom.
- Tools (`CallBrain`, `ConversationCallChat`): `ask_mercury` goes into the chat with the `voiceCall`
  flag (a new chat is named "Voice call · …"), the spoken part of the reply goes back as the tool
  result, status updates while Mercury works, approvals asked out loud (only the owner's own yes
  counts) or answered on screen, `end_conversation` hangs up after the goodbye; "stop" halts
  everything, "mute" mutes; a minute of quiet or 30 minutes end the call.
- No live voice on this Mercury (409): the call ends with what to add ("Voice calls on the phone
  need an OpenAI key (Settings → Models) or a Gemini key (Settings → Voice)."). iOS's turn-by-turn
  fallback isn't ported.

**Dictation** (`call/Dictation.kt`, a port of DictationModel): the composer's mic streams speech to
text live into the box, partial text replaced by final text, after what you'd typed (your edits
while talking win). It's enabled when `GET /api/mobile/voice/capabilities` says this Mercury can
dictate; otherwise greyed out, and a tap says what to add (the same words as iOS). Tap again to stop;
sending, starting a call, leaving the chat or a minute of quiet stop it.

Tests (JVM): `VoiceTest` (the routes), `PcmTest`, `CallRoutingTest`, `CallBrainTest`, `CallPhaseTest`,
`DictationTextTest`. Live checks against real providers are the crate's smoke tests (see
`apps/ios/README.md`, "Voice engine").

## Build

The Mac's internal disk is nearly full, so **every build runs on the external SSD**:
`scripts/dev.sh` points `GRADLE_USER_HOME` and every module's build directory
(`-Pmercury.buildRoot`) at `/Volumes/MacbookPro SSD 0.5TB/dev-android`, uses JDK 17, and refuses to
start when the internal disk has under about 1.2 GB free (Gradle's memory can push macOS into swap,
which lives on that disk; the daemon is lean and stops after an idle minute).

    cd apps/android
    scripts/dev.sh build      # assembleDebug
    scripts/dev.sh test       # JVM unit tests (core and app)
    scripts/dev.sh install    # build, adb install -r, launch on the attached phone
    scripts/dev.sh apk        # where the debug APK is
    scripts/dev.sh <gradle args>

Needs JDK 17 (`zulu-17`), the Android SDK at `~/Library/Android/sdk` (platform 36,
`local.properties`, which is not committed) and Gradle 8.11.1 (the wrapper).

Versions: AGP 8.10.1, Kotlin 2.2.21, Compose BOM 2025.10.01 (Material 3 1.4), Navigation 2.9.5,
Lifecycle 2.9.4, OkHttp 4.12, kotlinx.serialization 1.9, core-telecom 1.0.0, JNA 5.17. `minSdk` 29, `compileSdk`/`targetSdk` 36.

## Pair a phone

**Scan to connect** (a Mercury with `auth.pairCode` in /api/health's features): run `/server pair`
on the computer (or Mercury Desktop → Settings → Connections → Pair a phone). It shows a QR code,
`mercury://pair?u=<address>&c=<25-character code>`. In the app, **Scan to connect** opens Google's
code scanner (`play-services-code-scanner`: Play services' own camera UI, so no camera permission);
the phone's own camera works too (the app handles `mercury://pair`). Either way the app asks
"Connect to <host>?" first and never pairs from a link on its own; then `POST /api/auth/pair`
`{ code, deviceName, platform: "android" }` returns a device token, kept like any other. Plain
`http://` addresses off the local network are refused before anything is sent. Without Play
services, or with no camera at hand, **Enter a code or token** takes the address and one field
that holds either the pairing code (case, dashes and spaces don't matter; O reads as 0, I and L as
1) or a device token made on the computer with `/server token <name>` (it starts with `mdt_`, and
is checked with GET /api/health before it's kept). Anything else gets an error under the field.
Parsing, the code-or-token check (`ConnectSecret`) and the request: `core/PairLink.kt`, tested in
`PairLinkTest`. There is no password sign-in.

To try it on your Wi-Fi: Mercury listens only on 127.0.0.1, so relay it while you try the app
(`node apps/ios/scripts/lan-relay.mjs`, port 6175) and use `http://<your-mac>.local:6175` (or the
Mac's IP, `http://192.168.1.7:6175`) as the address. The app keeps its device token (`mdt_…`)
encrypted in the Android Keystore.

Last, name it: the computer's name is the first guess (GET /api/health's `host`), and one of twelve
playful Mercury logos (`ui/components/MercuryLogo.kt`, the same shapes as iOS) is picked in turn.
Both are kept per connection and can be changed from the drawer's switcher or Settings.

Plain `http://` works only to local and private addresses (as iOS's `NSAllowsLocalNetworking`);
anything else must be `https://`. More → **Add another Mercury** pairs more; tap one to switch.
