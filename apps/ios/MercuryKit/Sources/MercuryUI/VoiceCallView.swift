import SwiftUI
import MercuryCore

/// Screen 5: a voice call with Mercury. The orb is the call: it breathes while Mercury listens,
/// swells with your voice, ripples out with Mercury's, and shimmers while Mercury works (what it's
/// doing is written under it). Tap it while Mercury talks to cut in.
struct VoiceCallView: View {
  @State var model: VoiceCallModel
  var onClose: () -> Void = {}
  @State var transcript = false

  var body: some View {
    VStack(spacing: 0) {
      header
      if let n = model.notice {
        CallNotice(text: n).padding(.horizontal, 20).padding(.top, 14)
      }
      Spacer(minLength: 8)
      // Smaller while an approval card needs the room. Tapping it while Mercury talks cuts in.
      CallOrb(state: model.orbState, meter: model.meter)
        .scaleEffect(model.approval != nil && !model.isEnded ? 0.78 : 1)
        .frame(height: model.approval != nil && !model.isEnded ? 220 : 280)
        .contentShape(Circle())
        .onTapGesture { if model.canInterrupt { Task { await model.interrupt() } } }
        .accessibilityElement()
        .accessibilityLabel("Mercury")
        .accessibilityAddTraits(model.canInterrupt ? .isButton : [])
        .accessibilityHint(model.canInterrupt ? "Interrupts Mercury" : "")
      VStack(spacing: 10) {
        Text(model.status)
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(model.error != nil ? Theme.red : model.approval != nil ? Theme.amber : model.phase == .working ? Theme.accent : Theme.ink3)
          .multilineTextAlignment(.center)
          .contentTransition(.opacity)
          .animation(.easeOut(duration: 0.2), value: model.status)
        captions
      }
      .padding(.horizontal, 28)
      .padding(.top, 18)
      .accessibilityElement(children: .combine)
      Spacer(minLength: 8)
      if let a = model.approval, !model.isEnded {
        CallApprovalCard(approval: a) { model.answerApproval(a, approved: $0) }
          .padding(.horizontal, 16).padding(.bottom, 18)
          .transition(.move(edge: .bottom).combined(with: .opacity))
      }
      controls
      Text(model.isEnded ? "What Mercury did is in Chats." : "What you ask Mercury is saved in Chats.")
        .font(.system(size: 12)).foregroundStyle(Theme.ink4).padding(.top, 16).padding(.bottom, 10)
    }
    .animation(.spring(duration: 0.35), value: model.approval)
    .padding(.top, 8)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.bg)
    .task { await model.start() }
    .onDisappear { model.end() }
    .sheet(isPresented: $transcript) { CallTranscript(call: model) }
  }

  var header: some View {
    ZStack(alignment: .topTrailing) {
      VStack(spacing: 6) {
        MercuryMark().frame(width: 30, height: 38)
        Text("Mercury").font(.system(size: 24, weight: .semibold)).foregroundStyle(Theme.ink)
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
          Text(subtitle(ctx.date)).font(.system(size: 15)).monospacedDigit().foregroundStyle(Theme.ink3)
        }
      }
      .frame(maxWidth: .infinity)
      .accessibilityElement(children: .combine)
      Button { transcript = true } label: {
        Image(systemName: "text.bubble").font(.system(size: 18)).foregroundStyle(Theme.ink2).frame(width: 44, height: 44)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Show transcript")
      .padding(.trailing, 8)
    }
  }

  func subtitle(_ now: Date) -> String {
    if model.isEnded { return model.startedAt.map { "Call ended · " + Self.elapsed(from: $0, to: model.endedAt ?? now) } ?? "Call ended" }
    guard let s = model.startedAt else { return "Calling…" }
    return Self.elapsed(from: s, to: now)
  }

  @ViewBuilder var captions: some View {
    VStack(spacing: 10) {
      if let o = model.ownerLine {
        Text("“\(o)”").font(.system(size: 15)).foregroundStyle(Theme.ink3)
          .multilineTextAlignment(.center).lineLimit(2)
      }
      if let m = model.mercuryLine {
        Text(m).font(.system(size: 20, weight: .medium)).foregroundStyle(Theme.ink)
          .multilineTextAlignment(.center).lineLimit(4).minimumScaleFactor(0.85)
      }
    }
    .frame(maxWidth: 330)
    .animation(.easeOut(duration: 0.25), value: model.mercuryLine)
  }

  var controls: some View {
    HStack(alignment: .top, spacing: 34) {
      CallButton(symbol: model.muted ? "mic.slash.fill" : "mic.fill", label: model.muted ? "Unmute" : "Mute", on: model.muted) { model.toggleMute() }
        .disabled(model.isEnded)
      CallButton(symbol: "speaker.wave.2.fill", label: "Speaker", on: model.speaker) { model.toggleSpeaker() }
        .disabled(model.isEnded)
      VStack(spacing: 8) {
        Button {
          if model.isEnded { onClose() } else { model.end(); onClose() }
        } label: {
          Image(systemName: model.isEnded ? "xmark" : "phone.down.fill").font(.system(size: 28)).foregroundStyle(.white)
            .frame(width: 72, height: 72).background(model.isEnded ? Theme.ink3 : Color(hex: 0xE5484D), in: Circle())
        }
        .accessibilityLabel(model.isEnded ? "Close" : "End call")
        Text(model.isEnded ? "Close" : "End").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink3)
      }
    }
    .buttonStyle(.plain)
  }

  static func elapsed(from start: Date?, to now: Date) -> String {
    guard let start else { return "00:00" }
    let s = max(0, Int(now.timeIntervalSince(start)))
    return String(format: "%02d:%02d", s / 60, s % 60)
  }
}

