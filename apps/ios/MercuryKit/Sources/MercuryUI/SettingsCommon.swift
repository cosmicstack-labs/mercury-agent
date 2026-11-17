import SwiftUI
import MercuryCore

/// Runs a settings change. When the owner must allow it first (a change from a remote
/// device, src/web/owner-gate.ts), shows the code to approve on the computer or a messaging
/// channel, waits for the answer, then repeats the change once with that approval.
@MainActor @Observable
final class OwnerGate {
  var question: OwnerQuestion?
  let client: MercuryClient
  private var waiting: Task<Void, Never>?

  init(client: MercuryClient) { self.client = client }

  func run<T>(_ change: @escaping (String?) async throws -> T) async throws -> T {
    do {
      return try await change(nil)
    } catch MercuryError.needsOwner(let q) {
      question = q
      defer { question = nil }
      while true {
        try await Task.sleep(for: .seconds(2))
        switch try await client.approvalStatus(q.id) {
        case .pending: continue
        case .allowed: return try await change(q.id)
        case .denied: throw MercuryError.server(403, "The owner said no.")
        case .expired: throw MercuryError.server(410, "Nobody approved it in time. Try again.")
        }
      }
    }
  }
}

/// The question the owner is answering: its code, big, and where to approve it.
struct OwnerGateSheet: View {
  var question: OwnerQuestion
  var body: some View {
    VStack(spacing: 16) {
      Image(systemName: "lock.shield").font(.system(size: 30)).foregroundStyle(Theme.amber)
      Text("Approve on \(question.where_)").font(.system(size: 18, weight: .semibold)).multilineTextAlignment(.center)
      Text(question.code).font(.system(size: 34, weight: .semibold, design: .monospaced)).kerning(6)
        .accessibilityLabel("Code \(question.code.map(String.init).joined(separator: " "))")
      Text("Changes from your phone need the owner's go-ahead. It goes through as soon as it's approved.")
        .font(.system(size: 14)).foregroundStyle(Theme.ink2).multilineTextAlignment(.center)
      ProgressView()
    }
    .padding(24)
    .presentationDetents([.height(320)])
    .interactiveDismissDisabled()
  }
}

extension View {
  func ownerGate(_ gate: OwnerGate) -> some View {
    sheet(item: Binding(get: { gate.question }, set: { _ in })) { OwnerGateSheet(question: $0) }
  }
}

/// "2.4M", "750k", "1,200".
enum Tokens {
  static func short(_ n: Int) -> String {
    switch n {
    case 1_000_000...: return trim(Double(n) / 1_000_000) + "M"
    case 10_000...: return "\(n / 1000)k"
    case 1000...: return trim(Double(n) / 1000) + "k"
    default: return "\(n)"
    }
  }
  private static func trim(_ d: Double) -> String {
    let s = String(format: "%.1f", d)
    return s.hasSuffix(".0") ? String(s.dropLast(2)) : s
  }
}

/// A status line under a settings row: green when it works, grey when off, amber when it needs you.
struct StatusText: View {
  enum Tone { case good, off, warn }
  var text: String
  var tone: Tone
  var body: some View {
    Text(text).font(.system(size: 13))
      .foregroundStyle(tone == .good ? Theme.accent : tone == .warn ? Theme.amber : Theme.ink3)
  }
}

/// An error under a form, with its message.
struct SettingsError: View {
  var text: String?
  var body: some View {
    if let text { ErrorText(text: text).listRowBackground(Color.clear) }
  }
}
