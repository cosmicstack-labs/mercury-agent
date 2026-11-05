import SwiftUI
import MercuryUI

@main
struct MercuryApp: App {
  var body: some Scene {
    WindowGroup {
      #if DEBUG
      if let name = UserDefaults.standard.string(forKey: "gallery"), let screen = Gallery.live(name) { screen } else { RootView() }
      #else
      RootView()
      #endif
    }
  }
}
