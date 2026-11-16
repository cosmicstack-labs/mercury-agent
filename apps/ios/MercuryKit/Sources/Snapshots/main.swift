import SwiftUI
import AppKit
import MercuryUI

// Renders each Gallery screen at iPhone size (390 x 844 pt, @2x) in light and dark.
let out = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "snapshots")
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

MainActor.assumeIsolated {
  // --- Artifacts screens (06a–06d, MediaSlider): ArtifactGallery.swift ---
  let artifactScreens = ArtifactGallery.screens()
  // --- end Artifacts ---
  // --- Bots screens (08a–08g): BotsGallery.swift ---
  let botScreens = BotsGallery.screens()
  // --- end Bots ---
  // --- Chat screens (02b–02d, 03c–03j, 03n–03o, 04b–04c): ChatGallery.swift ---
  let chatScreens = ChatGallery.screens()
  // --- end Chat ---
  // --- Call screens (05a–05i): CallGallery.swift ---
  let callScreens = CallGallery.screens()
  // --- end Call ---
  // --- Dictation screens (03k–03m, the composer's mic): DictationGallery.swift ---
  let dictationScreens = DictationGallery.screens()
  // --- end Dictation ---
  // --- Media on its way (09a–09e) and Appearance tints (10a–10g): AppearanceGallery.swift ---
  let mediaScreens = AppearanceGallery.screens()
  let tinted = AppearanceGallery.tinted()
  // --- end Media/Appearance ---
  for (name, view, tint) in (Gallery.screens() + artifactScreens + botScreens + chatScreens + callScreens + dictationScreens + mediaScreens).map({ s in (s.name, { s.view }, String?.none) })
    + tinted.map({ ($0.name, $0.view, $0.tint) }) {
    for (mode, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
      Appearance.shared.previewing(tint) {
        NSAppearance(named: appearance)!.performAsCurrentDrawingAppearance {
          let r = ImageRenderer(content: view()
            .environment(\.colorScheme, mode == "dark" ? .dark : .light)
            .frame(width: 390, height: 763)
            .padding(.top, 47).padding(.bottom, 34)
            .background(Theme.bg).environment(\.colorScheme, mode == "dark" ? .dark : .light))
          r.scale = 2
          if let img = r.nsImage, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
             let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: out.appending(path: "\(name)-\(mode).png"))
          }
        }
      }
    }
  }
}
print("wrote snapshots to \(out.path)")
