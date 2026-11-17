# Mercury for iOS

The native iPhone app for Mercury (SwiftUI). It is a client only: it connects to a
Mercury running on your computer or a server and never runs Mercury on the phone.

- `MercuryKit/Sources/MercuryCore`: the connection, pairing and API client (no UI).
- `MercuryKit/Sources/MercuryUI`: the screens.
- `App/`: the iOS app target. `project.yml` is an XcodeGen spec.

## Build

Needs Xcode 16+ and XcodeGen (`brew install xcodegen`):

    cd apps/ios && xcodegen generate && open Mercury.xcodeproj

Without Xcode you can still compile and test the package for macOS:

    cd apps/ios/MercuryKit
    swift build
    swift test                                        # unit tests
    MERCURY_URL=http://127.0.0.1:6174 swift test      # also against a running Mercury
    swift run Snapshots ./snapshots                   # every screen, light and dark, as PNGs

## Voice engine

Voice calls run on Mercury's shared Rust voice engine, the same code Optimus
runs on the desktop: `crates/mercury-voice` (the OpenAI Realtime and Gemini Live
links) wrapped for Swift and Kotlin by `crates/mercury-voice-mobile` (UniFFI).
The app asks Mercury for a short-lived token (`POST /api/mobile/voice/session`;
API keys never leave the computer), starts a `VoiceCall` with it, pushes
16 kHz mono PCM16 from the microphone and plays what comes back. Tool calls
(`ask_mercury`, `answer_approval`, `end_conversation`) come to the app, which
answers them through Mercury's chat routes and `toolResult(id:output:)`.

