import SwiftUI
import MercuryCore

/// Screen 5: a voice call with Mercury. The orb follows your voice while you talk and
/// breathes while Mercury speaks; the line under it says what Mercury is doing.
struct VoiceCallView: View {
  @State var model: VoiceCallModel
  var onClose: () -> Void = {}
  @State var transcript = false

  var body: some View {
    VStack(spacing: 0) {
      header
      Spacer(minLength: 0)
      VStack(spacing: 36) {
        CallOrb(level: model.level, phase: model.phase, muted: model.muted)
        VStack(spacing: 12) {
          Text(model.status).font(.system(size: 14, weight: .medium))
            .foregroundStyle(model.error != nil ? Theme.red : model.conversation.prompts.isEmpty ? Theme.accent : Theme.amber)
            .multilineTextAlignment(.center)
          if let c = model.caption {
            Text(c).font(.system(size: 20, weight: .medium)).foregroundStyle(Theme.ink)
              .multilineTextAlignment(.center).lineLimit(5).frame(maxWidth: 310)
          }
        }
        .padding(.horizontal, 24)
        .accessibilityElement(children: .combine)
      }
      Spacer(minLength: 0)
      if let p = model.conversation.prompts.first {
        PromptCard(prompt: p) { v in Task { await model.conversation.answer(p, v) } }.padding(.horizontal, 16).padding(.bottom, 16)
      }
      controls
      Text(model.phase == .ended ? "Saved in Chats." : "The call is saved as a chat when it ends.")
        .font(.system(size: 13)).foregroundStyle(Theme.ink3).padding(.top, 18).padding(.bottom, 12)
    }
    .padding(.top, 8)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.bg)
    .task { await model.start() }
    .onDisappear { model.end() }
    .sheet(isPresented: $transcript) { CallTranscript(model: model.conversation) }
  }

  var header: some View {
    HStack {
      Color.clear.frame(width: 44, height: 44)
      Spacer()
      VStack(spacing: 2) {
        HStack(spacing: 8) {
          Circle().fill(model.phase == .ended ? Theme.ink4 : Theme.red).frame(width: 8, height: 8)
          Text("Mercury").font(.system(size: 15, weight: .semibold))
        }
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
          Text(Self.elapsed(from: model.startedAt, to: ctx.date)).font(.system(size: 13)).monospacedDigit().foregroundStyle(Theme.ink3)
        }
      }
      .accessibilityElement(children: .combine)
      Spacer()
      Button { transcript = true } label: {
        Image(systemName: "list.bullet").font(.system(size: 18)).foregroundStyle(Theme.ink).frame(width: 44, height: 44)
      }
      .accessibilityLabel("Show transcript")
    }
    .padding(.horizontal, 10)
  }

  var controls: some View {
    HStack(spacing: 28) {
      CallButton(symbol: model.muted ? "mic.slash.fill" : "mic.fill", label: model.muted ? "Unmute" : "Mute", on: model.muted) { model.toggleMute() }
        .disabled(model.phase == .ended)
      Button {
        if model.phase == .ended { onClose() } else { model.end(); onClose() }
      } label: {
        Image(systemName: model.phase == .ended ? "xmark" : "phone.down.fill").font(.system(size: 28)).foregroundStyle(.white)
          .frame(width: 76, height: 76).background(model.phase == .ended ? Theme.ink3 : Color(hex: 0xE5484D), in: Circle())
      }
      .accessibilityLabel(model.phase == .ended ? "Close" : "End call")
      CallButton(symbol: "hand.raised.fill", label: "Interrupt", on: false) { Task { await model.interrupt() } }
        .disabled(!model.canInterrupt).opacity(model.canInterrupt ? 1 : 0.4)
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
  var body: some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: 22)).foregroundStyle(on ? Theme.bg : Theme.ink)
        .frame(width: 64, height: 64).background(on ? Theme.ink : Theme.ink.opacity(0.09), in: Circle())
    }
    .accessibilityLabel(label)
  }
}

/// Rings around a glowing core: it swells with your voice, and breathes while Mercury talks.
struct CallOrb: View {
  var level: Float
  var phase: VoiceCallModel.Phase
  var muted: Bool

  var body: some View {
    TimelineView(.animation(paused: phase != .speaking && phase != .working)) { ctx in
      let t = ctx.date.timeIntervalSinceReferenceDate
      let breath = phase == .speaking ? 0.06 * sin(t * 4) : phase == .working ? 0.03 * sin(t * 2) : 0
      let swell = phase == .listening || phase == .hearing ? Double(level) * 0.18 : 0
      let scale = 1 + breath + swell
      ZStack {
        Circle().stroke(Theme.accent.opacity(0.12)).frame(width: 260, height: 260)
        Circle().stroke(Theme.accent.opacity(0.22)).frame(width: 214, height: 214).scaleEffect(1 + swell * 0.5)
        Circle().fill(RadialGradient(colors: [Theme.accent.opacity(0.55), Theme.accent.opacity(0.25), Theme.accent.opacity(0.05)], center: .init(x: 0.5, y: 0.38), startRadius: 0, endRadius: 86))
          .frame(width: 172, height: 172).scaleEffect(scale)
        Circle().fill(RadialGradient(colors: [Color(hex: 0x9BF7D4), Color(hex: 0x22C98B)], center: .init(x: 0.5, y: 0.35), startRadius: 0, endRadius: 56))
          .frame(width: 112, height: 112).scaleEffect(scale)
      }
      .saturation(muted || phase == .ended ? 0 : 1)
      .opacity(phase == .ended ? 0.5 : 1)
      .animation(.easeOut(duration: 0.12), value: level)
    }
    .frame(width: 260, height: 260)
    .accessibilityHidden(true)
  }
}

/// Everything said on the call so far, as text.
struct CallTranscript: View {
  var model: ConversationModel
  @Environment(\.dismiss) var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 18) {
          if model.messages.isEmpty {
            Text("Nothing said yet.").font(.system(size: 15)).foregroundStyle(Theme.ink3)
          }
          ForEach(model.messages) { MessageView(message: $0, client: model.client) }
          if !model.streaming.isEmpty { Markdown(text: model.streaming) }
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
