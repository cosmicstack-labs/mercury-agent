import Foundation
#if os(iOS)
import AVFoundation
import CallKit
import UIKit
#endif

/// The call as iOS sees it: an outgoing CallKit call to "Mercury", so it shows in the Dynamic
/// Island, on the lock screen and in the green pill, keeps running in the background, follows
/// Bluetooth and CarPlay, and is paused by a real phone call. CallKit activates the audio session
/// (`didActivate`), which is when the call's audio starts.
///
/// Mercury can also ring this phone (ADR-046): a `ring` on the live activity stream becomes an
/// incoming CallKit call (`reportIncoming`). Answering it makes it the call: the voice call then
/// adopts it in `start()` instead of placing an outgoing one. No PushKit: Mercury rings only while
/// the app is running (open, or still alive in the background).
/// Off iOS (the Mac build, tests) every call says it isn't available and the app manages audio itself.
@MainActor
final class CallKitCall: NSObject {
  /// One provider for the app, as CallKit wants; each call sets the callbacks it needs.
  static let shared = CallKitCall()

  /// The audio session is live: start the microphone and the player.
  var onActivate: () -> Void = {}
  var onDeactivate: () -> Void = {}
  /// Hung up from outside the app (the lock screen, the Dynamic Island, a headset button).
  var onEndedOutside: () -> Void = {}
  var onMute: (Bool) -> Void = { _ in }
  /// Another call put this one on hold (true) or let it go (false).
  var onHold: (Bool) -> Void = { _ in }
  /// An incoming ring was answered or declined on the system's call screen (PhoneRinger listens).
  var onIncomingAnswer: (UUID) -> Void = { _ in }
  var onIncomingDecline: (UUID) -> Void = { _ in }

  private(set) var uuid: UUID?
  private(set) var active = false
  private var endingHere = false
  /// An incoming ring still ringing.
  private(set) var ringingIncoming: UUID?
  /// The answered incoming call, waiting for the voice call to adopt it.
  private var answeredIncoming: UUID?
  /// The current call came in (no "outgoing connected" reports for it).
  private var incoming = false

  #if os(iOS)
  private let provider: CXProvider
  private let controller = CXCallController()

  override init() {
    let config = CXProviderConfiguration()
    config.supportsVideo = false
    config.maximumCallGroups = 1
    config.maximumCallsPerCallGroup = 1
    config.supportedHandleTypes = [.generic]
    config.includesCallsInRecents = false
    if let mark = UIImage(systemName: "waveform", withConfiguration: UIImage.SymbolConfiguration(pointSize: 40, weight: .semibold)) {
      config.iconTemplateImageData = mark.pngData()
    }
    provider = CXProvider(configuration: config)
    super.init()
    provider.setDelegate(self, queue: nil)
  }
  #endif

  /// Starts the outgoing call. Throws when CallKit won't (then the app runs the call itself).
  /// After an incoming ring was answered, adopts that call instead.
  func start() async throws {
    #if os(iOS)
    if let answered = answeredIncoming {
      answeredIncoming = nil
      uuid = answered
      incoming = true
      endingHere = false
      // CallKit may have activated the audio already, before the call's callbacks were set.
      if active { onActivate() }
      return
    }
    incoming = false
    let id = UUID()
    uuid = id
    endingHere = false
    let action = CXStartCallAction(call: id, handle: CXHandle(type: .generic, value: "Mercury"))
    action.isVideo = false
    action.contactIdentifier = nil
    do {
      try await controller.request(CXTransaction(action: action))
    } catch {
      uuid = nil
      throw error
    }
    let update = CXCallUpdate()
    update.localizedCallerName = "Mercury"
    update.remoteHandle = CXHandle(type: .generic, value: "Mercury")
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false
    update.hasVideo = false
    provider.reportCall(with: id, updated: update)
    #else
    throw CallKitUnavailable()
    #endif
  }

  /// The voice answered: the timer on the lock screen starts now.
  func connected() {
    #if os(iOS)
    guard let uuid, !incoming else { return }
    provider.reportOutgoingCall(with: uuid, connectedAt: .now)
    #endif
  }

  /// Mute from the app's own button, so the system's call UI agrees.
  func setMuted(_ on: Bool) {
    #if os(iOS)
    guard let uuid else { return }
    controller.request(CXTransaction(action: CXSetMutedCallAction(call: uuid, muted: on))) { _ in }
    #endif
  }

  /// Hang up from the app.
  func end() {
    #if os(iOS)
    guard let uuid else { return }
    endingHere = true
    controller.request(CXTransaction(action: CXEndCallAction(call: uuid))) { [weak self] error in
      // The end transaction can't fail usefully; tell CallKit directly if it does.
      if error != nil { Task { @MainActor in self?.reportEnded(failed: false) } }
    }
    #endif
  }

