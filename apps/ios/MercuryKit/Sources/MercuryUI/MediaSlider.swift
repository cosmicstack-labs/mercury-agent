import SwiftUI
import AVKit
import MercuryCore

/// One picture, video or sound in a MediaSlider.
public struct MediaSliderItem: Identifiable, Hashable {
  public let id: String
  /// A Mercury URL (GET /api/artifacts/:id/file; the slider adds the device token) or a local file.
  public let url: URL
  public let title: String?
  public let kind: Kind
  public enum Kind: Hashable { case image, video, audio }

  public init(id: String, url: URL, title: String? = nil, kind: Kind = .image) {
    self.id = id; self.url = url; self.title = title; self.kind = kind
  }
}

/// The client MediaSlider loads Mercury URLs with (the device token). Screens that show a slider
/// set it once with `.environment(\.mercuryClient, client)`, or pass `client:` to the slider.
private struct MercuryClientKey: EnvironmentKey { static let defaultValue: MercuryClient? = nil }
extension EnvironmentValues {
  public var mercuryClient: MercuryClient? {
    get { self[MercuryClientKey.self] }
    set { self[MercuryClientKey.self] = newValue }
  }
}

/// Full-screen viewer for pictures, videos and sounds, the phone's version of Mercury Desktop's
/// Lightbox: swipe between them, "3 / 5", a strip of thumbnails to jump, the current picture
/// blurred behind it, share, and (when the caller allows it) delete. Present it with
/// `.fullScreenCover`; it closes itself.
public struct MediaSlider: View {
  @State private var items: [MediaSliderItem]
  @State private var index: Int
  @State private var sharing: SharedFile?
  @State private var preparingShare = false
  @State private var confirmDelete = false
  @State private var error: String?
  @State private var chrome = true
  @Environment(\.dismiss) private var dismiss
  @Environment(\.mercuryClient) private var envClient

  private let client: MercuryClient?
  private let onDelete: ((MediaSliderItem) async throws -> Void)?
  private let deleteMessage: (MediaSliderItem) -> String

  public init(items: [MediaSliderItem], start: Int) {
    self.init(items: items, start: start, client: nil)
  }

  /// - Parameters:
  ///   - client: loads Mercury URLs with the device token (else `\.mercuryClient` from the environment).
  ///   - onDelete: shows Delete; called after the person confirms. Throw to keep the item.
  ///   - deleteMessage: what the confirmation says about this item.
  public init(items: [MediaSliderItem], start: Int, client: MercuryClient?,
              onDelete: ((MediaSliderItem) async throws -> Void)? = nil,
              deleteMessage: @escaping (MediaSliderItem) -> String = { _ in "This can't be undone." }) {
    _items = State(initialValue: items)
    _index = State(initialValue: min(max(start, 0), max(items.count - 1, 0)))
    self.client = client; self.onDelete = onDelete; self.deleteMessage = deleteMessage
  }

  private var loader: MediaLoader { MediaLoader(client: client ?? envClient) }
  private var current: MediaSliderItem? { items.indices.contains(index) ? items[index] : nil }

