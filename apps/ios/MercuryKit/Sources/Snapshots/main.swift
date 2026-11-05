import SwiftUI
import AppKit
import MercuryUI

// Renders each Gallery screen at iPhone size (390 x 844 pt, @2x) in light and dark.
let out = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "snapshots")
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

MainActor.assumeIsolated {
  for (name, view) in Gallery.screens() {
    for (mode, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
      NSAppearance(named: appearance)!.performAsCurrentDrawingAppearance {
        let r = ImageRenderer(content: view
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
print("wrote snapshots to \(out.path)")
