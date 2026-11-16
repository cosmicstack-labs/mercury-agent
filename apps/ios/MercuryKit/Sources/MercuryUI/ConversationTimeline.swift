import SwiftUI
import MercuryCore

/// A turn as it happened, top to bottom: thinking, the tools it ran, the answer, notes, newest at
/// the bottom where the reader already is (apps/desktop/src/components/TurnTimeline.tsx). Live, the
/// open thinking streams and the running tool ticks; pictures being made show as one placeholder
/// grid under it all.
struct TurnTimeline: View {
  var trace: TurnTrace
  var live = false
  var now: Date

  enum Block: Identifiable {
    case reasoning(Int, String, Date, Date?)
    case steps(Int, [TurnTrace.Step])
    case text(Int, String)
    case note(Int, String)
    var id: Int {
      switch self { case .reasoning(let i, _, _, _), .steps(let i, _), .text(let i, _), .note(let i, _): i }
    }
  }

  /// Items → blocks: consecutive tool calls form one group.
  static func blocks(_ t: TurnTrace) -> [Block] {
    var out: [Block] = []
    for (i, item) in t.items.enumerated() {
      switch item {
      case .step(let key):
        guard let s = t.step(key) else { continue }
        if case .steps(let at, var list)? = out.last { list.append(s); out[out.count - 1] = .steps(at, list) }
        else { out.append(.steps(i, [s])) }
      case .reasoning(let text, let start, let end):
        if !text.trimmed.isEmpty { out.append(.reasoning(i, text, start, end)) }
      case .text(let text):
        if !text.isEmpty { out.append(.text(i, text)) }
      case .note(let text):
        out.append(.note(i, text))
      }
    }
    return out
  }

  var body: some View {
    let blocks = Self.blocks(trace)
    VStack(alignment: .leading, spacing: 10) {
      ForEach(Array(blocks.enumerated()), id: \.element.id) { n, b in
        let last = live && n == blocks.count - 1
        switch b {
        case .reasoning(_, let text, let start, let end):
          ReasoningBlock(text: text, startedAt: start, endedAt: end, active: last && end == nil, now: now)
        case .steps(_, let steps):
          StepGroup(steps: steps, live: live, now: now)
        case .text(_, let text):
          Markdown(text: text)
        case .note(_, let text):
          // A finished reply pins its warnings above it, so inside the timeline they are plain notes.
          if live && TurnTrace.isSecurity(text) { SecurityNotice(text: text) } else { NoteRow(text: text) }
        }
      }
      if live {
        ForEach(trace.liveMedia) { b in
          MediaPlaceholder(shape: b.shape, startedAt: b.startedAt, now: now, done: b.done, quiet: true)
        }
      }
    }
  }
}

/// One thinking block: open while it streams (its latest lines), folded to "Thought for 8s" after.
struct ReasoningBlock: View {
  var text: String
  var startedAt: Date
  var endedAt: Date?
  var active: Bool
  var now: Date
  @State private var userOpen: Bool?

  var body: some View {
    let open = userOpen ?? active
    let took = TurnTrace.duration((endedAt ?? now).timeIntervalSince(startedAt))
    VStack(alignment: .leading, spacing: 6) {
      Button { withAnimation(.snappy) { userOpen = !open } } label: {
        HStack(spacing: 6) {
          Image(systemName: "brain").foregroundStyle(active ? Theme.cyan : Theme.ink3)
          Text(active ? "Thinking · \(took)" : "Thought for \(took)")
          Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).rotationEffect(.degrees(open ? 90 : 0))
        }
        .font(.system(size: 14)).foregroundStyle(Theme.ink3)
      }
      .buttonStyle(PressButtonStyle())
      .accessibilityHint(open ? "Folds the thinking" : "Shows the thinking")
      if open {
        // While it streams, the newest lines; once folded open on purpose, all of it.
        Text(active ? String(text.trimmed.suffix(420)) : text.trimmed)
          .font(.system(size: 14)).foregroundStyle(Theme.ink3)
          .lineLimit(active ? 5 : nil)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
          .padding(.leading, 12)
          .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1) }
          .padding(.leading, 7)
      }
    }
  }
}

/// A run of tool calls. Long runs show the latest few; failures and the running one always show.
struct StepGroup: View {
  var steps: [TurnTrace.Step]
  var live: Bool
  var now: Date
  @State private var all = false
  static let shown = 4

