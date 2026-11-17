import SwiftUI
import MercuryCore

/// The composer's mic states for the Snapshots tool: ready, dictating with live text, and greyed
/// out with what to add (a Gemini-only Mercury).
@MainActor
public enum DictationGallery {
  static func model(_ caps: VoiceCapabilities) -> ConversationModel {
    let m = ChatGallery.model("Errands")
    m.dictation.capabilities = caps
    m.messages = [
      ChatMessage(role: "user", content: "What's on my list for tomorrow?"),
      ChatMessage(role: "assistant", content: "Two things: renew the car insurance, and pick up the dry cleaning before 6."),
    ]
    return m
  }

  static func screen(_ m: ConversationModel) -> AnyView {
    AnyView(VStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 18) {
        ForEach(m.messages) { MessageView(message: $0, client: ChatGallery.client) }
      }
      .padding(.horizontal, 16).padding(.top, 12)
      Spacer(minLength: 0)
      Composer(model: m, focus: FocusState<Bool>().projectedValue, still: true)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).background(Theme.bg))
  }

  static var ready: AnyView {
    screen(model(VoiceCapabilities(call: true, callEngine: "openai", dictation: true, dictationEngine: "openai")))
  }

  static var dictating: AnyView {
    let m = model(VoiceCapabilities(call: true, callEngine: "openai", dictation: true, dictationEngine: "openai"))
    m.draft = "Also:"
    m.dictation.show(.listening)
    let g = m.dictation.currentGeneration
    m.dictation.handle(.final(text: "Remind me to call the plumber tomorrow at nine."), g)
    m.dictation.handle(.partial(text: "And book a table for four at the Italian"), g)
    m.dictation.meter.setEngine(mic: 0.35, voice: 0)
    return screen(m)
  }

  static var unavailable: AnyView {
    let m = model(VoiceCapabilities(call: true, callEngine: "gemini", dictation: false,
      dictationSetup: "Live dictation needs a speech provider. Add an OpenAI key in Settings → Models, or a Deepgram or ElevenLabs key in Settings → Voice. Gemini can't do it: it only transcribes while it's also replying."))
    m.dictation.tap()
    return screen(m)
  }

  public static func screens() -> [(name: String, view: AnyView)] {
    [
      ("03k-composer-mic-ready", ready),
      ("03l-composer-dictating", dictating),
      ("03m-composer-mic-unavailable", unavailable),
    ]
  }
}