  /// The call ended on its own (the voice dropped, silence): tell CallKit why.
  func reportEnded(failed: Bool) {
    #if os(iOS)
    guard let uuid else { return }
    provider.reportCall(with: uuid, endedAt: .now, reason: failed ? .failed : .remoteEnded)
    self.uuid = nil
    active = false
    #endif
  }
}

// MARK: Mercury rings this phone (ADR-046)

/// How a ring stopped without being answered here.
enum IncomingEnd: Equatable { case answeredElsewhere, unanswered, declinedElsewhere, failed }

/// What PhoneRinger needs from the system's call screen (CallKit; a fake in tests).
@MainActor
protocol IncomingCallPresenter: AnyObject {
  /// Shows the incoming call. Throws when iOS won't (Focus/Do Not Disturb, another call…).
  func reportIncoming(_ uuid: UUID, caller: String) async throws
  func endIncoming(_ uuid: UUID, _ how: IncomingEnd)
  var onIncomingAnswer: (UUID) -> Void { get set }
  var onIncomingDecline: (UUID) -> Void { get set }
  /// A call is already on (Mercury's own): a new ring isn't shown.
  var inCall: Bool { get }
}

extension CallKitCall: IncomingCallPresenter {
  var inCall: Bool { uuid != nil || answeredIncoming != nil }

  func reportIncoming(_ id: UUID, caller: String) async throws {
    #if os(iOS)
    let update = CXCallUpdate()
    update.localizedCallerName = caller
    update.remoteHandle = CXHandle(type: .generic, value: caller)
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false
    update.hasVideo = false
    ringingIncoming = id
    do {
      try await provider.reportNewIncomingCall(with: id, update: update)
    } catch {
      ringingIncoming = nil
      throw error
    }
    #else
    throw CallKitUnavailable()
    #endif
  }

  func endIncoming(_ id: UUID, _ how: IncomingEnd) {
    #if os(iOS)
    guard ringingIncoming == id else { return }
    ringingIncoming = nil
    let reason: CXCallEndedReason = switch how {
    case .answeredElsewhere: .answeredElsewhere
    case .declinedElsewhere: .declinedElsewhere
    case .unanswered: .unanswered
    case .failed: .failed
    }
    provider.reportCall(with: id, endedAt: .now, reason: reason)
    #endif
  }
}

struct CallKitUnavailable: LocalizedError {
  var errorDescription: String? { "CallKit isn't available here." }
}

#if os(iOS)
extension CallKitCall: CXProviderDelegate {
  nonisolated func providerDidReset(_ provider: CXProvider) {
    MainActor.assumeIsolated {
      let had = uuid != nil
      uuid = nil
      active = false
      if had { onEndedOutside() }
    }
  }

  nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    MainActor.assumeIsolated {
      // Ready for CallKit to activate it (activating is CallKit's job, not the app's).
      try? CallAudioEngine.configureSession()
      provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: .now)
      action.fulfill()
    }
  }

  nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    MainActor.assumeIsolated {
      guard ringingIncoming == action.callUUID else { action.fail(); return }
      ringingIncoming = nil
      answeredIncoming = action.callUUID
      // Ready for CallKit to activate the audio, as for an outgoing call.
      try? CallAudioEngine.configureSession()
      action.fulfill()
      onIncomingAnswer(action.callUUID)
    }
  }

  nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    MainActor.assumeIsolated {
      // Declining a ring (or hanging up an answered one before the voice call took it).
      if ringingIncoming == action.callUUID || answeredIncoming == action.callUUID {
        let wasRinging = ringingIncoming == action.callUUID
        ringingIncoming = nil
        answeredIncoming = nil
        action.fulfill()
        if wasRinging { onIncomingDecline(action.callUUID) }
        return
      }
      let outside = !endingHere
      uuid = nil
      active = false
      action.fulfill()
      if outside { onEndedOutside() }
    }
  }

  nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    MainActor.assumeIsolated {
      onMute(action.isMuted)
      action.fulfill()
    }
  }

  nonisolated func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
    MainActor.assumeIsolated {
      onHold(action.isOnHold)
      action.fulfill()
    }
  }

  nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    MainActor.assumeIsolated {
      active = true
      CallLog.note("callkit activated \(CallLog.routeLine())")
      onActivate()
    }
  }

  nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    MainActor.assumeIsolated {
      active = false
      CallLog.note("callkit deactivated")
      onDeactivate()
    }
  }
}
#endif