Noise and other people nearby, in layers (all phone-only; Optimus's calls are unchanged):

- The engine (`phoneCall`, set by mercury-voice-mobile): OpenAI Realtime gets `near_field` input
  noise reduction, then `semantic_vad` (eagerness `low`, `interrupt_response: false`), each as its
  own `session.update` after the main one so a rejected field never costs the call; a turn spoken
  over a reply the phone didn't cut is answered after it (when its transcript has words). Gemini
  Live gets `START_SENSITIVITY_LOW`, `END_SENSITIVITY_HIGH`, `prefixPaddingMs` 100, `silenceDurationMs` 700.
- The phone: voice processing (echo cancellation, noise suppression, AGC on), other audio ducked
  fully while anyone talks; Voice Isolation suggested once per call on the call screen (only the
  owner can turn it on: it opens Control Center's Mic Mode; "Don't show again" is remembered).
- Barge-in (`BargeInGate`, OpenAI only, since Gemini cuts in server-side): while Mercury is audible,
  a `speechStarted` stops it only if the last ~300 ms on the phone's own mic are 9 dB over the noise
  floor and within 12 dB of the owner's learned level; otherwise it waits 1.5 s for that voice.
  Unsure (first 1.5 s, no audio) means it stops. The owner's audio is never gated.

`apps/ios/MercuryVoice` is a Swift package: `Sources/MercuryVoice/MercuryVoice.swift`
(generated, committed) over `MercuryVoiceFFI.xcframework` (built, not committed).
Build the framework once, and again whenever the Rust crates change:

    rustup target add aarch64-apple-ios aarch64-apple-ios-sim
    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer apps/ios/scripts/build-voice-engine.sh

It builds iPhone, Simulator (Apple silicon) and macOS slices (release, LTO,
size-optimised, stripped), regenerates the Swift file with the uniffi-bindgen
pinned in the crate's Cargo.lock, and packages the xcframework. Commit the
regenerated Swift file with the Rust change. The engine adds about 1.5 MB to the
app binary (about 0.9 MB compressed).

Live check against real providers (tiny paid usage): mint a session with the
route, save the JSON, then

    cd crates/mercury-voice-mobile
    SMOKE_SESSION=session.json SMOKE_PCM=question.s16le cargo test --release smoke -- --ignored --nocapture

Live dictation (the composer's mic) runs on the same engine: `Dictation` streams
the microphone to a speech-to-text service and the words appear in the message
box as they're said (partial text, replaced by final text as it settles). The
app asks `GET /api/mobile/voice/capabilities` which service this Mercury
dictates with and `POST /api/mobile/voice/dictation` for a short-lived token:
an OpenAI Realtime transcription session (`gpt-live-transcribe`), a Gemini Live
session that only listens (`gemini-2.5-flash-native-audio-latest`, an ephemeral
token locked to transcription; the model never answers), a Deepgram temporary
token (Nova-3) or an ElevenLabs single-use Scribe token. It's the same service
Desktop's voice typing uses: the owner's voice choice in Settings → Voice
(Optimus's "Who listens") when it has a key, else OpenAI, Gemini, Deepgram,
ElevenLabs. With no speech key at all (or a Mercury too old to say), the phone
dictates with its own speech recognition (iOS `SFSpeechRecognizer`, on the
device when it can); the mic is never greyed out for want of a key. Live check:

    SMOKE_DICTATION=dictation.json SMOKE_PCM=speech.s16le cargo test --release smoke_live_dictation -- --ignored --nocapture

## On your iPhone, over your Wi-Fi

1. Xcode → Settings → Accounts: add your Apple ID (a personal team works; its installs last 7 days).
2. Pair the phone once: cable, Trust, then Window → Devices and Simulators → "Connect via network".
   Turn on Settings → Privacy & Security → Developer Mode on the phone.
3. Build and install (`<team>` from Accounts, `<udid>` from `xcrun devicectl list devices`):

       xcodebuild -project Mercury.xcodeproj -scheme Mercury -destination 'id=<udid>' \
         -allowProvisioningUpdates DEVELOPMENT_TEAM=<team> -derivedDataPath build build
       xcrun devicectl device install app --device <udid> build/Build/Products/Debug-iphoneos/Mercury.app

4. Mercury listens only on 127.0.0.1, so relay it to the network while you try the app:
   `node apps/ios/scripts/lan-relay.mjs` and connect the app to `http://<this-mac>.local:6175`.
   The phone counts as a remote device: approve it with its code, as any other.

The Snapshots renderer can't draw native text fields, plain buttons or spinners
(they show as yellow boxes); on a phone they render normally.

## Screens

1. Connect: sign in to your Mercury, then approve the phone with a 5-character code (ADR-035).
The app is chat-first, like the Android app and the ChatGPT and Grok apps (no tab bar): the
conversation fills the screen, and the round menu button or a swipe from the leading edge opens the
side panel (`ChatsView.swift`: the connected Mercury, Bots, Artifacts, Saved, one flat list of
chats, and Settings, Search and New chat at the bottom). It is monochrome: Mercury's green only in
the mark and the "working" dot, amber for needs you, red for failed. The chat's bar has Ask | Code
(Code sends coding turns, `programming: "auto"` with `cwd`, Mercury's project folder from GET
/api/workspace/info, as Mercury Desktop's Code view does; the folder's name shows under the pill); the
composer has the model pill (GET /api/chat/models, POST /api/chat/models/switch: Mercury's model for
every chat; Auto is the configured default). A new chat is keyboard-aware (`NewChatSpace`): while
you type the mark and greeting fade out and the chips stay just above the composer, as many as fit.

On iOS 26 and later the chrome floating over the chat is Liquid Glass (`Glass.swift`): the round
buttons, Ask | Code (the chosen side morphs across), the composer card and its buttons, the chips,
jump to latest, and the side panel's buttons and search. The chat scrolls under the bar and the
composer (`safeAreaBar`). Below iOS 26, and in builds with an SDK older than 26 (`swift build` with
the command-line tools), the same shapes are a thin material.

2. Side panel · 3. Conversation · 4. Approval · 6. Artifacts.
7. Settings (the panel's gear): the connection, other Mercurys, and settings: Models, Voice, Channels,
   Notifications, Budgets, Activity, Paired devices. Changes a remote device may only
   make with the owner's go-ahead (428 from the owner gate) show the code to approve,
   wait for it, then go through.
5. Voice call: the composer's round button when the box is empty (a new chat or the one on screen). The phone hears one
   thing at a time and stops when you go quiet; Mercury transcribes it (`/api/transcribe`),
   answers in the thread (`/api/chat/send` with `voiceCall`, so the answer is written for the
   ear), and the phone reads it aloud (`/api/speak`), then listens again. Needs a speech
   service on the Mercury (Settings → Voice). The call works while the app is open; it
   doesn't keep going in the background yet.
