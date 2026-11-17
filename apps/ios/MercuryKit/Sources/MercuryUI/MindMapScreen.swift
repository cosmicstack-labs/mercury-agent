import SwiftUI
import MercuryCore
#if canImport(UIKit)
import UIKit
#endif

/// Brain → Mind map: every note a dot, every "related" link a line, dots coloured by theme and sized
/// by connections (Mercury Desktop's NoteWeb, same layout and look). Tap a dot to light its
/// neighbourhood and open the note; hold and drag a dot to pin it; pinch and pan to move around.
/// The chrome floats over the map on glass, like the rest of the app; the dots keep their theme hues.
struct MindMapScreen: View {
  @Bindable var model: MindMapModel
  var still = false
  var onClose: () -> Void = {}
  @FocusState private var filtering: Bool

  var body: some View {
    ZStack {
      Theme.bg.ignoresSafeArea()
      MindMapCanvas(model: model, still: still).ignoresSafeArea()
      #if os(iOS)
      if !still { MindMapGestures(model: model).ignoresSafeArea() }
      #endif
      states
      VStack(spacing: 0) {
        topBar
        Spacer(minLength: 0)
        bottomBar
      }
    }
    .onAppear { model.appear() }
    .onDisappear { model.disappear() }
    .sheet(isPresented: $model.showSettings) { MindMapSettings(model: model) }
    .sheet(isPresented: $model.showDetail) {
      if let id = model.selected {
        MindMapNoteSheet(model: model, id: id)
          .presentationDetents([.medium, .large])
          .presentationBackgroundInteraction(.enabled(upThrough: .medium))
          .presentationContentInteraction(.scrolls)
      }
    }
    #if os(iOS)
    .toolbar(.hidden, for: .navigationBar)
    #endif
  }

  // MARK: Chrome

