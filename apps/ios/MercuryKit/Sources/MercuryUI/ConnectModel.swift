import SwiftUI
import MercuryCore

/// The connect flow: an address and the owner's sign-in, then (off the owner's computer)
/// a 5-character code the owner approves before Mercury hands this phone a token.
@MainActor @Observable
final class ConnectModel {
  enum Step: Equatable { case welcome, signIn, token, waiting(Pairing) }

  var step: Step = .welcome
  var address = ""
  var username = ""
  var password = ""
  var pastedToken = ""
  var busy = false
  var error: String?
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

  func finish(url: URL, token: String, device: Device?) {
    // mdt_<8 hex device id>_<64 hex>: the device id is the middle part.
    let parts = token.split(separator: "_")
    let deviceId = device?.id ?? (parts.count == 3 && parts[0] == "mdt" ? String(parts[1]) : nil)
    store.add(Connection(name: url.host() ?? "Mercury", baseURL: url, deviceId: deviceId), token: token)
  }
}