  var body: some View {
    // While it runs, a picture or voice being made is its placeholder, not also a row.
    let listed = live ? steps.filter { !$0.isMaking } : steps
    let hidden = all ? [] : listed.prefix(max(0, listed.count - Self.shown)).filter { $0.status != .error && $0.status != .running }
    let hiddenKeys = Set(hidden.map(\.key))
    if !listed.isEmpty {
      VStack(alignment: .leading, spacing: 6) {
        if !hidden.isEmpty {
          Button { withAnimation(.snappy) { all = true } } label: {
            Label("\(hidden.count) earlier step\(hidden.count == 1 ? "" : "s")", systemImage: "chevron.right")
              .font(.system(size: 13)).foregroundStyle(Theme.ink4)
          }
          .buttonStyle(PressButtonStyle())
        }
        ForEach(listed.filter { !hiddenKeys.contains($0.key) }) { s in StepRow(step: s, live: live, now: now) }
      }
    }
  }
}

struct StepRow: View {
  var step: TurnTrace.Step
  var live: Bool
  var now: Date
  @State private var open = false

  var body: some View {
    let s = step
    let running = s.status == .running
    let failed = s.status == .error
    let detail = !running ? (s.summary?.trimmed ?? "") : ""
    Button { if !detail.isEmpty { withAnimation(.snappy) { open.toggle() } } } label: {
      HStack(alignment: .top, spacing: 8) {
        Group {
          switch s.status {
          case .running: TurnSpinner(color: Theme.accent).frame(width: 12, height: 12)
          case .stopped: Image(systemName: "stop.fill").font(.system(size: 9)).foregroundStyle(Theme.ink4)
          case .error: Image(systemName: "exclamationmark.circle").font(.system(size: 13)).foregroundStyle(Theme.red)
          case .done: Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(Theme.accent)
          }
        }
        .frame(width: 16, height: 18)
        VStack(alignment: .leading, spacing: 2) {
          Text(s.label).font(.system(size: 14)).foregroundStyle(running ? Theme.ink : Theme.ink2).lineLimit(open ? nil : 1)
          if s.status == .stopped { Text("Stopped before it finished").font(.system(size: 12)).foregroundStyle(Theme.ink4) }
          if !detail.isEmpty && (failed || open) {
            Text(detail).font(.system(size: 12)).foregroundStyle(failed ? Theme.red.opacity(0.9) : Theme.ink4)
              .lineLimit(open ? nil : 2).fixedSize(horizontal: false, vertical: true)
          }
        }
        Spacer(minLength: 4)
        if let d = s.duration(now: now) {
          Text(TurnTrace.duration(d)).font(.system(size: 11, design: .monospaced)).foregroundStyle(running ? Theme.ink3 : Theme.ink4).padding(.top, 2)
        }
      }
    }
    .buttonStyle(PressButtonStyle())
    .accessibilityElement(children: .combine)
    .accessibilityValue(running ? "running" : failed ? "failed" : s.status == .stopped ? "stopped" : "done")
  }
}

/// "Checking my work…": a note inside the turn, not its reply.
struct NoteRow: View {
  var text: String
  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "arrow.turn.down.right").font(.system(size: 11)).foregroundStyle(Theme.ink4).padding(.top, 3)
      Text(text.replacingOccurrences(of: #"^[^\p{L}\p{N}*_`]+"#, with: "", options: .regularExpression))
        .font(.system(size: 13)).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
    }
  }
}

/// Mercury's own warning that something it read holds instructions written to an AI (ADR-044):
/// shown plainly, never folded away.
struct SecurityNotice: View {
  var text: String
  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "shield.lefthalf.filled").font(.system(size: 15)).foregroundStyle(Theme.amber).padding(.top, 1)
      VStack(alignment: .leading, spacing: 2) {
        Text("Hidden instructions found").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink)
        Text(Self.clean(text)).font(.system(size: 13)).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    .background(Theme.amber.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.amber.opacity(0.35)))
    .accessibilityElement(children: .combine)
  }

  /// Without the leading shield and markdown emphasis.
  static func clean(_ s: String) -> String {
    s.replacingOccurrences(of: #"^[^\p{L}\p{N}"“(]+"#, with: "", options: .regularExpression)
      .replacingOccurrences(of: "**", with: "")
  }
}

/// The line under a running turn: what is happening right now and how long the turn has taken.
/// The only progress line; a quiet model is said to be quiet, so it never reads as frozen.
struct LiveStatusLine: View {
  var trace: TurnTrace
  var agent: ConversationModel.Agent
  var stopping: Bool
  var waitingForYou: Bool
  var queued: Int?
  var now: Date

  static let quiet: TimeInterval = 20
  static let longQuiet: TimeInterval = 120

