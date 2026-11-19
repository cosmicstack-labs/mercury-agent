import SwiftUI
import MercuryCore

/// The connect flow: an address and the owner's sign-in, then (off the owner's computer)
/// a 5-character code the owner approves before Mercury hands this phone a token. Last, once it's
/// connected, a friendly name (the computer's name as a first guess) and a logo, as Mercury Desktop
/// names a remote when it's added; the Mercury is saved when that step is done.
@MainActor @Observable
final class ConnectModel {
  enum Step: Equatable { case welcome, signIn, token, waiting(Pairing), name }

  /// Connected, not saved yet: what the name step saves.
  struct Pending: Equatable { var url: URL; var token: String; var deviceId: String? }

  var step: Step = .welcome
  var address = ""
  var username = ""
  var password = ""
  var pastedToken = ""
  var busy = false
  var error: String?
  var pending: Pending?
  var name = ""
  var logo = ConnectionLogos.ids[0]
  /// The name as first guessed, until the person types their own.
  var suggestedName = ""
  let store: ConnectionStore
  var poll: Task<Void, Never>?

  init(store: ConnectionStore) { self.store = store }

  var deviceName: String {
    #if canImport(UIKit)
    "\(UIDevice.current.name) · Mercury for iOS"
    #else
    "Mercury for iOS"
    #endif
  }

  var canSignIn: Bool { !address.isEmpty && !username.isEmpty && !password.isEmpty && !busy }

  func signIn() async {
    guard let url = MercuryClient.normalize(address) else { error = MercuryError.badAddress.errorDescription; return }
    busy = true; error = nil
    defer { busy = false }
    do {
      switch try await MercuryClient(baseURL: url).signIn(username: username, password: password, deviceName: deviceName) {
      case .signedIn(let token, let device):
        finish(url: url, token: token, device: device)
      case .pending(let p):
        password = ""
        step = .waiting(p)
        wait(for: p, at: url)
      }
    } catch {
      self.error = error.localizedDescription
    }
  }

  /// Long-polls until the owner approves, denies, or the code expires.
  func wait(for p: Pairing, at url: URL) {
    poll?.cancel()
    poll = Task {
      let client = MercuryClient(baseURL: url)
      while !Task.isCancelled {
        do {
          switch try await client.pairingStatus(p) {
          case .pending: continue
          case .approved(let token, let device): finish(url: url, token: token, device: device); return
          case .denied(let why), .expired(let why): error = why; step = .signIn; return
          }
        } catch {
          if Task.isCancelled { return }
          try? await Task.sleep(for: .seconds(3))
        }
      }
    }
  }

  func cancelWaiting() { poll?.cancel(); poll = nil; step = .signIn }

  /// Connect with a device token made elsewhere (mdt_…), checked with a health probe first.
  func useToken() async {
    guard let url = MercuryClient.normalize(address) else { error = MercuryError.badAddress.errorDescription; return }
    let token = pastedToken.trimmingCharacters(in: .whitespacesAndNewlines)
    busy = true; error = nil
    defer { busy = false }
    do {
      _ = try await MercuryClient(baseURL: url, token: token).health()
      finish(url: url, token: token, device: nil)
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
