import Testing
import SwiftUI
@testable import MercuryUI
@testable import MercuryCore

@MainActor @Suite(.serialized) struct MindMapTests {
  func model(_ m: BrainMap = MindMapGallery.map(), seed: UInt64 = 3) -> MindMapModel {
    let d = UserDefaults(suiteName: "mindmap-tests-\(seed)")!
    d.removeObject(forKey: WebSettings.storageKey)
    MindMapModel.sessionPins["test-\(seed)"] = nil
    let md = MindMapModel(client: nil, scope: "test-\(seed)", defaults: d)
    md.show(m, seed: seed, size: CGSize(width: 390, height: 763))
    return md
  }

  func screenPoint(_ md: MindMapModel, _ i: Int) -> CGPoint {
    md.engine.pull()
    return md.view.toScreen(Double(md.engine.front.xs[i]), Double(md.engine.front.ys[i]), md.size)
  }

  @Test func tapOnADotSelectsItAndTheBackgroundClears() {
    let md = model()
    let p = screenPoint(md, 0)
    md.tap(p)
    #expect(md.selected == md.graph.nodes[0].id)
    #expect(md.showDetail)
    #expect(md.hoverIndex == 0)
    md.tap(CGPoint(x: 5, y: 5))
    #expect(md.selected == nil && !md.showDetail)
  }

  @Test func filterLocalAndGroupsRebuildTheWeb() {
    let md = model()
    let all = md.graph.nodes.count
    md.query = "heer"
    #expect(md.graph.nodes.count == 3)
    md.query = ""
    #expect(md.graph.nodes.count == all)
    md.local = LocalGraph(id: "c1-0", depth: 1)
    #expect(md.graph.nodes.count == 1 + (md.data.map { BrainWeb.related($0, id: "c1-0").count } ?? 0))
    md.local = nil
    md.toggleGroup("c1")
    #expect(!md.graph.nodes.contains { $0.theme == "c1" })
    md.toggleGroup("c1")
    #expect(md.graph.nodes.count == all)
  }

  @Test func holdingAndDraggingADotPinsItForTheSession() async throws {
    let md = model()
    let i = 3
    let id = md.graph.nodes[i].id
    let p = screenPoint(md, i)
    md.dragBegan(i, at: p)
    #expect(md.pinned.contains(i)) // the amber dot shows while dragging, as fx is set
    md.dragMoved(to: CGPoint(x: p.x + 40, y: p.y + 30))
    md.dragEnded()
    for _ in 0..<50 where md.pins[id] == nil { try await Task.sleep(for: .milliseconds(20)) }
    let pin = try #require(md.pins[id])
    let start = md.view.toGraph(p, md.size)
    #expect(abs(pin.0 - (start.x + 40 / md.view.k).rounded()) <= 1)
    #expect(abs(pin.1 - (start.y + 30 / md.view.k).rounded()) <= 1)
    // A rebuild (a filter) keeps the pin: the dot comes back where it was put.
    md.query = "a"; md.query = ""
    let j = try #require(md.index[id])
    #expect(md.pinned.contains(j))
    md.resetLayout()
    #expect(md.pins.isEmpty && md.pinned.isEmpty)
  }

  @Test func holdingWithoutMovingIsATap() async throws {
    let md = model()
    md.dragBegan(2, at: screenPoint(md, 2))
    md.dragEnded()
    for _ in 0..<50 where md.selected == nil { try await Task.sleep(for: .milliseconds(20)) }
    #expect(md.selected == md.graph.nodes[2].id)
    #expect(md.pins.isEmpty)
  }

  @Test func pinchKeepsThePointUnderTheFingers() {
    let md = model()
    let p = CGPoint(x: 120, y: 300)
    let g = md.view.toGraph(p, md.size)
    md.pinch(focus: g, at: p, k: md.view.k * 2.5)
    let back = md.view.toScreen(g.x, g.y, md.size)
    #expect(abs(back.x - p.x) < 1e-9 && abs(back.y - p.y) < 1e-9)
    md.pinch(focus: g, at: p, k: 1000)
    #expect(md.view.k == MapView.maxZoom)
  }

  @Test func settingsPersistAndRestoreDefaultsKeepsHiddenGroups() {
    let md = model(seed: 11)
    md.settings.repel = 80
    md.toggleGroup("c2")
    let stored = WebSettings.load(md.defaults)
    #expect(stored.repel == 80 && stored.hidden == ["c2"])
    md.restoreDefaults()
    #expect(md.settings.repel == 40 && md.settings.hidden == ["c2"])
    #expect(MindMapSettings.format(0.06) == "0.06" && MindMapSettings.format(40) == "40" && MindMapSettings.format(1.6) == "1.6")
  }

  /// One frame of the owner's real size (671 dots, 2,119 lines, labels on), drawn off-screen at @3x.
  @Test func drawingARealSizeFrame() {
    let md = model(MindMapGallery.realSize(), seed: 671)
    md.view.k = 1.2 // labels showing
    func time(_ label: String) -> Double {
      func render() {
        // A new renderer each time: one caches its image. Includes the renderer's own setup, so it's an upper bound.
        let r = ImageRenderer(content: MindMapCanvas(model: md, still: true).frame(width: 390, height: 844))
        r.scale = 3
        _ = r.cgImage
      }
      render()
      let start = DispatchTime.now().uptimeNanoseconds
      for _ in 0..<10 { render() }
      let ms = Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6 / 10
      print("mind map frame (\(label)): \(String(format: "%.2f", ms)) ms")
      return ms
    }
    _ = time("all lines")
    md.settings.textFade = 100
    _ = time("all lines, no labels")
    md.view.k = 0.4
    _ = time("fit zoom, no labels")
    md.settings.textFade = 1.6
    md.view.k = 1.2
    md.selected = md.graph.nodes[0].id
    _ = time("a hub lit")
  }
}
