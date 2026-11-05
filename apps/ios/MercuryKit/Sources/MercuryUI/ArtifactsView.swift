import SwiftUI
import QuickLook
import MercuryCore

@MainActor @Observable
final class ArtifactsModel {
  var items: [ArtifactItem] = []
  var counts: [String: Int] = [:]
  var kind = "all"
  var query = ""
  var next: String?
  var loaded = false
  var error: String?
  let client: MercuryClient

  init(client: MercuryClient) { self.client = client }

  static let kinds: [(value: String, label: String)] = [("all", "All"), ("image", "Images"), ("pdf", "PDFs"), ("document", "Docs"), ("text", "Notes"), ("video", "Videos"), ("audio", "Audio")]

  func load() async {
    do {
      let page = try await client.artifacts(kind: kind, query: query)
      items = page.items; next = page.nextCursor; counts = page.counts ?? counts; error = nil
    } catch { self.error = error.localizedDescription }
    loaded = true
  }

  func more() async {
    guard let cursor = next else { return }
    if let page = try? await client.artifacts(kind: kind, query: query, cursor: cursor) {
      items += page.items; next = page.nextCursor
    }
  }
}

/// Screen 6: everything Mercury made, across every conversation.
struct ArtifactsView: View {
  @State var model: ArtifactsModel
  @State var preview: URL?
  @State var opening: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        KindFilter(model: model)
        if let e = model.error { ErrorText(text: e) }
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
          ForEach(model.items) { a in
            Button { Task { await open(a) } } label: { ArtifactTile(item: a, client: model.client, opening: opening == a.id) }
              .buttonStyle(.plain)
              .task { if a.id == model.items.last?.id { await model.more() } }
          }
        }
      }
      .padding(.horizontal, 16).padding(.bottom, 16)
    }
    .background(Theme.bg)
    .overlay {
      if model.loaded && model.items.isEmpty && model.error == nil {
        VStack(spacing: 10) {
          Image(systemName: "square.stack.3d.up").font(.system(size: 30)).foregroundStyle(Theme.ink3)
          Text(model.kind == "all" && model.query.isEmpty ? "Nothing made yet" : "Nothing matches").font(.system(size: 17, weight: .semibold))
          Text("Images, PDFs and reports Mercury makes show up here.").font(.system(size: 14)).foregroundStyle(Theme.ink2)
        }
      } else if !model.loaded { ProgressView() }
    }
    .navigationTitle("Artifacts")
    .searchable(text: $model.query, prompt: "Search by name")
    .onSubmit(of: .search) { Task { await model.load() } }
    .onChange(of: model.query) { if model.query.isEmpty { Task { await model.load() } } }
    .refreshable { await model.load() }
    .task { if !model.loaded { await model.load() } }
    .quickLookPreview($preview)
  }

  func open(_ a: ArtifactItem) async {
    opening = a.id
    defer { opening = nil }
    do { preview = try await model.client.download(a.id, name: a.name) }
    catch { model.error = error.localizedDescription }
  }
}

struct KindFilter: View {
  @Bindable var model: ArtifactsModel
  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        ForEach(ArtifactsModel.kinds, id: \.value) { k in
          let on = model.kind == k.value
          Button {
            model.kind = k.value
            Task { await model.load() }
          } label: {
            Text(k.label).font(.system(size: 14, weight: on ? .semibold : .medium))
              .foregroundStyle(on ? Theme.bg : Theme.ink2)
              .padding(.horizontal, 14).frame(height: 34)
              .background(on ? Theme.ink : .clear, in: Capsule())
              .overlay(Capsule().stroke(on ? .clear : Theme.line))
          }
          .buttonStyle(.plain)
          .accessibilityAddTraits(on ? .isSelected : [])
        }
      }
    }
  }
}

struct ArtifactTile: View {
  var item: ArtifactItem
  var client: MercuryClient
  var opening = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ZStack {
        Theme.surface2
        if item.kind == "image" {
          AuthImage(client: client, path: "/api/artifacts/\(item.id)/file")
        } else {
          Image(systemName: ArtifactCard.icon(item.kind, item.mime)).font(.system(size: 30)).foregroundStyle(Theme.accent)
        }
        if opening { ProgressView() }
      }
      .frame(height: 118).clipped()
      VStack(alignment: .leading, spacing: 3) {
        Text(item.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
        Text(item.threadTitle ?? ArtifactCard.caption(ArtifactRef(id: item.id, name: item.name, kind: item.kind, mime: item.mime, size: item.size)))
          .font(.system(size: 12)).foregroundStyle(Theme.ink3).lineLimit(1)
      }
      .padding(.horizontal, 10).padding(.vertical, 10)
    }
    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
    .clipShape(RoundedRectangle(cornerRadius: 16))
    .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.line))
    .accessibilityElement(children: .combine)
    .accessibilityHint("Opens a preview")
  }
}

/// An image that needs the Bearer token, so AsyncImage can't load it.
struct AuthImage: View {
  var client: MercuryClient
  var path: String
  @State var image: Image?

  var body: some View {
    Group {
      if let image { image.resizable().scaledToFill() } else { Color.clear }
    }
    .task(id: path) {
      guard let data = try? await client.data(path) else { return }
      #if canImport(UIKit)
      if let ui = UIImage(data: data) { image = Image(uiImage: ui) }
      #else
      if let ns = NSImage(data: data) { image = Image(nsImage: ns) }
      #endif
    }
  }
}
