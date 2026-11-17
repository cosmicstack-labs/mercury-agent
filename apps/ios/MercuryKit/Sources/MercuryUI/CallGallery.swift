import SwiftUI
import MercuryCore

/// The voice call in each of its states (05a–05j), driven through the real call brain with a
/// silent engine, for the Snapshots tool and design review.
@MainActor
public enum CallGallery {
  final class SilentLink: VoiceLink, @unchecked Sendable {
    func pushAudio(pcm16: Data) {}
    func setMuted(muted: Bool) {}
    func interrupt() {}
    func stop() {}
    func toolResult(id: String, output: String) {}
    func say(text: String) {}
    func instruct(text: String) {}
  }

  final class StillPlayback: CallPlayback {
    var isPlaying = false
    func flush() { isPlaying = false }
  }

  final class SampleChat: CallChat {
    var activity: String?
    var working = false
    var approvals: [CallApproval] = []
    func ask(_ question: String) async -> CallAnswer {
      try? await Task.sleep(for: .seconds(3600))
      return .stopped
    }
    func answer(_ approval: CallApproval, approved: Bool) async throws {}
    func stopWork() async {}
  }

  static func call(mic: Float = 0, voice: Float = 0, _ setUp: (VoiceCallModel, CallBrain, SampleChat, StillPlayback) -> Void) -> AnyView {
    let m = VoiceCallModel(conversation: ConversationModel(client: MercuryClient(baseURL: URL(string: "http://localhost")!), thread: nil),
                           meter: CallMeter(fixed: (mic, voice)))
    let chat = SampleChat(), playback = StillPlayback()
    m.useLive(link: SilentLink(), chat: chat, playback: playback)
    let b = m.brain!
    b.handle(.connected)
    m.startedAt = Date(timeIntervalSinceNow: -134)
    setUp(m, b, chat, playback)
    return AnyView(VoiceCallView(model: m))
  }

  public static func screens() -> [(name: String, view: AnyView)] {
    let calling: AnyView = {
      let m = VoiceCallModel(conversation: ConversationModel(client: MercuryClient(baseURL: URL(string: "http://localhost")!), thread: nil),
                             meter: CallMeter(fixed: (0, 0)))
      return AnyView(VoiceCallView(model: m))
    }()
    let fallback: AnyView = {
      let m = VoiceCallModel(conversation: ConversationModel(client: MercuryClient(baseURL: URL(string: "http://localhost")!), thread: nil),
                             meter: CallMeter(fixed: (0.1, 0)))
      m.mode = .turns
      m.notice = "Voice calls on the phone need an OpenAI key (Settings → Models) or a Gemini key (Settings → Voice). Until then, this call goes turn by turn."
      m.turnPhase = .listening
      m.startedAt = Date(timeIntervalSinceNow: -12)
      return AnyView(VoiceCallView(model: m))
    }()
    return [
      ("05a-call-calling", calling),
      ("05b-call-listening", call(mic: 0.04) { _, b, _, _ in
        b.handle(.assistantText(text: "Hey, I'm listening."))
      }),
      ("05c-call-owner-speaking", call(mic: 0.7) { _, b, _, _ in
        b.handle(.assistantText(text: "Hey, I'm listening."))
        b.handle(.speechStarted)
      }),
      ("05d-call-mercury-speaking", call(voice: 0.6) { _, b, _, p in
        b.handle(.userText(text: "What's on my calendar this afternoon?"))
        p.isPlaying = true
        b.playbackChanged(true)
        b.handle(.assistantText(text: "Two meetings after lunch: the design review at two, and a call with Sana at four."))
      }),
      ("05e-call-working", call(mic: 0.02) { _, b, chat, _ in
        b.handle(.userText(text: "What's the latest news from Srinagar?"))
        b.handle(.assistantText(text: "On it."))
        chat.activity = "Searching the web"
        chat.working = true
        b.handle(.toolCall(id: "c1", name: "ask_mercury", argsJson: #"{"question":"Latest news from Srinagar"}"#))
      }),
      ("05f-call-approval", call(voice: 0.3) { _, b, chat, p in
        b.handle(.userText(text: "Deploy the landing page."))
        chat.working = true
        chat.approvals = [CallApproval(id: "p1", text: "Run command: npm run deploy -- --prod", targetId: nil)]
        b.handle(.toolCall(id: "c1", name: "ask_mercury", argsJson: #"{"question":"Deploy the landing page to production"}"#))
        b.tick()
        p.isPlaying = true
        b.playbackChanged(true)
        b.handle(.assistantText(text: "Mercury wants to run the production deploy. Should it go ahead?"))
      }),
      ("05g-call-muted", call { _, b, _, _ in
        b.handle(.userText(text: "Hold on a second."))
        b.handle(.assistantText(text: "Sure, take your time."))
        b.setMuted(true)
      }),
      ("05h-call-fallback", fallback),
      ("05i-call-dropped", call { m, b, _, _ in
        b.handle(.assistantText(text: "Hey, I'm listening."))
        b.handle(.closed(reason: "the voice model disconnected"))
        _ = m
      }),
    ]
  }
}