struct CallButton: View {
  var symbol: String
  var label: String
  var on: Bool
  var action: () -> Void
  @Environment(\.isEnabled) var enabled
  var body: some View {
    VStack(spacing: 8) {
      Button(action: action) {
        Image(systemName: symbol).font(.system(size: 24)).foregroundStyle(on ? Theme.bg : Theme.ink)
          .frame(width: 72, height: 72).background(on ? Theme.ink : Theme.ink.opacity(0.09), in: Circle())
      }
      .accessibilityLabel(label)
      .accessibilityAddTraits(on ? .isSelected : [])
      Text(label).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink3)
    }
    .opacity(enabled ? 1 : 0.4)
  }
}

/// Why the call goes turn by turn.
struct CallNotice: View {
  var text: String
  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "waveform.slash").font(.system(size: 15)).foregroundStyle(Theme.amber).padding(.top, 1)
      Text(text).font(.system(size: 13)).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.amber.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.amber.opacity(0.25)))
    .accessibilityElement(children: .combine)
  }
}

/// An approval on the call: Mercury asks out loud, and it can be answered here too.
/// Only yes or no on a call (never "always").
struct CallApprovalCard: View {
  var approval: CallApproval
  var answer: (Bool) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Label("Mercury wants to", systemImage: "hand.raised.fill")
        .font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.amber)
      Text(approval.text).font(.system(size: 15)).foregroundStyle(Theme.ink).lineLimit(4)
        .frame(maxWidth: .infinity, alignment: .leading)
      HStack(spacing: 10) {
        Button { answer(false) } label: { Text("Deny").frame(maxWidth: .infinity) }.buttonStyle(AnswerButtonStyle())
        Button { answer(true) } label: { Text("Allow").frame(maxWidth: .infinity) }.buttonStyle(AnswerButtonStyle(primary: true))
      }
    }
    .padding(16)
    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius))
    .overlay(RoundedRectangle(cornerRadius: Theme.radius).stroke(Theme.amber.opacity(0.45)))
    .accessibilityElement(children: .contain)
  }
}

// MARK: - The orb

/// What the orb shows.
enum OrbState: Equatable {
  case calling, listening, ownerSpeaking, mercurySpeaking, working, muted, ended
}

extension VoiceCallModel {
  var orbState: OrbState {
    switch phase {
    case .starting: return .calling
    case .ended: return .ended
    case .speaking: return .mercurySpeaking
    case _ where muted: return .muted
    case .hearing: return .ownerSpeaking
    case .working, .sending: return .working
    case .listening: return .listening
    }
  }
}

