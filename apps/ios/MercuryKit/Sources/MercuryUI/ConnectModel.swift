import SwiftUI
import MercuryCore

/// The connect flow: scan the pairing QR code the computer shows, or type its address with a
/// pairing code or a device token. There is no password sign-in. Last, once it's connected, a
/// friendly name (the computer's name as a first guess) and a logo, as Mercury Desktop names a
/// remote when it's added; the Mercury is saved when that step is done.
@MainActor @Observable
final class ConnectModel {
  enum Step: Equatable { case welcome, scan, enter, name }

  /// Connected, not saved yet: what the name step saves.
  struct Pending: Equatable { var url: URL; var token: String; var deviceId: String? }

  var step: Step = .welcome
  var address = ""
  /// "Enter a code or token": a pairing code (any grouping) or a device token (mdt_…).
  var secret = ""
  /// A scanned or opened pairing link, waiting for the person to say yes: never paired silently.
  var confirm: PairLink?
  var busy = false
  var error: String?
  var pending: Pending?
  var name = ""
  var logo = ConnectionLogos.ids[0]
  /// The name as first guessed, until the person types their own.
  var suggestedName = ""
  let store: ConnectionStore

  init(store: ConnectionStore) { self.store = store }

  var deviceName: String {
    #if canImport(UIKit)
    "\(UIDevice.current.name) · Mercury for iOS"
    #else
    "Mercury for iOS"
    #endif
  }

  /// Another screen of the flow, without the last screen's error.
  func go(_ s: Step) { error = nil; step = s }

  var canConnectTyped: Bool {
    !address.trimmingCharacters(in: .whitespaces).isEmpty && !secret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !busy
  }

  /// What the camera read. A pairing link is asked about first; anything else is the problem to
  /// show under the viewfinder (the camera keeps looking).
  func scanned(_ text: String) -> String? {
    do {
      error = nil
      confirm = try PairLink.parse(text)
      return nil
    } catch {
      return error.localizedDescription
    }
  }

  /// A `mercury://pair?…` link opened from outside the app (the iPhone's Camera, a message): asked
  /// about first. One that can't be used opens "Enter a code or token" with what it held and why.
  func open(_ url: URL) {
    guard PairLink.isPairLink(url), pending == nil else { return }
    do {
      error = nil
      confirm = try PairLink.parse(url)
    } catch {
      let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
      if let u = items.first(where: { $0.name == "u" })?.value { address = u }
      if let c = items.first(where: { $0.name == "c" })?.value { secret = PairCode.display(PairCode.normalize(c)) }
      self.error = error.localizedDescription
      step = .enter
    }
  }

  /// "Enter a code or token": a token (mdt_…) is checked with the Mercury and kept; anything
  /// else must be a whole pairing code, traded for a token (POST /api/auth/pair).
  func connectTyped() async {
    do {
      let url = try PairLink.checkedAddress(address)
      switch try ConnectSecret.read(secret) {
      case .pairCode(let code): await pair(PairLink(address: url, code: code))
      case .token(let token): await useToken(token, at: url)
      }
    } catch {
      self.error = error.localizedDescription
    }
  }

  /// Connect with a device token made on the computer (`/server token <name>`), checked first.
  func useToken(_ token: String, at url: URL) async {
    busy = true; error = nil
    defer { busy = false }
    do {
      _ = try await MercuryClient(baseURL: url, token: token).checkToken()
      finish(url: url, token: token, device: nil)
    } catch {
      self.error = error.localizedDescription
    }
  }

  /// Trades a pairing code for a device token, then the name step.
  func pair(_ link: PairLink) async {
    busy = true; error = nil
    defer { busy = false }
    do {
      let (token, device) = try await MercuryClient(baseURL: link.address).pair(code: link.code, deviceName: deviceName)
      confirm = nil
      finish(url: link.address, token: token, device: device)
    } catch {
      self.error = error.localizedDescription
    }
  }

  /// Connected: on to the name step, with the address as a first guess, then the computer's own
  /// name when it says (GET /api/health's `host`) unless the person has started typing.
  func finish(url: URL, token: String, device: Device?) {
    // mdt_<8 hex device id>_<64 hex>: the device id is the middle part.
    let parts = token.split(separator: "_")
    let deviceId = device?.id ?? (parts.count == 3 && parts[0] == "mdt" ? String(parts[1]) : nil)
    pending = Pending(url: url, token: token, deviceId: deviceId)
    suggestedName = ConnectionLogos.suggestedName(host: nil, url: url)
    name = suggestedName
    logo = store.nextLogo
    step = .name
    Task {
      guard let host = try? await MercuryClient(baseURL: url, token: token).health().host else { return }
      suggest(host: host, url: url)
    }
  }

  func suggest(host: String?, url: URL) {
    let better = ConnectionLogos.suggestedName(host: host, url: url)
    if name == suggestedName { name = better }
    suggestedName = better
  }

  /// Saves the Mercury with its name (the guess when left blank) and logo, and makes it active.
  func save() {
    guard let p = pending else { return }
    let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
    store.add(Connection(name: String((n.isEmpty ? suggestedName : n).prefix(60)), baseURL: p.url, deviceId: p.deviceId, logo: logo), token: p.token)
    pending = nil
  }
}
