import SwiftUI
import QuickLook
import MercuryCore

@MainActor @Observable
final class ArtifactsModel {
  var items: [ArtifactItem] = [] { didSet { groups = ArtifactGroup.group(items) } }
  /// Cards: batches (images made together) are one.
  private(set) var groups: [ArtifactGroup] = []
  var counts: [String: Int] = [:]
  var kind = "all"
  var query = ""
  var next: String?
  var loaded = false
  var error: String?
  /// Space taken, as the server counts it (the ⋯ menu and Clean up).
  var usage: ArtifactUsage?
  /// Select mode: ticked artifact ids (a batch ticks all of its own).
  var picking = false
  var picked: Set<String> = []
  var deleting = false
  /// What the last delete did ("3 deleted, 4.2 MB freed.").
  var note: String?
  let client: MercuryClient

  init(client: MercuryClient) { self.client = client }

  /// Same tabs as Mercury Desktop; a kind shows once there is something in it.
  static let kinds: [(value: String, label: String)] = [
    ("all", "All"), ("image", "Images"), ("video", "Videos"), ("audio", "Audio"),
    ("pdf", "PDFs"), ("document", "Documents"), ("text", "Notes"), ("file", "Files"),
  ]

  var shownKinds: [(value: String, label: String)] {
    Self.kinds.filter { $0.value == "all" || $0.value == kind || (counts[$0.value] ?? 0) > 0 }
  }

  func load() async {
    async let usage = try? client.artifactUsage()
    do {
      let page = try await client.artifacts(kind: kind, query: query)
      items = page.items; next = page.nextCursor; counts = page.counts ?? counts; error = nil
    } catch { self.error = error.localizedDescription }
    if let u = await usage { self.usage = u }
    loaded = true
  }

  func more() async {
    guard let cursor = next else { return }
    if let page = try? await client.artifacts(kind: kind, query: query, cursor: cursor) {
      items += page.items; next = page.nextCursor
    }
  }

  func refreshUsage() async {
    if let u = try? await client.artifactUsage() { usage = u }
  }

  // MARK: Select

  func isPicked(_ g: ArtifactGroup) -> Bool { g.items.allSatisfy { picked.contains($0.id) } }

  func toggle(_ g: ArtifactGroup) {
    if isPicked(g) { picked.subtract(g.ids) } else { picked.formUnion(g.ids) }
  }

  var pickedItems: [ArtifactItem] { items.filter { picked.contains($0.id) } }
  var pickedBytes: Int { pickedItems.reduce(0) { $0 + ($1.size ?? 0) } }
  /// Cards ticked (a batch counts as one), for "3 selected".
  var pickedCards: Int { groups.filter(isPicked).count }

  func startPicking(with g: ArtifactGroup? = nil) {
    note = nil; picked = Set(g?.ids ?? []); picking = true
  }

  func stopPicking() { picking = false; picked = [] }

  // MARK: Delete

  /// Deletes for real: Mercury's own files go, files in the person's projects stay.
  func delete(_ ids: [String]) async {
    guard !ids.isEmpty else { return }
    deleting = true
    defer { deleting = false }
    do {
      let r = ids.count == 1 ? try await client.deleteArtifact(ids[0]) : try await client.deleteArtifacts(.ids(ids))
      removeLocally(ids)
      note = r.summary
      if picking { stopPicking() }
      await load()
    } catch { self.error = error.localizedDescription }
  }

  /// One deleted from the full-screen viewer; throws so the viewer keeps it on failure.
  func deleteOne(_ id: String) async throws {
    let r = try await client.deleteArtifact(id)
    removeLocally([id])
    note = r.summary
    await refreshUsage()
  }

  private func removeLocally(_ ids: [String]) {
    let gone = Set(ids)
    for a in items where gone.contains(a.id) {
      counts[a.kind] = max((counts[a.kind] ?? 1) - 1, 0)
      counts["all"] = max((counts["all"] ?? 1) - 1, 0)
    }
    items.removeAll { gone.contains($0.id) }
  }
}