/// A glowing core in rings. Listening, it breathes; your voice swells it; Mercury's voice sends
/// ripples outward; while Mercury works a slow light circles it; muted, it greys and dims.
/// Driven by the call's levels every frame. With Reduce Motion it holds still and only brightens.
struct CallOrb: View {
  var state: OrbState
  var meter: CallMeter
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @Environment(\.colorScheme) var scheme
  @State private var smooth = OrbSmoothing()

  var body: some View {
    TimelineView(.animation(minimumInterval: 1 / 60, paused: state == .ended)) { ctx in
      let t = ctx.date.timeIntervalSinceReferenceDate
      let raw = meter.read(now: ctx.date)
      let lv = smooth.step(mic: state == .muted ? 0 : raw.mic, voice: raw.voice, at: t)
      Canvas { g, size in
        draw(&g, size: size, t: reduceMotion ? 0 : t, mic: lv.mic, voice: lv.voice)
      }
    }
    .frame(width: 280, height: 280)
    .accessibilityHidden(true)
  }

  func draw(_ g: inout GraphicsContext, size: CGSize, t: Double, mic: Double, voice: Double) {
    let c = CGPoint(x: size.width / 2, y: size.height / 2)
    let dark = scheme == .dark
    let green = Appearance.shared.accent(dark: dark)
    let grey = Color(hex: dark ? 0x545C63 : 0xA3A9AE)
    let tint: Color = state == .muted || state == .ended ? grey : green
    let base: Double = 64
    let motion = reduceMotion ? 0.0 : 1.0

    // The core's size: a soft breath, your voice, a little of Mercury's.
    var r = base
    switch state {
    case .listening: r += 3 * sin(t * 1.6) * motion
    case .ownerSpeaking: r += 3 * sin(t * 1.6) * motion + 26 * mic
    case .mercurySpeaking: r += 10 * voice
    case .working: r += 4 * sin(t * 2.4) * motion
    case .calling: r += 6 * (0.5 + 0.5 * sin(t * 3.2)) * motion
    case .muted: r -= 4
    case .ended: r -= 8
    }
    if reduceMotion { r = base + 12 * max(mic, voice) }

    // Ripples: Mercury's voice sends rings out; calling sends slow ones, like a ring tone.
    if !reduceMotion && (state == .mercurySpeaking || state == .calling) {
      let speed = state == .calling ? 0.55 : 0.9
      let strength = state == .calling ? 0.5 : 0.35 + 0.65 * voice
      for k in 0..<3 {
        let p = (t * speed + Double(k) / 3).truncatingRemainder(dividingBy: 1)
        let rr = r + 8 + p * 64
        let alpha = (1 - p) * 0.45 * strength
        g.stroke(Path(ellipseIn: CGRect(x: c.x - rr, y: c.y - rr, width: rr * 2, height: rr * 2)), with: .color(tint.opacity(alpha)), lineWidth: 2 + 3 * (1 - p) * strength)
      }
    }

    // The resting rings.
    for (i, gap) in [26.0, 52.0].enumerated() {
      let rr = base + gap + (state == .ownerSpeaking ? mic * 10 * Double(i + 1) : 0)
      g.stroke(Path(ellipseIn: CGRect(x: c.x - rr, y: c.y - rr, width: rr * 2, height: rr * 2)), with: .color(tint.opacity(i == 0 ? 0.16 : 0.09)), lineWidth: 1)
    }

    // The glow.
    let glow = r * (1.45 + 0.35 * max(mic, voice))
    g.fill(Path(ellipseIn: CGRect(x: c.x - glow, y: c.y - glow, width: glow * 2, height: glow * 2)),
           with: .radialGradient(Gradient(colors: [tint.opacity(state == .muted ? 0.12 : 0.32 + 0.25 * max(mic, voice)), tint.opacity(0)]),
                                 center: c, startRadius: r * 0.6, endRadius: glow))

    // Working: a slow light circling the core.
    if state == .working {
      let a = reduceMotion ? 0 : t * 1.4
      let rr = r + 14
      // A comet: faint at its tail, bright at its head.
      let n = 14
      for i in 0..<n {
        let f = Double(i + 1) / Double(n)
        var seg = Path()
        seg.addArc(center: c, radius: rr, startAngle: .radians(a + 2.2 * Double(i) / Double(n)), endAngle: .radians(a + 2.2 * f), clockwise: false)
        g.stroke(seg, with: .color(tint.opacity(0.9 * f * f)), style: StrokeStyle(lineWidth: 1.5 + 2.5 * f, lineCap: .round))
      }
    }

    // The core.
    let light = Color(hex: state == .muted || state == .ended ? (dark ? 0x7E878E : 0xC9CDD1) : (dark ? 0x9BF7D4 : 0x6FE3B4))
    let shimmer = state == .working && !reduceMotion ? 0.12 * sin(t * 2.4) : 0
    g.fill(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)),
           with: .radialGradient(Gradient(colors: [light, tint]),
                                 center: CGPoint(x: c.x - r * 0.25, y: c.y - r * (0.35 + shimmer)), startRadius: 0, endRadius: r * 1.35))
    if state == .muted {
      g.opacity = 0.9
      let s = r * 0.42
      var slash = Path()
      slash.move(to: CGPoint(x: c.x - s, y: c.y + s)); slash.addLine(to: CGPoint(x: c.x + s, y: c.y - s))
      g.stroke(slash, with: .color(.white.opacity(0.85)), style: StrokeStyle(lineWidth: 5, lineCap: .round))
    }
  }
}