  public var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      if let current, current.kind == .image {
        // In an overlay on a clear layer: a filled image would otherwise size the whole screen past its edges.
        Color.clear
          .overlay { MediaImage(item: current, loader: loader, fill: true).blur(radius: 50).opacity(0.55) }
          .clipped()
          .overlay(Color.black.opacity(0.35))
          .ignoresSafeArea()
          .animation(.easeInOut(duration: 0.25), value: current.id)
          .accessibilityHidden(true)
      }
      pages
      if chrome { overlayChrome.transition(.opacity) }
    }
    .environment(\.colorScheme, .dark)
    .statusBarHiddenCompat(!chrome)
    .confirmationDialog("Delete this?", isPresented: $confirmDelete, titleVisibility: .visible) {
      Button("Delete", role: .destructive) { Task { await deleteCurrent() } }
    } message: {
      if let current { Text(deleteMessage(current)) }
    }
    #if canImport(UIKit)
    .sheet(item: $sharing) { f in ShareSheet(url: f.url).presentationDetents([.medium, .large]) }
    #endif
  }

  // MARK: Pages

  @ViewBuilder private var pages: some View {
    #if os(iOS)
    TabView(selection: $index) {
      ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
        MediaPage(item: item, loader: loader, active: i == index, chrome: $chrome).tag(i)
      }
    }
    .tabViewStyle(.page(indexDisplayMode: .never))
    .ignoresSafeArea()
    #else
    if let current { MediaPage(item: current, loader: loader, active: true, chrome: $chrome) }
    #endif
  }

  // MARK: Chrome

  private var overlayChrome: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        RoundButton(icon: "xmark", label: "Close") { dismiss() }
        Spacer()
        if items.count > 1 {
          Text("\(index + 1) / \(items.count)")
            .font(.system(size: 14, weight: .semibold).monospacedDigit()).foregroundStyle(.white)
            .padding(.horizontal, 12).frame(height: 32).background(.black.opacity(0.35), in: Capsule())
            .accessibilityLabel("\(index + 1) of \(items.count)")
        }
        Spacer()
        if onDelete != nil { RoundButton(icon: "trash", label: "Delete") { confirmDelete = true } }
        RoundButton(icon: preparingShare ? nil : "square.and.arrow.up", label: "Share") { Task { await share() } }
      }
      .padding(.horizontal, 16).padding(.top, 8)
      Spacer()
      VStack(alignment: .leading, spacing: 10) {
        if let e = error {
          Text(e).font(.system(size: 13)).foregroundStyle(Theme.red)
        }
        if let title = current?.title, !title.isEmpty {
          Text(title).font(.system(size: 14, weight: .medium)).foregroundStyle(.white.opacity(0.92)).lineLimit(2)
        }
        if items.count > 1 { strip }
      }
      .padding(.horizontal, 16).padding(.bottom, 12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(LinearGradient(colors: [.clear, .black.opacity(0.55)], startPoint: .top, endPoint: .bottom).ignoresSafeArea())
    }
  }

  private var strip: some View {
    ScrollViewReader { proxy in
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
            Button { withAnimation(.easeInOut(duration: 0.2)) { index = i } } label: {
              MediaThumb(item: item, loader: loader)
                .frame(width: 48, height: 48).clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(i == index ? Theme.accent : .white.opacity(0.15), lineWidth: i == index ? 2 : 1))
                .opacity(i == index ? 1 : 0.65)
            }
            .buttonStyle(.plain).id(item.id)
            .accessibilityLabel(item.title ?? "Item \(i + 1)")
            .accessibilityAddTraits(i == index ? .isSelected : [])
          }
        }
        .padding(2)
      }
      .onChange(of: index) { if let id = current?.id { withAnimation { proxy.scrollTo(id, anchor: .center) } } }
      .onAppear { if let id = current?.id { proxy.scrollTo(id, anchor: .center) } }
    }
  }

  // MARK: Actions

  private func share() async {
    guard let current, !preparingShare else { return }
    preparingShare = true
    defer { preparingShare = false }
    do { sharing = SharedFile(url: try await loader.file(current)); error = nil }
    catch { self.error = "Couldn't get it to share: \(error.localizedDescription)" }
  }

  private func deleteCurrent() async {
    guard let current, let onDelete else { return }
    do {
      try await onDelete(current)
      items.removeAll { $0.id == current.id }
      error = nil
      if items.isEmpty { dismiss() } else { index = min(index, items.count - 1) }
    } catch { self.error = error.localizedDescription }
  }
}

// MARK: - Loading

/// Loads slider media: Mercury URLs with the device token, cached on disk so share and
/// the thumbnails reuse one download.
struct MediaLoader {
  var client: MercuryClient?

  func file(_ item: MediaSliderItem) async throws -> URL {
    if item.url.isFileURL { return item.url }
    let name = item.title.map { MediaLoader.fileName($0, item: item) }
    if let client { return try await client.cachedFile(item.url, name: name) }
    return try await MercuryClient(baseURL: item.url).cachedFile(item.url, name: name)
  }

  /// A player for video and sound: streamed (the server answers Range requests), with the token.
  func asset(_ item: MediaSliderItem) -> AVURLAsset {
    let headers = client?.headers(for: item.url) ?? [:]
    return AVURLAsset(url: item.url, options: headers.isEmpty ? nil : ["AVURLAssetHTTPHeaderFieldsKey": headers])
  }

  /// A share-friendly name: the title, with an extension when it has none.
  static func fileName(_ title: String, item: MediaSliderItem) -> String {
    let clean = title.replacingOccurrences(of: "/", with: "-")
    if !(clean as NSString).pathExtension.isEmpty { return clean }
    switch item.kind {
    case .image: return clean + ".png"
    case .video: return clean + ".mp4"
    case .audio: return clean + ".mp3"
    }
  }
}

#if canImport(UIKit)
typealias PlatformImage = UIImage
#else
typealias PlatformImage = NSImage
#endif

extension Image {
  init(platform: PlatformImage) {
    #if canImport(UIKit)
    self.init(uiImage: platform)
    #else
    self.init(nsImage: platform)
    #endif
  }
}

/// Decoded images, kept while memory allows, so swiping back doesn't reload.
@MainActor enum MediaImageCache {
  static let cache = NSCache<NSURL, PlatformImage>()
}

struct MediaImage: View {
  var item: MediaSliderItem
  var loader: MediaLoader
  var fill = false
  @State private var image: PlatformImage?
  @State private var failed = false