  private var topBar: some View {
    VStack(alignment: .leading, spacing: 8) {
      GlassGroup(spacing: 8) {
        HStack(spacing: 8) {
          RoundIconButton(icon: "chevron.left", label: "Back", size: 44, action: onClose)
          filter
          RoundIconButton(icon: "arrow.clockwise", label: "Reload", size: 44) { Task { await model.load() } }
            .overlay { if model.loading && model.data != nil { ProgressView().controlSize(.small).allowsHitTesting(false) } }
          RoundIconButton(icon: "slider.horizontal.3", label: "Graph settings", size: 44) { model.openSettings() }
        }
      }
      HStack(spacing: 8) {
        if model.data != nil {
          Text(verbatim: "\(model.graph.nodes.count) notes · \(model.graph.links.count) links")
            .font(.system(size: 13)).foregroundStyle(Theme.ink3).monospacedDigit()
            .padding(.horizontal, 12).frame(height: 32)
            .glassSurface(in: Capsule())
        }
        if let local = model.local {
          localChip(local)
        } else if model.selected != nil {
          Button { model.local = LocalGraph(id: model.selected!, depth: 1) } label: {
            Label("Local graph", systemImage: "scope").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink)
              .padding(.horizontal, 12).frame(height: 32).contentShape(Capsule())
          }
          .buttonStyle(PressButtonStyle())
          .glassSurface(in: Capsule(), interactive: true)
        }
      }
    }
    .padding(.horizontal, 12).padding(.top, 6)
  }

  private var filter: some View {
    HStack(spacing: 6) {
      Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundStyle(Theme.ink3)
      if still {
        Text(model.query.isEmpty ? "Filter notes" : model.query).font(.system(size: 15))
          .foregroundStyle(model.query.isEmpty ? Theme.ink3 : Theme.ink)
          .frame(maxWidth: .infinity, alignment: .leading)
      } else {
        TextField("Filter notes", text: $model.query)
          .font(.system(size: 15)).foregroundStyle(Theme.ink)
          .focused($filtering)
          .submitLabel(.search)
          .autocorrectionDisabled()
          #if os(iOS)
          .textInputAutocapitalization(.never)
          #endif
          .accessibilityLabel("Filter notes")
      }
      if !model.query.isEmpty {
        Button { model.query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.ink4) }
          .buttonStyle(.plain).accessibilityLabel("Clear filter")
      }
    }
    .padding(.horizontal, 14).frame(height: 44)
    .glassSurface(in: Capsule(), interactive: true)
  }

  private func localChip(_ local: LocalGraph) -> some View {
    HStack(spacing: 6) {
      Image(systemName: "scope").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink)
      Text("Local").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink).fixedSize()
      ForEach(1...3, id: \.self) { d in
        Button { model.local = LocalGraph(id: local.id, depth: d) } label: {
          Text("\(d)").font(.system(size: 13, weight: .semibold, design: .monospaced))
            .foregroundStyle(local.depth == d ? Theme.onAccent : Theme.ink2)
            .frame(width: 26, height: 24)
            .background(local.depth == d ? Theme.accent : .clear, in: RoundedRectangle(cornerRadius: 7))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityLabel("Local graph depth \(d)")
      }
      Button { model.local = nil } label: {
        Image(systemName: "xmark").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink3).frame(width: 26, height: 26).contentShape(Rectangle())
      }
      .buttonStyle(.plain).accessibilityLabel("Back to the whole web")
    }
    .padding(.leading, 12).padding(.trailing, 4).frame(height: 32)
    .glassSurface(in: Capsule())
  }

  private var bottomBar: some View {
    HStack(alignment: .bottom) {
      if let d = model.data, !d.notes.isEmpty {
        Text("Tap to open · hold and drag to pin · pinch to zoom")
          .font(.system(size: 12)).foregroundStyle(Theme.ink3)
          .padding(.horizontal, 10).padding(.vertical, 6)
          .glassSurface(in: Capsule())
          .lineLimit(1).minimumScaleFactor(0.8)
      }
      Spacer(minLength: 8)
      zoomPanel
    }
    .padding(.horizontal, 12).padding(.bottom, 8)
  }

  /// Map-style controls, bottom right: in, level, out, fit, reset layout (desktop's ZoomPanel).
  private var zoomPanel: some View {
    VStack(spacing: 2) {
      zoomButton("plus", "Zoom in") { model.zoom(by: 1.4) }
      Text("\(model.zoomPct)%").font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.ink3)
      zoomButton("minus", "Zoom out") { model.zoom(by: 1 / 1.4) }
      Rectangle().fill(Theme.line).frame(width: 24, height: 1).padding(.vertical, 2)
      zoomButton("arrow.up.left.and.arrow.down.right", "Fit to screen") { model.fit(padding: 60, duration: 0.5) }
      zoomButton("arrow.counterclockwise", "Reset layout") { model.resetLayout() }
    }
    .padding(4)
    .glassSurface(in: RoundedRectangle(cornerRadius: 16, style: .continuous))
  }

  private func zoomButton(_ icon: String, _ label: String, _ action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: icon).font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.ink2)
        .frame(width: 40, height: 40).contentShape(Rectangle())
    }
    .buttonStyle(PressButtonStyle()).accessibilityLabel(label)
  }

  // MARK: States

  @ViewBuilder private var states: some View {
    if let e = model.error {
      VStack(spacing: 12) {
        Text("Couldn't load the mind map: \(e)").font(.system(size: 15)).foregroundStyle(Theme.ink3).multilineTextAlignment(.center)
        Button("Retry") { Task { await model.load() } }
          .font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.ink)
          .padding(.horizontal, 18).frame(height: 38).overlay(Capsule().stroke(Theme.ink4))
          .buttonStyle(.plain)
      }
      .padding(32)
    } else if model.data == nil {
      ProgressView().controlSize(.regular)
    } else if model.data?.notes.isEmpty == true {
      Text("Nothing here yet. Notes appear as Mercury learns about you.")
        .font(.system(size: 15)).foregroundStyle(Theme.ink3).multilineTextAlignment(.center).padding(32)
    } else if model.graph.nodes.isEmpty {
      Text("No notes match.").font(.system(size: 15)).foregroundStyle(Theme.ink3)
    }
  }
}

#if os(iOS)
/// Native touch on the map: one finger pans, two pinch (around the fingers) and pan, a tap selects
/// (the background clears), a double tap zooms in, and touch-and-hold on a dot then drag moves and pins it.
struct MindMapGestures: UIViewRepresentable {
  var model: MindMapModel

  func makeCoordinator() -> Coordinator { Coordinator(model: model) }

