import SwiftUI
import UIKit
import MercuryUI

@main
struct MercuryApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

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

/// Hands the Home Screen quick actions (Call Mercury) to the app: SwiftUI has no hook for them,
/// so the scene gets a delegate that sees the one picked at launch and those picked later.
final class AppDelegate: NSObject, UIApplicationDelegate {
  func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                   options: UIScene.ConnectionOptions) -> UISceneConfiguration {
    if let item = options.shortcutItem { MainActor.assumeIsolated { _ = HomeScreenActions.shared.perform(item.type) } }
    let config = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
    config.delegateClass = SceneDelegate.self
    return config
  }
}

final class SceneDelegate: NSObject, UIWindowSceneDelegate {
  func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
                   completionHandler: @escaping (Bool) -> Void) {
    completionHandler(MainActor.assumeIsolated { HomeScreenActions.shared.perform(shortcutItem.type) })
  }
}
