// swift-tools-version: 5.10
import PackageDescription

// MercuryCore: the connection, the API client and the models (no UI).
// MercuryUI: the SwiftUI screens. The iOS app target (../project.yml) only
// hosts MercuryUI; macOS is listed so `swift build` checks it without Xcode.
let package = Package(
  name: "MercuryKit",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [
    .library(name: "MercuryCore", targets: ["MercuryCore"]),
    .library(name: "MercuryUI", targets: ["MercuryUI"]),
  ],
  dependencies: [
    // The shared Rust voice engine (../MercuryVoice, built by ../scripts/build-voice-engine.sh).
    .package(path: "../MercuryVoice"),
  ],
  targets: [
    .target(name: "MercuryCore"),
    .target(name: "MercuryUI", dependencies: ["MercuryCore", .product(name: "MercuryVoice", package: "MercuryVoice")]),
    .testTarget(name: "MercuryCoreTests", dependencies: ["MercuryCore"]),
    .testTarget(name: "MercuryUITests", dependencies: ["MercuryUI", "MercuryCore"]),
    // `swift run Snapshots <dir>`: renders every screen in light and dark to PNGs (macOS only).
    .executableTarget(name: "Snapshots", dependencies: ["MercuryUI", "MercuryCore"]),
  ]
)