  func makeUIView(context: Context) -> UIView {
    let v = UIView()
    v.backgroundColor = .clear
    let c = context.coordinator
    let pan = UIPanGestureRecognizer(target: c, action: #selector(Coordinator.pan(_:)))
    pan.maximumNumberOfTouches = 1
    let pinch = UIPinchGestureRecognizer(target: c, action: #selector(Coordinator.pinch(_:)))
    let double = UITapGestureRecognizer(target: c, action: #selector(Coordinator.doubleTap(_:)))
    double.numberOfTapsRequired = 2
    let tap = UITapGestureRecognizer(target: c, action: #selector(Coordinator.tap(_:)))
    tap.require(toFail: double)
    let hold = UILongPressGestureRecognizer(target: c, action: #selector(Coordinator.hold(_:)))
    hold.minimumPressDuration = 0.3
    for g in [pan, pinch, double, tap, hold] as [UIGestureRecognizer] { g.delegate = c; v.addGestureRecognizer(g) }
    c.hold = hold
    return v
  }

  func updateUIView(_ uiView: UIView, context: Context) { context.coordinator.model = model }

  @MainActor final class Coordinator: NSObject, UIGestureRecognizerDelegate {
    var model: MindMapModel
    weak var hold: UILongPressGestureRecognizer?
    private var pinchFocus: (x: Double, y: Double)?
    private var pinchK = 1.0
    private var lastPan: CGPoint = .zero
    private let haptic = UIImpactFeedbackGenerator(style: .light)

    init(model: MindMapModel) { self.model = model }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
      !(g is UITapGestureRecognizer || other is UITapGestureRecognizer)
    }

    /// Holding only grabs a dot.
    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
      if g === hold { return model.pick(g.location(in: g.view)) != nil }
      return true
    }

    @objc func tap(_ g: UITapGestureRecognizer) {
      dismissKeyboard()
      model.tap(g.location(in: g.view))
    }

    @objc func doubleTap(_ g: UITapGestureRecognizer) { model.zoom(by: 2, around: g.location(in: g.view)) }

    @objc func pan(_ g: UIPanGestureRecognizer) {
      if model.isDragging { return }
      let p = g.translation(in: g.view)
      switch g.state {
      case .began: lastPan = p; model.gesturing = true
      case .changed:
        model.pan(by: CGSize(width: p.x - lastPan.x, height: p.y - lastPan.y)); lastPan = p
      default: model.gesturing = model.isDragging; model.updateZoomPct()
      }
    }

    @objc func pinch(_ g: UIPinchGestureRecognizer) {
      guard g.numberOfTouches >= 2 || g.state == .ended || g.state == .cancelled else { return }
      let p = g.location(in: g.view)
      switch g.state {
      case .began:
        pinchFocus = model.view.toGraph(p, model.size); pinchK = model.view.k; model.gesturing = true
      case .changed:
        if let f = pinchFocus { model.pinch(focus: f, at: p, k: pinchK * g.scale) }
      default:
        pinchFocus = nil; model.gesturing = model.isDragging; model.updateZoomPct()
      }
    }

    @objc func hold(_ g: UILongPressGestureRecognizer) {
      let p = g.location(in: g.view)
      switch g.state {
      case .began:
        guard let i = model.pick(p) else { return }
        haptic.impactOccurred()
        model.dragBegan(i, at: p)
      case .changed: model.dragMoved(to: p)
      default: model.dragEnded()
      }
    }
  }
}
#endif

// MARK: - Settings

/// The desktop's graph settings panel: Filters, Groups, Display, Forces, Restore defaults.
struct MindMapSettings: View {
  @Bindable var model: MindMapModel
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Form {
        Section("Filters") {
          Toggle("Orphans", isOn: $model.settings.orphans)
          Toggle("Archive", isOn: Binding(get: { model.archive }, set: { model.setArchive($0) }))
        }
        Section("Groups") {
          ForEach(model.groups, id: \.id) { t in
            let off = model.settings.hidden.contains(t.id)
            Button { model.toggleGroup(t.id) } label: {
              HStack(spacing: 10) {
                Circle().fill(Color(hexString: t.color)).frame(width: 10, height: 10)
                Text(t.label).foregroundStyle(Theme.ink).lineLimit(1)
                Spacer()
                Text("\(t.size)").font(.system(size: 13, design: .monospaced)).foregroundStyle(Theme.ink3)
              }
              .opacity(off ? 0.4 : 1)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(off ? "Hidden" : "Shown")
          }
        }
        Section("Display") {
          slider("Node size", $model.settings.nodeSize, 0.4...2.5, 0.1)
          slider("Link thickness", $model.settings.linkWidth, 0.2...3, 0.1)
          slider("Text fade threshold", $model.settings.textFade, 0.3...4, 0.1)
        }
        Section("Forces") {
          slider("Center force", $model.settings.center, 0...0.3, 0.01)
          slider("Repel force", $model.settings.repel, 0...200, 2)
          slider("Link force", $model.settings.linkForce, 0...1, 0.02)
          slider("Link distance", $model.settings.linkDistance, 8...200, 2)
        }
        Section {
          Button("Restore defaults") { model.restoreDefaults() }.foregroundStyle(Theme.ink)
        }
      }
      .navigationTitle("Graph settings")
      #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      .tint(Theme.accent)
    }
    .presentationDetents([.medium, .large])
    .presentationBackgroundInteraction(.enabled(upThrough: .medium))
  }

  private func slider(_ label: String, _ value: Binding<Double>, _ range: ClosedRange<Double>, _ step: Double) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Text(label).foregroundStyle(Theme.ink)
        Spacer()
        Text(Self.format(value.wrappedValue)).font(.system(size: 13, design: .monospaced)).foregroundStyle(Theme.ink3)
      }
      Slider(value: value, in: range, step: step)
    }
  }

  /// Number(value.toFixed(2)), as the desktop shows it.
  static func format(_ v: Double) -> String {
    let r = (v * 100).rounded() / 100
    return r == r.rounded() ? String(Int(r)) : String(r)
  }
}

