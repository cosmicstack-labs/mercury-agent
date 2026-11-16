import Foundation
#if os(iOS)
import AVFoundation
import CallKit
import UIKit
#endif

/// The call as iOS sees it: an outgoing CallKit call to "Mercury", so it shows in the Dynamic
/// Island, on the lock screen and in the green pill, keeps running in the background, follows
/// Bluetooth and CarPlay, and is paused by a real phone call. CallKit activates the audio session
/// (`didActivate`), which is when the call's audio starts. No PushKit: Mercury never rings the phone.
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

  private(set) var uuid: UUID?
  private(set) var active = false
  private var endingHere = false

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
  func start() async throws {
    #if os(iOS)
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
    guard let uuid else { return }
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

  nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    MainActor.assumeIsolated {
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
      onActivate()
    }
  }

  nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    MainActor.assumeIsolated {
      active = false
      onDeactivate()
    }
  }
}
#endif