/// Screen 6: everything Mercury made, across every conversation.
struct ArtifactsView: View {
  @State var model: ArtifactsModel
  @State var preview: URL?
  @State var opening: String?
  @State var viewing: SliderRequest?
  @State var cleaningUp = false
  @State var confirmDelete: ArtifactGroup?
  @State var confirmPicked = false

  struct SliderRequest: Identifiable {
    let id = UUID()
    var items: [MediaSliderItem]
    var start: Int
  }

  var body: some View {
    ScrollView {
      ArtifactsContent(model: model, opening: opening, open: { g, i in Task { await open(g, at: i) } }, askDelete: { confirmDelete = $0 })
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
    .safeAreaInset(edge: .bottom) { if model.picking { ArtifactPickBar(model: model) { confirmPicked = true } } }
    .navigationTitle("Artifacts")
    .toolbar { toolbar }
    .searchable(text: $model.query, prompt: "Search by name")
    .onSubmit(of: .search) { Task { await model.load() } }
    .onChange(of: model.query) { if model.query.isEmpty { Task { await model.load() } } }
    .refreshable { await model.load() }
    .task { if !model.loaded { await model.load() } }
    .quickLookPreview($preview)
    .sheet(isPresented: $cleaningUp) {
      ArtifactCleanupSheet(model: model)
    }
    .mediaCover(item: $viewing) { v in
      MediaSlider(items: v.items, start: v.start, client: model.client,
                  onDelete: { item in try await model.deleteOne(item.id) },
                  deleteMessage: { item in model.items.first { $0.id == item.id }.map(ArtifactFormat.deleteDetail) ?? "Deletes the file." })
    }
    .confirmationDialog(confirmDelete.map(deleteTitle) ?? "", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }), titleVisibility: .visible, presenting: confirmDelete) { g in
      Button(g.lead.keepsOriginal && !g.isBatch ? "Remove from Mercury" : "Delete", role: .destructive) { Task { await model.delete(g.ids) } }
    } message: { g in
      Text(ArtifactFormat.deleteDetail(g.items))
    }
    .confirmationDialog("Delete \(model.pickedCards)?", isPresented: $confirmPicked, titleVisibility: .visible) {
      Button("Delete", role: .destructive) { Task { await model.delete(Array(model.picked)) } }
    } message: {
      Text(ArtifactFormat.deleteDetail(model.pickedItems) + " " + ArtifactFormat.bytes(model.pickedBytes) + " in all.")
    }
  }

  func deleteTitle(_ g: ArtifactGroup) -> String {
    g.isBatch ? "Delete \(ArtifactFormat.batchLabel(g.items))?" : ArtifactFormat.deleteTitle(g.lead)
  }

  @ToolbarContentBuilder var toolbar: some ToolbarContent {
    ToolbarItem(placement: .primaryAction) {
      if model.picking {
        Button("Done") { model.stopPicking() }.fontWeight(.semibold)
      } else {
        Menu {
          if let u = model.usage {
            Section { Text("Storage · \(ArtifactFormat.bytes(u.bytes))") }
          }
          Section {
            Button { model.startPicking() } label: { Label("Select…", systemImage: "checkmark.circle") }
              .disabled(model.items.isEmpty)
          }
          Button { cleaningUp = true } label: { Label("Clean up…", systemImage: "internaldrive") }
        } label: {
          Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("More: storage and clean up")
      }
    }
  }

  func open(_ g: ArtifactGroup, at i: Int) async {
    if g.items.allSatisfy(\.isMedia) {
      viewing = SliderRequest(items: g.items.map { $0.sliderItem(model.client) }, start: i)
      return
    }
    let a = g.items[i]
    opening = a.id
    defer { opening = nil }
    do { preview = try await model.client.download(a.id, name: a.name) }
    catch { model.error = error.localizedDescription }
  }
}

