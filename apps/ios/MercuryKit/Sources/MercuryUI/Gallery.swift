import SwiftUI
import MercuryCore

/// Every screen in a fixed sample state, for the Snapshots tool and design review.
@MainActor
public enum Gallery {
  static var approval: some View {
    let opts = ["yes", "always", "no"].map { ConversationModel.Prompt.Option(value: $0, label: ConversationModel.optionLabel($0)) }
    return VStack(spacing: 16) {
      PromptCard(prompt: .init(id: "1", kind: "permission_request", text: "Run command: npm run deploy -- --prod", options: opts, targetId: nil)) { _ in }
      PromptCard(prompt: .init(id: "2", kind: "permission_request", text: "MCP tool call\nServer: github\nTool: create_issue\nArguments:\n{\n  \"title\": \"Landing page is slow on mobile\",\n  \"labels\": [\"perf\"]\n}", options: opts, targetId: nil)) { _ in }
      Spacer()
    }
    .padding(16).frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.bg)
  }

  /// Owner tasks (ADR-048): the sheet's cards, a text one and a "done" one with its page.
  static var ownerTasks: some View {
    let m = OwnerTasksModel()
    let soon = Date.now.addingTimeInterval(4 * 60 + 50)
    m.replace([
      OwnerTask(id: "g1", code: "K7Q2M", title: "Enter the code from your bank's text", prompt: "Your bank sent a 6-digit code to your phone. Type it here.",
                who: "Mercury", link: URL(string: "https://bank.example.com/verify"), expiresAt: soon),
      OwnerTask(id: "g2", code: "P4XW9", title: "Finish signing in", prompt: "Open the page, approve the sign-in, then tap Done.",
                who: "plugin captcha", link: URL(string: "https://accounts.example.com/approve"), answerKind: .done, expiresAt: soon),
    ])
    return VStack(spacing: 12) {
      OwnerTasksList(model: m, now: .now)
      Spacer(minLength: 0)
    }
    .padding(16).frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.bg)
  }

  static let reply = """
  ## Landing page: what changed
  The deploy is ready. Three things moved:

  1. **Hero** copy is shorter, with one call to action.
  2. Pricing now reads from `plans.json`.
     - Free and Pro only
     - Yearly shows the saving
  3. Images are lazy-loaded.

  - [x] Tests pass
  - [ ] Deploy to production

  | Page | Before | After |
  |---|---|---|
  | Home | 2.4 s | **1.1 s** |
  | Pricing | 1.9 s | 0.9 s |

  | Check | Mobile | Desktop | Notes |
  |---|---|---|---|
  | Largest paint | 1.4 s | 0.8 s | Hero image now lazy-loaded below the fold |

  > [!WARNING]
  > Deploying replaces the live site. Say "deploy" when you're ready.

  ```bash
  npm run build && npm run deploy -- --prod
  ```
  """

  static var markdown: some View {
    // The renderer can't draw a ScrollView, so the messages are laid out directly.
    let client = MercuryClient(baseURL: URL(string: "http://localhost")!)
    return VStack(alignment: .leading, spacing: 18) {
      MessageView(message: ChatMessage(role: "user", content: "What changed on the landing page?"), client: client)
      MessageView(message: ChatMessage(role: "assistant", content: reply), client: client)
      Spacer(minLength: 0)
    }
    .padding(16).frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.bg)
  }

  /// A screen in the running app, offline, for checking what the Snapshots renderer can't draw
  /// (scroll views, fields). Debug builds open it with the launch argument `-gallery <name>`.
  public static func live(_ name: String) -> AnyView? {
    switch name {
    case "conversation":
      let m = ConversationModel(client: MercuryClient(baseURL: URL(string: "http://localhost")!), thread: nil)
      m.messages = [ChatMessage(role: "user", content: "What changed on the landing page?"), ChatMessage(role: "assistant", content: reply)]
      m.title = "Landing page"
      return AnyView(NavigationStack { ConversationView(model: m) }.appearance())
    default:
      return nil
    }
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
      ("01f-connect-name", AnyView(IdentityGallery.nameStep(store: store))),
      ("01g-logo-sheet", AnyView(IdentityGallery.sheet)),
      ("01h-mercury-switcher", AnyView(IdentityGallery.switcher())),
      ("01i-mercury-edit", AnyView(IdentityGallery.edit())),
      ("03b-conversation-markdown", AnyView(markdown)),
      ("04-approval", AnyView(approval)),
      ("04d-owner-tasks", AnyView(ownerTasks)),
    ]
  }
}
