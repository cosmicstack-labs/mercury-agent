import SwiftUI
import MercuryCore

/// What a reply made, under it. Pictures, clips and sounds from a media model are shown large: a
/// batch is one grid laid out like its placeholder, so nothing jumps when it lands, with the prompt
/// under it. Tapping opens them full screen in the slider (swipe, "3 / 5", thumbnails; videos and
/// sounds play there). Other files are cards that open in Quick Look.
struct ReplyMedia: View {
  var artifacts: [ArtifactRef]
  var client: MercuryClient
  var openFile: (ArtifactRef) -> Void = { _ in }
  /// Just made: the media arrives from soft to sharp, a batch one tile after another.
  var fresh = false
  @State private var viewing: SliderStart?

  struct SliderStart: Identifiable { var index: Int; var id: Int { index } }

  /// Made by a media model (generate_image, _video, _music, _speech): shown large and playable.
  static func isGenerated(_ a: ArtifactRef) -> Bool {
    (a.tool?.hasPrefix("generate_") ?? false) && ["image", "video", "audio"].contains(a.kind ?? "")
  }

  /// Pictures, clips and sounds are shown large and playable, generated or downloaded alike.
  static func isPlayable(_ a: ArtifactRef) -> Bool {
    ["image", "video", "audio"].contains(a.kind ?? "")
  }

  var body: some View {
    let media = artifacts.filter(Self.isPlayable)
    let rest = artifacts.filter { !Self.isPlayable($0) }
    let images = media.filter { $0.kind == "image" }
    let others = media.filter { $0.kind != "image" }
    VStack(alignment: .leading, spacing: 10) {
      if images.count > 1 {
        VStack(alignment: .leading, spacing: 6) {
          TileGrid(count: min(images.count, MediaText.maxTiles), columns: MediaText.columns(images.count)) { i in
            Button { viewing = .init(index: media.firstIndex(of: images[i]) ?? i) } label: {
              Color.clear.overlay { ArtifactImage(client: client, artifact: images[i], fill: true, reveal: fresh ? Double(i) * 0.09 : nil) }
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
                .overlay(alignment: .bottomTrailing) {
                  if i == MediaText.maxTiles - 1 && images.count > MediaText.maxTiles {
                    Text("+\(images.count - MediaText.maxTiles)").font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
                      .padding(.horizontal, 6).padding(.vertical, 2).background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 6)).padding(6)
                  }
                }
            }
            .buttonStyle(PressButtonStyle())
            .accessibilityLabel("Image \(i + 1) of \(images.count)")
          }
          .frame(maxWidth: 520)
          Text("\(images.count) images" + (Self.prompt(images).map { " · \($0)" } ?? ""))
            .font(.system(size: 12)).foregroundStyle(Theme.ink4).lineLimit(1)
        }
      } else if let one = images.first {
        Button { viewing = .init(index: media.firstIndex(of: one) ?? 0) } label: {
          ArtifactImage(client: client, artifact: one, fill: false, reveal: fresh ? 0 : nil)
            .frame(maxWidth: 340, alignment: .leading)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line))
        }
        .buttonStyle(PressButtonStyle())
        .accessibilityLabel("Image: \(one.name). Opens full screen")
      }
      ForEach(others) { a in
        Button { viewing = .init(index: media.firstIndex(of: a) ?? 0) } label: {
          if a.kind == "video" { VideoTile(artifact: a) } else { SoundRow(artifact: a) }
        }
        .mediaReveal(id: a.id, active: fresh)
        .buttonStyle(PressButtonStyle())
        .accessibilityHint("Plays it full screen")
      }
      ForEach(rest) { a in
        Button { openFile(a) } label: { ArtifactCard(artifact: a, client: client) }
          .buttonStyle(PressButtonStyle())
          .accessibilityHint("Opens a preview")
      }
    }
    .mediaSlider(item: $viewing) { start in
      MediaSlider(items: media.map { Self.sliderItem($0, client) }, start: start.index, client: client)
    }
  }

  static func prompt(_ items: [ArtifactRef]) -> String? {
    let p = Set(items.compactMap { $0.prompt?.trimmed }.filter { !$0.isEmpty })
    return p.count == 1 ? p.first : nil
  }

  static func sliderItem(_ a: ArtifactRef, _ client: MercuryClient) -> MediaSliderItem {
    MediaSliderItem(id: a.id, url: client.artifactFileURL(a.id), title: a.name,
                    kind: a.kind == "video" ? .video : a.kind == "audio" ? .audio : .image)
  }
}

/// A generated clip: a dark 16:9 poster with a play button (it plays in the slider).
struct VideoTile: View {
  var artifact: ArtifactRef
  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 14).fill(Color.black)
      Image(systemName: "play.fill").font(.system(size: 20)).foregroundStyle(.white)
        .frame(width: 52, height: 52).background(.white.opacity(0.18), in: Circle())
      VStack { Spacer(); HStack { Text(artifact.name).font(.system(size: 12)).foregroundStyle(.white.opacity(0.75)).lineLimit(1); Spacer() } }
        .padding(10)
    }
    .aspectRatio(16.0 / 9, contentMode: .fit)
    .frame(maxWidth: 520)
  }
}

