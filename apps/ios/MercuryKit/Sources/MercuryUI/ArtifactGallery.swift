import SwiftUI
import MercuryCore

/// Artifacts screens in fixed sample states, for the Snapshots tool (kept apart from Gallery.swift).
/// The renderer can't load anything or draw scroll views, so sample pictures are put in the
/// image caches first and the list is drawn without its ScrollView.
@MainActor
public enum ArtifactGallery {
  static let client = MercuryClient(baseURL: URL(string: "http://localhost")!)
  static let now = Date().timeIntervalSince1970 * 1000
  static let day = 86_400_000.0

  static let palettes: [(Color, Color)] = [
    (Color(hex: 0xF6A26B), Color(hex: 0x7C3AED)), (Color(hex: 0x34E1A1), Color(hex: 0x0E7C8C)),
    (Color(hex: 0xFDE68A), Color(hex: 0xDB2777)), (Color(hex: 0x93C5FD), Color(hex: 0x1E3A8A)),
    (Color(hex: 0xFCA5A5), Color(hex: 0x7F1D1D)), (Color(hex: 0xA7F3D0), Color(hex: 0x365314)),
  ]

  /// A made-up picture: a gradient with a sun and hills, so mosaics read as photos.
  static func picture(_ i: Int) -> PlatformImage? {
    let (a, b) = palettes[i % palettes.count]
    let view = ZStack(alignment: .bottom) {
      LinearGradient(colors: [a, b], startPoint: .top, endPoint: .bottom)
      Circle().fill(.white.opacity(0.7)).frame(width: 70).offset(x: CGFloat(i % 3) * 40 - 40, y: -120)
      Ellipse().fill(b.opacity(0.85)).frame(width: 420, height: 160).offset(x: CGFloat(i % 2) * 80 - 40, y: 60)
    }
    .frame(width: 320, height: 320).clipped()
    let r = ImageRenderer(content: view)
    #if canImport(UIKit)
    return r.uiImage
    #else
    return r.nsImage
    #endif
  }

  static func image(_ id: String, _ i: Int, batch: String? = nil, prompt: String? = nil, ago: Double = 0) -> ArtifactItem {
    if let p = picture(i) {
      AuthImage.cache["/api/artifacts/\(id)/file"] = Image(platform: p)
      MediaImageCache.cache.setObject(p, forKey: client.artifactFileURL(id) as NSURL)
    }
    return ArtifactItem(id: id, threadTitle: "Poster ideas for the launch", name: "\(id).png", kind: "image", mime: "image/png",
                        size: 1_400_000 + i * 230_000, createdAt: now - ago, batch: batch, prompt: prompt, owned: true, originalExists: true)
  }

  static var sampleItems: [ArtifactItem] {
    let p = "A lighthouse at dusk, flat poster style, warm palette"
    return [
      image("b1-1", 0, batch: "b1", prompt: p), image("b1-2", 1, batch: "b1", prompt: p),
      image("b1-3", 2, batch: "b1", prompt: p), image("b1-4", 3, batch: "b1", prompt: p), image("b1-5", 4, batch: "b1", prompt: p),
      ArtifactItem(id: "pdf1", threadTitle: "Quarterly report", name: "q3-report.pdf", kind: "pdf", mime: "application/pdf",
                   size: 842_000, createdAt: now - day * 2, owned: true, originalExists: true),
      image("b2-1", 5, batch: "b2", prompt: "Three app icons, rounded, glassy", ago: day * 3),
      image("b2-2", 1, batch: "b2", prompt: "Three app icons, rounded, glassy", ago: day * 3),
      image("b2-3", 3, batch: "b2", prompt: "Three app icons, rounded, glassy", ago: day * 3),
      ArtifactItem(id: "v1", threadTitle: "Product teaser", name: "teaser.mp4", kind: "video", mime: "video/mp4",
                   size: 24_600_000, createdAt: now - day * 5, owned: true, originalExists: true),
      ArtifactItem(id: "d1", threadTitle: "Landing page", name: "README.md", kind: "text", mime: "text/markdown",
                   size: 6_200, createdAt: now - day * 40, owned: false, originalExists: true),
      image("s1", 2, ago: day * 41),
    ]
  }

  static func model(picking: Bool = false, note: String? = nil) -> ArtifactsModel {
    let m = ArtifactsModel(client: client)
    m.items = sampleItems
    m.counts = ["all": 12, "image": 9, "pdf": 1, "video": 1, "text": 1]
    m.loaded = true
    m.usage = usage
    m.note = note
    if picking {
      m.picking = true
      m.picked = Set(m.groups[0].ids + [m.groups[1].lead.id])
    }
    return m
  }

  static let usage = ArtifactUsage(count: 12, bytes: 61_800_000, byKind: [
    "image": .init(count: 9, bytes: 34_100_000), "video": .init(count: 1, bytes: 24_600_000),
    "pdf": .init(count: 1, bytes: 842_000), "text": .init(count: 1, bytes: 6_200),
  ], freeable: 61_790_000, outside: 1)

  static func list(_ m: ArtifactsModel) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text("Artifacts").font(.system(size: 30, weight: .bold)).foregroundStyle(Theme.ink)
        Spacer()
        if m.picking {
          Text("Done").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.accent)
        } else {
          Image(systemName: "ellipsis.circle").font(.system(size: 20)).foregroundStyle(Theme.accent)
        }
      }
      .padding(.horizontal, 16).padding(.bottom, 10)
      ArtifactsContent(model: m).padding(.horizontal, 16)
      Spacer(minLength: 0)
      if m.picking { ArtifactPickBar(model: m) {} }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).clipped().background(Theme.bg)
  }

  static var cleanup: some View {
    let m = model()
    let c = ArtifactCleanupContent(model: m)
    c.state.note = ArtifactRemoved(removed: 4, freed: 9_300_000, keptOriginals: 1).summary
    return VStack(alignment: .leading, spacing: 0) {
      Text("Clean up").font(.system(size: 17, weight: .semibold)).frame(maxWidth: .infinity).padding(.vertical, 12)
      c.padding(16)
      Spacer(minLength: 0)
    }
    .background(Theme.bg)
  }

  static var slider: some View {
    let items = sampleItems.filter { $0.batch == "b1" }.map { $0.sliderItem(client) }
    return MediaSlider(items: items, start: 2, client: client, onDelete: { _ in })
  }

  public static func screens() -> [(name: String, view: AnyView)] {
    [
      ("06a-artifacts-list", AnyView(list(model(note: ArtifactRemoved(removed: 3, freed: 4_400_000, keptOriginals: 0).summary)))),
      ("06b-artifacts-select", AnyView(list(model(picking: true)))),
      ("06c-artifacts-cleanup", AnyView(cleanup)),
      ("06d-media-slider", AnyView(slider)),
    ]
  }
}
