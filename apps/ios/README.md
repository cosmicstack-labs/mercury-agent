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
app asks `GET /api/mobile/voice/capabilities` whether this Mercury can dictate
(the mic is greyed out, with what to add, when it can't) and
`POST /api/mobile/voice/dictation` for a short-lived token: an OpenAI Realtime
transcription session (`gpt-live-transcribe`), a Deepgram temporary token
(Nova-3) or an ElevenLabs single-use Scribe token, whichever the owner has a key
for (their "Who listens" choice in Settings → Voice first). Gemini can't dictate:
Gemini Live only transcribes inside a conversation where it also answers. Live check:

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
2. Chats · 3. Conversation · 4. Approval · 6. Artifacts.
7. More: the connection, other Mercurys, and settings: Models, Voice, Channels,
   Notifications, Budgets, Activity, Paired devices. Changes a remote device may only
   make with the owner's go-ahead (428 from the owner gate) show the code to approve,
   wait for it, then go through.
5. Voice call: from Chats (a new call) or a conversation (a call in it). The phone hears one
   thing at a time and stops when you go quiet; Mercury transcribes it (`/api/transcribe`),
   answers in the thread (`/api/chat/send` with `voiceCall`, so the answer is written for the
   ear), and the phone reads it aloud (`/api/speak`), then listens again. Needs a speech
   service on the Mercury (Settings → Voice). The call works while the app is open; it
   doesn't keep going in the background yet.
