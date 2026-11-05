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
    ]
  }
}
