import SwiftUI
import MercuryCore

/// Where a plan stands, for the card (apps/desktop/src/views/chat/PlanCard.tsx). An unfinished
/// plan in an idle chat isn't being worked on, whatever it says: plans saved before the runtime
/// settled them show as paused, and nothing pulses.
struct PlanStatus: Equatable {
  enum State: Equatable { case running, paused, stopped, complete }
  var state: State
  var done: Int
  var total: Int
  /// The step it's on, or stopped at.
  var current: String?

  /// Chat shows only real multi-step plans (three or more steps).
  static let minSteps = 3

  init?(_ plan: ChatPlan?, busy: Bool) {
    guard let plan, plan.steps.count >= Self.minSteps else { return nil }
    let steps = plan.steps
    done = steps.filter { $0.status == "done" }.count
    total = steps.count
    if done == total { state = .complete; current = nil; return }
    current = (steps.first { $0.status == "active" } ?? steps.first { $0.status == "pending" })?.label
    state = busy ? .running : plan.state == "stopped" ? .stopped : .paused
  }

  var title: String {
    switch state {
    case .running: "Plan"
    case .paused: "Plan paused"
    case .stopped: "Plan stopped"
    case .complete: "Plan complete"
    }
  }

  var settled: Bool { state == .paused || state == .stopped }

  /// The quiet line under a settled plan.
  var hint: String? {
    guard settled else { return nil }
    let from = current.map { "“\($0)”" } ?? "where it stopped"
    return (state == .stopped ? "Stopped before it finished." : "The reply came before these steps were done.") + " Say “continue” to pick it up from \(from)."
  }
}

/// The plan Mercury is working through, pinned above the message box: done steps ticked, the
/// current one half filled, the rest open. One line until tapped (remembered per chat). A paused
/// or stopped plan says so, and a finished or settled one can be closed until the plan changes.
struct PlanCard: View {
  var plan: ChatPlan
  var busy: Bool
  var threadId: String?
  @State private var expanded = false
  @State private var closedAt: Double = 0

  private var key: String { threadId ?? "new" }

  var body: some View {
    if let s = PlanStatus(plan, busy: busy), !(closedAt > 0 && closedAt >= (plan.updatedAt ?? 0)) {
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 10) {
          Button { withAnimation(.snappy) { expanded.toggle() }; UserDefaults.standard.set(expanded, forKey: "plan.open.\(key)") } label: {
            HStack(spacing: 10) {
              ProgressRing(fraction: Double(s.done) / Double(max(s.total, 1)), complete: s.state == .complete).frame(width: 16, height: 16)
              Text(s.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1).fixedSize()
              Text("\(s.done) of \(s.total)").font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.ink3).fixedSize()
              if !expanded, !s.settled, let c = s.current {
                Text("· \(c)").font(.system(size: 14)).foregroundStyle(Theme.ink2).lineLimit(1)
              }
              Spacer(minLength: 0)
              Image(systemName: "chevron.up").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink4)
                .rotationEffect(.degrees(expanded ? 180 : 0))
            }
            .contentShape(Rectangle())
          }
          .buttonStyle(PressButtonStyle())
          .accessibilityLabel("\(s.title), \(s.done) of \(s.total) done")
          .accessibilityHint(expanded ? "Folds the plan" : "Shows the steps")
          if (s.state == .complete || s.settled) && !busy {
            Button { close() } label: { Image(systemName: "xmark").frame(width: 28, height: 28) }
              .buttonStyle(IconButtonStyle()).accessibilityLabel("Close the plan")
          }
        }
        .padding(.leading, 14).padding(.trailing, 8).frame(minHeight: 44)
        if !expanded, s.settled {
          Text((s.current.map { "At “\($0)” · " } ?? "") + "say “continue” to pick it up")
            .font(.system(size: 12)).foregroundStyle(Theme.ink3).lineLimit(1)
            .padding(.leading, 40).padding(.trailing, 14).padding(.bottom, 10).padding(.top, -6)
        }
        if expanded {
          Divider().overlay(Theme.line)
          VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(plan.steps.enumerated()), id: \.offset) { _, step in
              HStack(alignment: .firstTextBaseline, spacing: 10) {
                StepMark(status: s.settled && step.status == "active" ? "pending" : step.status, live: busy && step.status == "active")
                Text(step.label).font(.system(size: 14, weight: step.status == "active" && !s.settled ? .medium : .regular))
                  .foregroundStyle(step.status == "done" ? Theme.ink3 : step.status == "active" && !s.settled ? Theme.ink : Theme.ink2)
                  .fixedSize(horizontal: false, vertical: true)
              }
            }
          }
          .padding(.horizontal, 14).padding(.vertical, 10)
          if let hint = s.hint {
            Divider().overlay(Theme.line)
            Text(hint).font(.system(size: 12)).foregroundStyle(Theme.ink3)
              .padding(.horizontal, 14).padding(.vertical, 9)
          }
        }
      }
      .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius))
      .overlay(RoundedRectangle(cornerRadius: Theme.radius).stroke(Theme.line))
      .onAppear { load() }
      .onChange(of: key) { load() }
      // A finished plan folds by itself once the work stops.
      .onChange(of: s.state) { _, st in if st == .complete && !busy { withAnimation { expanded = false } } }
    }
  }

  private func load() {
    expanded = UserDefaults.standard.bool(forKey: "plan.open.\(key)")
    closedAt = UserDefaults.standard.double(forKey: "plan.closed.\(key)")
  }

  private func close() {
    closedAt = plan.updatedAt ?? Date.now.timeIntervalSince1970 * 1000
    UserDefaults.standard.set(closedAt, forKey: "plan.closed.\(key)")
  }
}

/// ✓ done · ◐ in progress (pulsing only while Mercury works) · ○ not started.
struct StepMark: View {
  var status: String
  var live = false
  var body: some View {
    Group {
      switch status {
      case "done": Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.accent)
      case "active":
        Image(systemName: "circle.lefthalf.filled").foregroundStyle(Theme.accent)
          .symbolEffect(.pulse, options: .repeating, isActive: live)
      default: Image(systemName: "circle").foregroundStyle(Theme.ink4)
      }
    }
    .font(.system(size: 14))
    .accessibilityLabel(status == "done" ? "Done" : status == "active" ? "In progress" : "Not started")
  }
}

struct ProgressRing: View {
  var fraction: Double
  var complete = false
  var body: some View {
    if complete {
      Image(systemName: "checkmark.circle.fill").font(.system(size: 16)).foregroundStyle(Theme.accent)
    } else {
      ZStack {
        Circle().stroke(Theme.ink.opacity(0.12), lineWidth: 2)
        Circle().trim(from: 0, to: fraction).stroke(Theme.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round)).rotationEffect(.degrees(-90))
      }
    }
  }
}