  var body: some View {
    Group {
      if let shown = image ?? MediaImageCache.cache.object(forKey: item.url as NSURL) {
        Image(platform: shown).resizable().aspectRatio(contentMode: fill ? .fill : .fit)
      } else if failed {
        Image(systemName: "photo").font(.system(size: 34)).foregroundStyle(.white.opacity(0.4))
      } else {
        Color.clear
      }
    }
    .task(id: item.url) { await load() }
  }

  private func load() async {
    if let hit = MediaImageCache.cache.object(forKey: item.url as NSURL) { image = hit; return }
    guard let url = try? await loader.file(item), let img = PlatformImage(contentsOfFile: url.path) else { failed = true; return }
    MediaImageCache.cache.setObject(img, forKey: item.url as NSURL)
    image = img
  }
}

private struct MediaThumb: View {
  var item: MediaSliderItem
  var loader: MediaLoader
  var body: some View {
    ZStack {
      Color.white.opacity(0.08)
      switch item.kind {
      case .image: MediaImage(item: item, loader: loader, fill: true)
      case .video: Image(systemName: "play.fill").font(.system(size: 16)).foregroundStyle(.white.opacity(0.8))
      case .audio: Image(systemName: "waveform").font(.system(size: 16)).foregroundStyle(.white.opacity(0.8))
      }
    }
  }
}

/// One page: a zoomable picture, or a player.
private struct MediaPage: View {
  var item: MediaSliderItem
  var loader: MediaLoader
  var active: Bool
  @Binding var chrome: Bool
  @State private var scale: CGFloat = 1
  @State private var base: CGFloat = 1
  @State private var offset: CGSize = .zero
  @State private var lastOffset: CGSize = .zero

  var body: some View {
    switch item.kind {
    case .image:
      MediaImage(item: item, loader: loader)
        .scaleEffect(scale).offset(offset)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .gesture(MagnifyGesture()
          .onChanged { scale = min(max(base * $0.magnification, 1), 5) }
          .onEnded { _ in base = scale; if scale <= 1.01 { reset() } })
        .simultaneousGesture(scale > 1 ? DragGesture()
          .onChanged { offset = CGSize(width: lastOffset.width + $0.translation.width, height: lastOffset.height + $0.translation.height) }
          .onEnded { _ in lastOffset = offset } : nil)
        .onTapGesture(count: 2) { withAnimation(.spring(duration: 0.3)) { if scale > 1 { reset() } else { scale = 2.5; base = 2.5 } } }
        .onTapGesture { withAnimation(.easeInOut(duration: 0.2)) { chrome.toggle() } }
        .onChange(of: active) { if !active { reset() } }
        .accessibilityLabel(item.title ?? "Picture")
        .accessibilityAddTraits(.isImage)
    case .video, .audio:
      MediaPlayerPage(item: item, loader: loader, active: active)
    }
  }

  private func reset() { scale = 1; base = 1; offset = .zero; lastOffset = .zero }
}

private struct MediaPlayerPage: View {
  var item: MediaSliderItem
  var loader: MediaLoader
  var active: Bool
  @State private var player: AVPlayer?

  var body: some View {
    ZStack {
      if item.kind == .audio {
        VStack(spacing: 14) {
          Image(systemName: "waveform").font(.system(size: 54, weight: .light)).foregroundStyle(Theme.accent)
          if let t = item.title { Text(t).font(.system(size: 15, weight: .medium)).foregroundStyle(.white.opacity(0.85)).lineLimit(2).multilineTextAlignment(.center) }
        }
        .padding(.horizontal, 32)
      }
      if let player {
        VideoPlayer(player: player)
          .frame(maxHeight: item.kind == .audio ? 120 : .infinity)
          .frame(maxHeight: .infinity, alignment: item.kind == .audio ? .bottom : .center)
          .padding(.bottom, item.kind == .audio ? 140 : 0)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .onAppear { if player == nil { player = AVPlayer(playerItem: AVPlayerItem(asset: loader.asset(item))) } }
    .onChange(of: active) { if !active { player?.pause() } }
    .onDisappear { player?.pause() }
  }
}

// MARK: - Bits

private struct RoundButton: View {
  var icon: String?
  var label: String
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      Group {
        if let icon { Image(systemName: icon).font(.system(size: 15, weight: .semibold)) } else { ProgressView().tint(.white) }
      }
      .foregroundStyle(.white).frame(width: 38, height: 38)
      .background(.black.opacity(0.35), in: Circle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }
}

extension View {
  @ViewBuilder func statusBarHiddenCompat(_ hidden: Bool) -> some View {
    #if os(iOS)
    statusBarHidden(hidden)
    #else
    self
    #endif
  }
}

/// A file to share, as a sheet item.
struct SharedFile: Identifiable { let url: URL; var id: String { url.absoluteString } }

#if canImport(UIKit)
struct ShareSheet: UIViewControllerRepresentable {
  var url: URL
  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: [url], applicationActivities: nil)
  }
  func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
#endif