  static func what(_ t: TurnTrace, agent: ConversationModel.Agent, stopping: Bool, waitingForYou: Bool, queued: Int?, now: Date) -> String {
    let quietFor = now.timeIntervalSince(t.lastEventAt)
    let last = t.items.last
    var writing = false
    if case .text? = last { writing = quietFor < 2.5 && !stopping }
    var thinking = false
    if case .reasoning(_, _, nil)? = last { thinking = true }
    let step = t.runningStep
    let media = t.liveMedia.first
    let makingNow = media.map { $0.done < $0.total && (step == nil || step!.isMaking) } ?? false
    if stopping { return "Stopping" }
    if queued != nil { return "Waiting for another chat to finish" }
    if writing { return "Writing" }
    if makingNow, let media { return MediaText.describe(media, now: now) }
    if let step { return step.label }
    if thinking { return "Thinking" }
    if let p = t.phase { return p }
    if waitingForYou { return "Waiting for you" }
    if t.items.isEmpty { return "Starting" }
    return agent == .streaming ? "Writing" : "Working"
  }

  var body: some View {
    let quietFor = now.timeIntervalSince(trace.lastEventAt)
    let waitingOnModel = trace.runningStep == nil && !stopping && !waitingForYou && queued == nil && quietFor >= Self.quiet
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 8) {
        TurnSpinner(color: stopping ? Theme.ink4 : Theme.cyan).frame(width: 12, height: 12)
        ShimmerText(text: Self.what(trace, agent: agent, stopping: stopping, waitingForYou: waitingForYou, queued: queued, now: now) + "…")
          .font(.system(size: 14))
        Spacer(minLength: 4)
        Text(TurnTrace.duration(now.timeIntervalSince(trace.startedAt))).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.ink4)
      }
      if waitingOnModel {
        let long = quietFor >= Self.longQuiet
        Label {
          Text(long ? "No response from the model for \(TurnTrace.duration(quietFor)). It may be overloaded: you can stop and try again."
                    : "Waiting for the model · \(TurnTrace.duration(quietFor))")
        } icon: { if long { Image(systemName: "exclamationmark.triangle") } }
          .font(.system(size: 12)).foregroundStyle(long ? Theme.amber : Theme.ink4)
          .padding(.leading, 20)
      }
    }
    .accessibilityElement(children: .combine)
  }
}

/// A finished reply's thought process, folded to one line: "Worked for 12s · 3 steps".
struct ThoughtProcess: View {
  var trace: TurnTrace
  @State private var open = false
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Button { withAnimation(.snappy) { open.toggle() } } label: {
        HStack(spacing: 6) {
          Image(systemName: trace.stopped ? "stop.circle" : trace.steps.isEmpty ? "brain" : "checklist")
          Text(trace.summary)
          Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).rotationEffect(.degrees(open ? 90 : 0))
        }
        .font(.system(size: 13)).foregroundStyle(Theme.ink3)
      }
      .buttonStyle(PressButtonStyle())
      .accessibilityHint(open ? "Folds the steps" : "Shows the thinking and steps")
      if open {
        TurnTimeline(trace: trace, live: false, now: trace.endedAt ?? .now)
          .padding(.leading, 4)
      }
    }
  }
}

/// A small spinner the snapshot renderer can draw (ProgressView can't be).
struct TurnSpinner: View {
  var color: Color = Theme.accent
  @State private var spin = false
  var body: some View {
    Circle().trim(from: 0.1, to: 0.8)
      .stroke(color, style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
      .rotationEffect(.degrees(spin ? 360 : 0))
      .onAppear { withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { spin = true } }
      .accessibilityHidden(true)
  }
}

/// Equal tiles in rows (waiting and finished pictures share it, so nothing jumps).
struct TileGrid<Tile: View>: View {
  var count: Int
  var columns: Int
  var ratio: CGFloat = 1
  var spacing: CGFloat = 6
  @ViewBuilder var tile: (Int) -> Tile

  var body: some View {
    let rows = Int((Double(count) / Double(max(columns, 1))).rounded(.up))
    VStack(spacing: spacing) {
      ForEach(0..<rows, id: \.self) { r in
        HStack(spacing: spacing) {
          ForEach(0..<columns, id: \.self) { c in
            let i = r * columns + c
            if i < count {
              tile(i).aspectRatio(ratio, contentMode: .fit).frame(maxWidth: .infinity)
            } else {
              Color.clear.aspectRatio(ratio, contentMode: .fit).frame(maxWidth: .infinity)
            }
          }
        }
      }
    }
  }
}