/// Eases the levels between frames: quick to rise, slower to fall, so the orb follows speech smoothly.
final class OrbSmoothing {
  private var mic = 0.0, voice = 0.0, last = 0.0

  func step(mic m: Float, voice v: Float, at t: Double) -> (mic: Double, voice: Double) {
    let dt = last == 0 ? 1 / 60 : min(max(t - last, 0), 0.1)
    last = t
    func ease(_ cur: Double, _ target: Double) -> Double {
      let rate = target > cur ? 22.0 : 6.0
      return cur + (target - cur) * min(1, rate * dt)
    }
    mic = ease(mic, Double(m)); voice = ease(voice, Double(v))
    return (mic, voice)
  }
}

// MARK: - Transcript

/// Everything said on the call so far, as text.
struct CallTranscript: View {
  var call: VoiceCallModel
  @Environment(\.dismiss) var dismiss

  var model: ConversationModel { call.conversation }

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 18) {
          let lines = call.brain?.transcript ?? []
          if lines.isEmpty && model.messages.isEmpty {
            Text("Nothing said yet.").font(.system(size: 15)).foregroundStyle(Theme.ink3)
          }
          // A live call: what each side said, what was asked of Mercury, and its full answers.
          ForEach(lines) { t in
            switch t.role {
            case "owner": MessageView(message: ChatMessage(role: "user", content: t.text), client: model.client)
            case "mercury": Text(t.text).font(.system(size: 16)).foregroundStyle(Theme.ink)
            case "result": Markdown(text: t.text)
            case "ask": Label("Asked Mercury: \(t.text)", systemImage: "arrow.turn.down.right").font(.system(size: 13)).foregroundStyle(Theme.ink3)
            default: Text(t.text).font(.system(size: 13)).foregroundStyle(Theme.ink3)
            }
          }
          if call.mode == .turns {
            ForEach(model.messages) { MessageView(message: $0, client: model.client) }
            if !model.streaming.isEmpty { Markdown(text: model.streaming) }
          }
        }
        .padding(16)
      }
      .background(Theme.bg)
      .navigationTitle("Transcript")
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
  }
}

extension VoiceCallModel: Identifiable {
  nonisolated var id: String { callId }
}

extension View {
  /// The call covers the whole screen on a phone (a sheet where there's no full-screen cover).
  func callCover(_ call: Binding<VoiceCallModel?>, onDismiss: @escaping () -> Void = {}) -> some View {
    #if os(iOS)
    fullScreenCover(item: call, onDismiss: onDismiss) { m in VoiceCallView(model: m) { call.wrappedValue = nil } }
    #else
    sheet(item: call, onDismiss: onDismiss) { m in VoiceCallView(model: m) { call.wrappedValue = nil } }
    #endif
  }
}
