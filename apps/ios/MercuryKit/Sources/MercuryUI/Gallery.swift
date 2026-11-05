import SwiftUI
import MercuryCore

/// Every screen in a fixed sample state, for the Snapshots tool and design review.
@MainActor
public enum Gallery {
  static var approval: some View {
    let opts = ["yes", "always", "no"].map { ConversationModel.Prompt.Option(value: $0, label: ConversationModel.optionLabel($0)) }
    return VStack(spacing: 16) {
      PromptCard(prompt: .init(id: "1", kind: "permission_request", text: "Run command: npm run deploy -- --prod", options: opts, targetId: nil)) { _ in }
      PromptCard(prompt: .init(id: "2", kind: "permission_request", text: "Write to file: ~/sites/landing/index.html", options: opts, targetId: nil)) { _ in }
      Spacer()
    }
    .padding(16).frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.bg)
  }

  static func call(_ phase: VoiceCallModel.Phase, caption: String?, step: String? = nil, level: Float = 0) -> some View {
    let m = ConversationModel(client: MercuryClient(baseURL: URL(string: "http://localhost")!), thread: nil)
    if let step { m.handle("step_start", #"{"tool":"\#(step)","step":1}"#) }
    let c = VoiceCallModel(conversation: m)
    c.phase = phase; c.caption = caption; c.level = level; c.startedAt = Date(timeIntervalSinceNow: -134)
    return VoiceCallView(model: c)
  }

  public static func screens() -> [(name: String, view: AnyView)] {
    let store = ConnectionStore(defaults: UserDefaults(suiteName: "gallery")!)
    func connect(_ step: ConnectModel.Step, error: String? = nil) -> AnyView {
      let m = ConnectModel(store: store)
      m.step = step; m.address = "mercury.tail1234.ts.net"; m.username = "salman"; m.error = error
      return AnyView(ConnectView(model: m))
    }
    let pairing = Pairing(pairingId: "p1", pollToken: "t", code: "K7Q2M", message: nil, expiresAt: nil)
    return [
      ("01a-connect-welcome", connect(.welcome)),
      ("01b-connect-signin", connect(.signIn)),
      ("01c-connect-signin-error", connect(.signIn, error: MercuryError.badCredentials.errorDescription)),
      ("01d-connect-waiting", connect(.waiting(pairing))),
      ("01e-connect-token", connect(.token)),
      ("04-approval", AnyView(approval)),
      ("05a-call-listening", AnyView(call(.hearing, caption: nil, level: 0.6))),
      ("05b-call-working", AnyView(call(.working, caption: "“What's the latest news from Srinagar?”", step: "web_search"))),
      ("05c-call-speaking", AnyView(call(.speaking, caption: "Schools reopen on Monday, and the Dal Lake cleanup moved to its second phase."))),
    ]
  }
}