/// Select mode's bar: how many are ticked and their size, select all / clear, and Delete.
struct ArtifactPickBar: View {
  @Bindable var model: ArtifactsModel
  var delete: () -> Void
  var body: some View {
    VStack(spacing: 10) {
      Text(model.picked.isEmpty ? "Select artifacts to delete" : "\(model.pickedCards) selected · \(ArtifactFormat.bytes(model.pickedBytes))")
        .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.ink)
      HStack(spacing: 10) {
        Button {
          if model.picked.isEmpty { model.picked = Set(model.items.map(\.id)) } else { model.picked = [] }
        } label: {
          Text(model.picked.isEmpty ? "Select all shown" : "Clear")
            .font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.ink2)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 12))
        }
        .disabled(model.items.isEmpty)
        Button(action: delete) {
          HStack(spacing: 6) {
            if model.deleting { ProgressView() } else { Image(systemName: "trash") }
            Text("Delete")
          }
          .font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
          .frame(maxWidth: .infinity, minHeight: 44)
          .background(Theme.red.opacity(model.picked.isEmpty ? 0.35 : 1), in: RoundedRectangle(cornerRadius: 12))
        }
        .disabled(model.picked.isEmpty || model.deleting)
      }
      .buttonStyle(.plain)
    }
    .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 8)
    .background(.bar)
  }
}

/// The list itself (filters, the last delete's note, the cards), apart from the ScrollView so the
/// Snapshots renderer can draw it.
struct ArtifactsContent: View {
  @Bindable var model: ArtifactsModel
  var opening: String?
  var open: (ArtifactGroup, Int) -> Void = { _, _ in }
  var askDelete: (ArtifactGroup) -> Void = { _ in }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      KindFilter(model: model)
      if let e = model.error { ErrorText(text: e) }
      if let note = model.note, !model.picking {
        HStack(spacing: 8) {
          Image(systemName: "checkmark.circle.fill")
          Text(note).frame(maxWidth: .infinity, alignment: .leading)
          Button { model.note = nil } label: { Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.ink3) }
            .buttonStyle(.plain).accessibilityLabel("Dismiss")
        }
        .font(.system(size: 13)).foregroundStyle(Theme.accent)
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Theme.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
      }
      LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
        ForEach(model.groups) { g in
          Button {
            if model.picking { model.toggle(g) } else { open(g, 0) }
          } label: {
            ArtifactTile(group: g, client: model.client, opening: g.items.contains { $0.id == opening },
                         picking: model.picking, picked: model.isPicked(g))
          }
          .buttonStyle(.plain)
          .contextMenu {
            if !model.picking {
              Button { open(g, 0) } label: { Label(g.isBatch ? "Open \(ArtifactFormat.batchLabel(g.items))" : "Open", systemImage: "eye") }
              Button { model.startPicking(with: g) } label: { Label("Select", systemImage: "checkmark.circle") }
              Button(role: .destructive) { askDelete(g) } label: {
                Label(g.lead.keepsOriginal && !g.isBatch ? "Remove from Mercury" : "Delete", systemImage: "trash")
              }
            }
          }
          .task { if g.id == model.groups.last?.id { await model.more() } }
        }
      }
    }
  }
}

struct KindFilter: View {
  @Bindable var model: ArtifactsModel
  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        ForEach(model.shownKinds, id: \.value) { k in
          let on = model.kind == k.value
          let n = model.counts[k.value]
          Button {
            model.kind = k.value
            Task { await model.load() }
          } label: {
            HStack(spacing: 5) {
              Text(k.label).font(.system(size: 14, weight: on ? .semibold : .medium))
              if let n { Text("\(n)").font(.system(size: 12, weight: .medium).monospacedDigit()).opacity(0.6) }
            }
            .foregroundStyle(on ? Theme.bg : Theme.ink2)
            .padding(.horizontal, 14).frame(height: 34)
            .background(on ? Theme.ink : .clear, in: Capsule())
            .overlay(Capsule().stroke(on ? .clear : Theme.line))
          }
          .buttonStyle(.plain)
          .accessibilityLabel(n.map { "\(k.label), \($0)" } ?? k.label)
          .accessibilityAddTraits(on ? .isSelected : [])
        }
      }
    }
  }
}

