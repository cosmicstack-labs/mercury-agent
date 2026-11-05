import SwiftUI
import MercuryCore

/// Every screen in a fixed sample state, for the Snapshots tool and design review.
@MainActor
public enum Gallery {
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
    ]
  }
}