/// A generated sound or voice: a row with a play button (it plays in the slider).
struct SoundRow: View {
  var artifact: ArtifactRef
  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: "play.fill").font(.system(size: 14)).foregroundStyle(Theme.onAccent)
        .frame(width: 38, height: 38).background(Theme.accent, in: Circle())
      VStack(alignment: .leading, spacing: 4) {
        HStack(alignment: .center, spacing: 3) {
          ForEach(0..<30, id: \.self) { i in Capsule().fill(Theme.ink.opacity(0.25)).frame(width: 3, height: 5 + CGFloat((i * 53) % 60) / 60 * 16) }
        }
        .frame(height: 22)
        Text(artifact.name + (artifact.size.map { " · " + ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) } ?? ""))
          .font(.system(size: 12)).foregroundStyle(Theme.ink4).lineLimit(1)
      }
      Spacer(minLength: 0)
    }
    .padding(10)
    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line))
    .frame(maxWidth: 420)
  }
}

/// An artifact's picture (it needs the device token), at its own shape or filling its frame.
struct ArtifactImage: View {
  var client: MercuryClient
  var artifact: ArtifactRef
  var fill: Bool
  /// Just made: shown from soft to sharp after this delay once it loads.
  var reveal: Double?
  var body: some View {
    RemoteImage(client: client, url: client.artifactFileURL(artifact.id), name: artifact.name, fill: fill,
                generated: ReplyMedia.isGenerated(artifact), reveal: reveal)
  }
}

/// A picture on this Mercury, loaded with the token and cached (shared with the slider's cache).
struct RemoteImage: View {
  var client: MercuryClient
  var url: URL
  var name: String?
  var fill: Bool
  /// Made by a media model: while it loads it keeps the look it had while being made.
  var generated = false
  /// Reveal it from soft to sharp (after this delay) when it arrives over the network.
  var reveal: Double?
  @State private var image: PlatformImage?
  @State private var failed = false
  @State private var fetched = false

  var body: some View {
    Group {
      if let image {
        Image(platform: image).resizable().aspectRatio(contentMode: fill ? .fill : .fit)
          .mediaReveal(id: url.absoluteString, active: fetched && reveal != nil, delay: reveal ?? 0)
      } else if fill {
        placeholder
      } else {
        placeholder.aspectRatio(1, contentMode: .fit)
      }
    }
    .task(id: url) { await load() }
  }

  @ViewBuilder
  private var placeholder: some View {
    if generated && !failed {
      GeneratingField(kind: "image").background(Theme.ink.opacity(0.035))
    } else {
      plainPlaceholder
    }
  }

  private var plainPlaceholder: some View {
    ZStack {
      Rectangle().fill(Theme.surface2)
      Image(systemName: failed ? "exclamationmark.triangle" : "photo").font(.system(size: 22, weight: .light)).foregroundStyle(Theme.ink4)
    }
  }

  private func load() async {
    if let hit = MediaImageCache.cache.object(forKey: url as NSURL) { image = hit; return }
    let item = MediaSliderItem(id: url.absoluteString, url: url, title: name, kind: .image)
    guard let file = try? await MediaLoader(client: client).file(item), let img = PlatformImage(contentsOfFile: file.path) else { failed = true; return }
    MediaImageCache.cache.setObject(img, forKey: url as NSURL)
    fetched = true
    image = img
  }
}

/// Files the person sent with a message: photos as thumbnails, documents as small tagged chips.
struct SentAttachments: View {
  var items: [SentAttachment]
  var client: MercuryClient
  var body: some View {
    HStack(spacing: 6) {
      ForEach(Array(items.enumerated()), id: \.offset) { _, a in
        if a.isImage, let path = a.url, let url = client.uploadURL(path) {
          RemoteImage(client: client, url: url, name: a.name, fill: true)
            .frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line))
            .accessibilityLabel("Photo: \(a.name)")
        } else {
          FileChip(tag: Self.tag(a), name: a.name)
        }
      }
    }
  }

  static func tag(_ a: SentAttachment) -> String {
    if a.isImage { return "IMG" }
    if a.mime == "application/pdf" || a.name.lowercased().hasSuffix(".pdf") { return "PDF" }
    let n = a.name.lowercased()
    return n.hasSuffix(".md") || n.hasSuffix(".markdown") || a.mime == "text/markdown" ? "MD" : "TXT"
  }
}

/// "MD notes.md": a file in a message or the composer.
struct FileChip: View {
  var tag: String
  var name: String
  var onRemove: (() -> Void)?
  var body: some View {
    HStack(spacing: 7) {
      Text(tag).font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(tag == "PDF" ? Theme.red : Theme.ink2)
        .padding(.horizontal, 5).frame(height: 20)
        .background((tag == "PDF" ? Theme.red : Theme.ink).opacity(0.08), in: RoundedRectangle(cornerRadius: 5))
      Text(name).font(.system(size: 13)).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
      if let onRemove {
        Button(action: onRemove) { Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).frame(width: 20, height: 20) }
          .buttonStyle(IconButtonStyle()).accessibilityLabel("Remove \(name)")
      }
    }
    .padding(.leading, 6).padding(.trailing, onRemove == nil ? 10 : 4).frame(height: 32)
    .frame(maxWidth: 180, alignment: .leading)
    .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 9))
    .accessibilityElement(children: .combine)
  }
}

extension View {
  /// The full-screen slider: a cover on the phone, a sheet where covers don't exist.
  @ViewBuilder
  func mediaSlider<Item: Identifiable, Content: View>(item: Binding<Item?>, @ViewBuilder content: @escaping (Item) -> Content) -> some View {
    #if os(iOS)
    fullScreenCover(item: item, content: content)
    #else
    sheet(item: item, content: content)
    #endif
  }
}