/// A card: one artifact, or a batch made together (a mosaic of its first four and a count).
struct ArtifactTile: View {
  var group: ArtifactGroup
  var client: MercuryClient
  var opening = false
  var picking = false
  var picked = false

  init(group: ArtifactGroup, client: MercuryClient, opening: Bool = false, picking: Bool = false, picked: Bool = false) {
    self.group = group; self.client = client; self.opening = opening; self.picking = picking; self.picked = picked
  }

  init(item: ArtifactItem, client: MercuryClient, opening: Bool = false) {
    self.init(group: ArtifactGroup(items: [item]), client: client, opening: opening)
  }

  var item: ArtifactItem { group.lead }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ZStack {
        Theme.surface2
        if group.isBatch { ArtifactMosaic(items: group.items, client: client) } else { ArtifactThumb(item: item, client: client, badge: !picking) }
        if opening { ProgressView() }
      }
      .frame(height: 118).clipped()
      .overlay(alignment: .topTrailing) {
        if group.isBatch {
          Label("\(group.items.count)", systemImage: "square.stack")
            .font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.ink2)
            .padding(.horizontal, 7).frame(height: 22)
            .background(Theme.surface.opacity(0.92), in: RoundedRectangle(cornerRadius: 7))
            .padding(8)
        }
      }
      .overlay(alignment: .topLeading) {
        if picking {
          Image(systemName: picked ? "checkmark.circle.fill" : "circle")
            .font(.system(size: 22, weight: .medium))
            .foregroundStyle(picked ? Theme.accent : .white, picked ? Theme.surface : .black.opacity(0.25))
            .shadow(color: .black.opacity(0.25), radius: 2)
            .padding(8)
        }
      }
      VStack(alignment: .leading, spacing: 3) {
        Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
        Text(caption).font(.system(size: 12)).foregroundStyle(Theme.ink3).lineLimit(1)
        if let t = item.threadTitle, !t.isEmpty {
          Text(t).font(.system(size: 12)).foregroundStyle(Theme.ink4).lineLimit(1)
        }
      }
      .padding(.horizontal, 10).padding(.vertical, 10)
    }
    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
    .clipShape(RoundedRectangle(cornerRadius: 16))
    .overlay(RoundedRectangle(cornerRadius: 16).stroke(picked ? Theme.accent.opacity(0.7) : Theme.line, lineWidth: picked ? 2 : 1))
    .accessibilityElement(children: .combine)
    .accessibilityLabel(picking ? "\(picked ? "Selected" : "Select"): \(title)" : group.isBatch ? "Open \(ArtifactFormat.batchLabel(group.items)): \(title)" : title)
    .accessibilityHint(picking ? "" : group.isBatch ? "Steps through them full screen" : "Opens a preview")
    .accessibilityAddTraits(picked ? .isSelected : [])
  }

  var title: String {
    group.isBatch ? (item.prompt?.isEmpty == false ? item.prompt! : ArtifactFormat.batchLabel(group.items)) : item.name
  }

  /// "4 images · 6.1 MB · Nov 3", or "PNG · 1.2 MB · 14:02".
  var caption: String {
    let when = ArtifactFormat.when(item.createdAt)
    let lead = group.isBatch
      ? "\(ArtifactFormat.batchLabel(group.items)) · \(ArtifactFormat.bytes(group.size))"
      : [item.ext.uppercased(), item.size.map(ArtifactFormat.bytes)].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
    return when.isEmpty ? lead : "\(lead) · \(when)"
  }
}

