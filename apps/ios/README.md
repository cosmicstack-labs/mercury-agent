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

The Snapshots renderer can't draw native text fields, plain buttons or spinners
(they show as yellow boxes); on a phone they render normally.

## Screens

1. Connect: sign in to your Mercury, then approve the phone with a 5-character code (ADR-035).
2. Chats · 3. Conversation · 4. Approval · 6. Artifacts · 7. More.
5. Voice call: from Chats (a new call) or a conversation (a call in it). The phone hears one
   thing at a time and stops when you go quiet; Mercury transcribes it (`/api/transcribe`),
   answers in the thread (`/api/chat/send` with `voiceCall`, so the answer is written for the
   ear), and the phone reads it aloud (`/api/speak`), then listens again. Needs a speech
   service on the Mercury (Settings → Voice). The call works while the app is open; it
   doesn't keep going in the background yet.
