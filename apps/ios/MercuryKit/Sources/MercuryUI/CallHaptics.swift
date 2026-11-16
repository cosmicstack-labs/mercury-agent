import Foundation
import os
#if canImport(UIKit)
import UIKit
#endif

/// The moments on a call the phone marks with a tap.
enum CallHaptic: Equatable {
  case connected
  case mercurySpeaks
  case bargeIn
  case approvalAsked
  case approvalAnswered(approved: Bool)
  case muteToggled
  case ended
  case failed
  /// Dictation in the message box started or stopped listening.
  case dictationStarted
  case dictationStopped

  /// What each one feels like.
  enum Feel: Equatable { case success, warning, error, soft, light, medium, selection }

  var feel: Feel {
    switch self {
    case .connected: .success
    case .mercurySpeaks: .soft
    case .bargeIn: .light
    case .approvalAsked: .warning
    case .approvalAnswered(let yes): yes ? .success : .error
    case .muteToggled: .selection
    case .ended: .medium
    case .failed: .error
    case .dictationStarted: .light
    case .dictationStopped: .soft
    }
  }
}

/// Plays call haptics from generators prepared when the call starts, so the first tap isn't late.
@MainActor
final class CallHaptics {
  #if os(iOS)
  private let notify = UINotificationFeedbackGenerator()
  private let soft = UIImpactFeedbackGenerator(style: .soft)
  private let light = UIImpactFeedbackGenerator(style: .light)
  private let medium = UIImpactFeedbackGenerator(style: .medium)
  private let select = UISelectionFeedbackGenerator()
  #endif
  /// Every haptic played, for tests.
  private(set) var played: [CallHaptic] = []

  func prepare() {
    #if os(iOS)
    notify.prepare(); soft.prepare(); light.prepare(); medium.prepare(); select.prepare()
    #endif
  }

  func play(_ h: CallHaptic) {
    played.append(h)
    #if os(iOS)
    switch h.feel {
    case .success: notify.notificationOccurred(.success)
    case .warning: notify.notificationOccurred(.warning)
    case .error: notify.notificationOccurred(.error)
    case .soft: soft.impactOccurred(intensity: 0.7)
    case .light: light.impactOccurred()
    case .medium: medium.impactOccurred()
    case .selection: select.selectionChanged()
    }
    // Ready again for the next one.
    switch h.feel {
    case .success, .warning, .error: notify.prepare()
    case .soft: soft.prepare()
    case .light: light.prepare()
    case .medium: medium.prepare()
    case .selection: select.prepare()
    }
    #endif
  }
}

/// How long each step of starting a call took, from the tap. Logged (subsystem sh.mercuryagent.ios,
/// category call) so a slow start shows where the time went.
@MainActor
final class CallTimeline {
  enum Step: String, CaseIterable {
    case tap, screen, mic, callKit = "callkit", token, audioSession = "audio-session", audioRunning = "audio-running", connected, firstAudio = "first-audio"
  }

  static let log = Logger(subsystem: "sh.mercuryagent.ios", category: "call")
  let start: Date
  private(set) var marks: [Step: TimeInterval] = [:]

  init(start: Date = .now) {
    self.start = start
    marks[.tap] = 0
  }

  /// Records a step once (the first time it happens) and logs it.
  func mark(_ step: Step, at now: Date = .now) {
    guard marks[step] == nil else { return }
    let ms = now.timeIntervalSince(start)
    marks[step] = ms
    Self.log.info("call start: \(step.rawValue, privacy: .public) +\(Int(ms * 1000))ms")
    if step == .firstAudio { Self.log.notice("call start timeline: \(self.summary, privacy: .public)") }
  }

  /// "screen +40ms · mic +41ms · …" in the order things happened.
  var summary: String {
    marks.filter { $0.key != .tap }.sorted { $0.value < $1.value }.map { "\($0.key.rawValue) +\(Int($0.value * 1000))ms" }.joined(separator: " · ")
  }
}
