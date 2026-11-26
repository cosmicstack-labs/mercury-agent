import SwiftUI
import MercuryCore

/// Ask Me / Allow All for the composer (the model sheet's Permissions section and the pill's
/// indicator). Reads Mercury's setting when the screen appears, switches optimistically and puts
/// it back with a message when Mercury refuses, and follows the runtime's live `status` events
/// so a change made anywhere (Desktop, a terminal, another phone) shows here too.
/// apps/desktop/src/app/permission.ts is the reference.
@MainActor @Observable
final class PermissionModel {
  /// Nil until Mercury has said (the indicator stays hidden).
  private(set) var mode: PermissionMode?
  /// A switch is on its way.
  private(set) var saving = false
  /// Why the last switch didn't go through, in plain words.
  var error: String?

  @ObservationIgnored private let load: () async throws -> PermissionMode
  @ObservationIgnored private let save: (PermissionMode) async throws -> PermissionMode
  /// Bumped by every switch and every live update, so a late answer can't undo a newer one.
  @ObservationIgnored private var version = 0

  init(load: @escaping () async throws -> PermissionMode, save: @escaping (PermissionMode) async throws -> PermissionMode) {
    self.load = load
    self.save = save
  }

  /// Mercury's own calls; an older Mercury that wants the owner's go-ahead for Allow All goes
  /// through `gate` (its sheet shows the code).
  convenience init(client: MercuryClient, gate: OwnerGate) {
    self.init(load: { try await client.permissionMode() },
              save: { m in try await gate.run { approval in try await client.setPermissionMode(m, approval: approval) } })
  }

  var allowAll: Bool { mode == .allowAll }

  /// Reads the setting (the screen appeared). Keeps what's known when Mercury can't be asked.
  func refresh() async {
    let v = version
    guard let m = try? await load(), v == version, !saving else { return }
    mode = m
  }

  /// Switches now, then confirms with Mercury; on failure puts the old mode back and says why.
  func set(_ next: PermissionMode) async {
    guard next != mode else { return }
    let before = mode
    version += 1
    let v = version
    mode = next
    error = nil
    saving = true
    defer { if v == version { saving = false } }
    do {
      let now = try await save(next)
      if v == version { mode = now }
    } catch {
      guard v == version else { return }
      mode = before
      self.error = "Couldn't switch to \(next.title): \(error.localizedDescription)"
    }
  }

  /// The runtime's live `status` event: a change made anywhere.
  func apply(status data: [String: Any]) {
    guard let m = PermissionMode.fromStatus(data), !saving else { return }
    version += 1
    mode = m
  }

  /// Gallery: a known mode, no Mercury.
  func show(_ m: PermissionMode?) { mode = m }
}
