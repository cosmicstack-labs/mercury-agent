import SwiftUI
import AVFoundation

/// Voice Isolation, the iPhone's Mic Mode that keeps the owner's voice and drops the people and
/// noise around them. Only the owner can turn it on (Control Center's Mic Mode, which
/// `AVCaptureDevice.showSystemUserInterface(.microphoneModes)` opens); it applies to apps using
/// voice processing (the call's CallAudioEngine). The call screen suggests it once per call,
/// quietly, and remembers "Don't show again"; when it's on, it says so with a check.
enum VoiceIsolation {
  enum Hint: Equatable {
    case hidden
    /// "Hear only you: turn on Voice Isolation".
    case suggest
    /// It's on.
    case on
  }

  static let neverKey = "call.voiceIsolation.neverSuggest"

  /// What to show. `active`: the mode the call's audio uses now; `preferred`: the owner's choice.
  /// No nagging: once dismissed this call, never again when asked, and not when the owner already
  /// chose Voice Isolation (a route like a Bluetooth headset may not support it).
  static func hint(live: Bool, active: AVCaptureDevice.MicrophoneMode?, preferred: AVCaptureDevice.MicrophoneMode?, dismissed: Bool, never: Bool) -> Hint {
    guard live, let active else { return .hidden }
    if active == .voiceIsolation { return .on }
    if dismissed || never || preferred == .voiceIsolation { return .hidden }
    return .suggest
  }

  /// The modes now, or nil where mic modes don't exist.
  static func modes() -> (active: AVCaptureDevice.MicrophoneMode, preferred: AVCaptureDevice.MicrophoneMode)? {
    #if os(iOS)
    return (AVCaptureDevice.activeMicrophoneMode, AVCaptureDevice.preferredMicrophoneMode)
    #else
    return nil
    #endif
  }

  /// Opens the system's Mic Mode picker.
  static func showPicker() {
    #if os(iOS)
    AVCaptureDevice.showSystemUserInterface(.microphoneModes)
    #endif
  }
}

/// The small Voice Isolation line on the call screen.
struct VoiceIsolationHint: View {
  /// The call is live (voice processing running).
  var live: Bool
  var defaults: UserDefaults = .standard
  @State private var active: AVCaptureDevice.MicrophoneMode?
  @State private var preferred: AVCaptureDevice.MicrophoneMode?
  @State private var dismissed = false
  @State private var never = false

  var body: some View {
    let hint = VoiceIsolation.hint(live: live, active: active, preferred: preferred, dismissed: dismissed, never: never)
    Group {
      switch hint {
      case .hidden: EmptyView()
      case .on:
        Label("Voice Isolation", systemImage: "checkmark.circle.fill")
          .font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink3)
          .accessibilityLabel("Voice Isolation is on")
      case .suggest:
        HStack(spacing: 6) {
          Button { VoiceIsolation.showPicker() } label: {
            Label("Hear only you: turn on Voice Isolation", systemImage: "person.wave.2")
              .font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink2)
              .lineLimit(1).minimumScaleFactor(0.85)
          }
          .accessibilityHint("Opens Mic Mode")
          Menu {
            Button("Not now") { dismissed = true }
            Button("Don't show again") { defaults.set(true, forKey: VoiceIsolation.neverKey); never = true }
          } label: {
            Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.ink3)
              .frame(width: 24, height: 24).contentShape(Rectangle())
          }
          .accessibilityLabel("Dismiss")
        }
        .padding(.leading, 12).padding(.trailing, 4).padding(.vertical, 3)
        .background(Theme.ink.opacity(0.06), in: Capsule())
      }
    }
    .buttonStyle(.plain)
    .animation(.easeOut(duration: 0.2), value: hint)
    .task(id: live) {
      never = defaults.bool(forKey: VoiceIsolation.neverKey)
      // The owner changes it in Control Center: follow it while the call is on screen.
      while !Task.isCancelled && live {
        if let m = VoiceIsolation.modes() { active = m.active; preferred = m.preferred }
        try? await Task.sleep(for: .seconds(1))
      }
    }
  }
}