/// A batch's cover: its first four, as a mosaic (the first is tall when there are three).
struct ArtifactMosaic: View {
  var items: [ArtifactItem]
  var client: MercuryClient
  var body: some View {
    let shown = Array(items.prefix(4))
    GeometryReader { geo in
      let w = (geo.size.width - 1) / 2, h = (geo.size.height - 1) / 2
      Group {
        switch shown.count {
        case 2:
          HStack(spacing: 1) { ForEach(shown) { cell($0).frame(width: w) } }
        case 3:
          HStack(spacing: 1) {
            cell(shown[0]).frame(width: w)
            VStack(spacing: 1) { cell(shown[1]).frame(height: h); cell(shown[2]).frame(height: h) }.frame(width: w)
          }
        default:
          VStack(spacing: 1) {
            HStack(spacing: 1) { cell(shown[0]).frame(width: w); cell(shown[1]).frame(width: w) }.frame(height: h)
            HStack(spacing: 1) { cell(shown[2]).frame(width: w); cell(shown[3]).frame(width: w) }.frame(height: h)
          }
        }
      }
      .background(Theme.line)
    }
  }

  func cell(_ a: ArtifactItem) -> some View {
    ArtifactThumb(item: a, client: client, compact: true).clipped()
  }
}

/// A picture for images; for anything else, its icon and file type (a play badge on videos).
struct ArtifactThumb: View {
  var item: ArtifactItem
  var client: MercuryClient
  var compact = false
  /// The file type in the corner (hidden in Select mode, where the tick goes).
  var badge = true
  var body: some View {
    ZStack {
      Theme.surface2
      if item.kind == "image" {
        AuthImage(client: client, path: "/api/artifacts/\(item.id)/file")
      } else {
        Image(systemName: ArtifactCard.icon(item.kind, item.mime)).font(.system(size: compact ? 18 : 30)).foregroundStyle(Theme.accent)
        if !compact {
          if badge && !item.ext.isEmpty {
            Text(item.ext.uppercased()).font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(Theme.ink3)
              .padding(.horizontal, 5).frame(height: 18)
              .background(Theme.surface.opacity(0.9), in: RoundedRectangle(cornerRadius: 5))
              .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).padding(8)
          }
          if item.kind == "video" {
            Image(systemName: "play.fill").font(.system(size: 11)).foregroundStyle(Theme.ink3)
              .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing).padding(9)
          }
        }
      }
    }
  }
}

/// An image that needs the Bearer token, so AsyncImage can't load it. Kept in memory, so the
/// list, the mosaic and scrolling back don't load it twice.
struct AuthImage: View {
  var client: MercuryClient
  var path: String
  @State var image: Image?

  @MainActor static var cache: [String: Image] = [:]

  var body: some View {
    Group {
      if let shown = image ?? Self.cache[path] { shown.resizable().scaledToFill() } else { Color.clear }
    }
    .task(id: path) {
      if let hit = Self.cache[path] { image = hit; return }
      guard let data = try? await client.data(path) else { return }
      #if canImport(UIKit)
      guard let ui = UIImage(data: data)?.preparingThumbnail(of: CGSize(width: 600, height: 600)) ?? UIImage(data: data) else { return }
      let img = Image(uiImage: ui)
      #else
      guard let ns = NSImage(data: data) else { return }
      let img = Image(nsImage: ns)
      #endif
      if Self.cache.count > 300 { Self.cache.removeAll() }
      Self.cache[path] = img
      image = img
    }
  }
}

extension ArtifactItem {
  var isMedia: Bool { kind == "image" || kind == "video" || kind == "audio" }
  var ext: String { (name as NSString).pathExtension }

  func sliderItem(_ client: MercuryClient) -> MediaSliderItem {
    MediaSliderItem(id: id, url: client.artifactFileURL(id), title: name,
                    kind: kind == "video" ? .video : kind == "audio" ? .audio : .image)
  }
}

extension View {
  /// Full screen on the phone; a sheet where full-screen covers don't exist (the macOS build).
  @ViewBuilder func mediaCover<Item: Identifiable, Content: View>(item: Binding<Item?>, @ViewBuilder content: @escaping (Item) -> Content) -> some View {
    #if os(iOS)
    fullScreenCover(item: item, content: content)
    #else
    sheet(item: item, content: content)
    #endif
  }
}