// MARK: - A note

/// A tapped note: its text, kind, theme, what Mercury knows about it, and the notes it links to.
struct MindMapNoteSheet: View {
  var model: MindMapModel
  var id: String
  var still = false

  var body: some View {
    Group {
      if still { content } else { ScrollView { content } }
    }
    .background(Theme.bg)
    .task(id: id) { if !still { await model.loadDetail(id) } }
  }

  private var content: some View {
    let note = model.note(id)
    let theme = model.theme(of: id)
    return VStack(alignment: .leading, spacing: 14) {
        HStack(spacing: 8) {
          if let theme {
            Circle().fill(Color(hexString: theme.color)).frame(width: 9, height: 9)
            Text(theme.label.uppercased()).font(.system(size: 12, weight: .medium)).tracking(0.6).foregroundStyle(Theme.ink3).lineLimit(1)
          }
          Spacer(minLength: 8)
          if let kind = note?.kind ?? model.detail?.type, !kind.isEmpty {
            Text(BrainWeb.kindLabel[kind] ?? kind).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink2)
              .padding(.horizontal, 8).padding(.vertical, 3).background(Theme.surface2, in: Capsule())
          }
          if model.detail?.evidenceKind == "owner" {
            Text("you said").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.onAccent)
              .padding(.horizontal, 8).padding(.vertical, 3).background(Theme.accent, in: Capsule())
          }
        }
        Text(model.detail?.summary ?? note?.text ?? "")
          .font(.system(size: 19)).foregroundStyle(Theme.ink).textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)
        if let d = model.detail?.detail, !d.isEmpty {
          Text(d).font(.system(size: 15)).foregroundStyle(Theme.ink2).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
        facts
        linked
      }
      .padding(.horizontal, 20).padding(.top, 22).padding(.bottom, 30)
      .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder private var facts: some View {
    if let m = model.detail {
      VStack(spacing: 8) {
        fact("Confidence", "\(Int((m.confidence * 100).rounded()))%")
        if let e = m.evidenceCount { fact("Evidence", "\(e)") }
        if let c = m.createdAt { fact("First learned", Self.date(c)) }
        if let u = m.updatedAt { fact("Last updated", Self.date(u)) }
      }
      .padding(14)
      .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    } else if let e = model.detailError {
      Text(e).font(.system(size: 14)).foregroundStyle(Theme.red)
    } else if !still {
      ProgressView().frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func fact(_ k: String, _ v: String) -> some View {
    HStack {
      Text(k).foregroundStyle(Theme.ink3)
      Spacer()
      Text(v).foregroundStyle(Theme.ink)
    }
    .font(.system(size: 14))
  }

  @ViewBuilder private var linked: some View {
    let related = model.data.map { BrainWeb.related($0, id: id) } ?? []
    if !related.isEmpty {
      VStack(alignment: .leading, spacing: 4) {
        Text("Linked notes").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink3).padding(.top, 6).padding(.bottom, 4)
        ForEach(related, id: \.note.id) { r in
          Button { model.jump(to: r.note.id) } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
              Circle().fill(Color(hexString: model.theme(of: r.note.id)?.color ?? BrainWeb.looseColor)).frame(width: 8, height: 8)
              Text(r.note.text).font(.system(size: 15)).foregroundStyle(Theme.ink).lineLimit(2).multilineTextAlignment(.leading)
              Spacer(minLength: 4)
              Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink4)
            }
            .padding(.vertical, 9).contentShape(Rectangle())
          }
          .buttonStyle(PressButtonStyle())
        }
      }
    }
  }

  static func date(_ ms: Double) -> String {
    Date(timeIntervalSince1970: ms / 1000).formatted(date: .abbreviated, time: .omitted)
  }
}
