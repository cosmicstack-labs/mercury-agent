import Testing
import Foundation
@testable import MercuryCore

/// Positions after 1, 10 and 60 ticks from the desktop's own engine (force-graph 1.52: d3-force-3d
/// simulation, link and manyBody; d3-force x, y and collide) with NoteWeb's settings, from the same
/// start: 24 nodes, 40 links, one coincident pair (jiggle) and one pinned node.
let d3Fixture = #"""
{"init":{"x":[89.56,-100.25,-1.08,-1.08,-113.45,-98.67,-14.36,3.43,-85.06,87.66,1.16,-126.75,-67.32,-5.16,121.19,63.96,-27.23,-24.81,95.01,45.89,91.81,3.79,22.19,61.37],"y":[-105.11,-46.2,15.41,15.41,49.96,116.1,118.44,-148.52,-41.72,34.15,-65.46,135.76,-83.05,83.65,69.17,-90.9,20.56,110.17,15.71,136.91,62.25,131.68,-78.01,-117.48],"pinned":[false,false,false,false,true,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false],"links":[[15,9,0.619],[22,7,0.165],[0,6,0.135],[23,17,0.325],[7,5,0.769],[16,8,0.061],[15,8,0.386],[12,18,0.259],[11,10,0.66],[2,12,0.309],[23,11,0.449],[15,16,0.914],[9,0,0.665],[21,11,0.694],[18,20,0.065],[15,11,0.135],[5,8,0.836],[4,13,0.542],[7,3,0.562],[22,1,0.866],[23,14,0.958],[21,6,0.745],[15,6,0.729],[17,12,0.884],[5,19,0.489],[5,14,0.15],[7,11,0.665],[9,1,0.21],[10,12,0.568],[1,10,0.201],[8,3,0.196],[20,7,0.346],[16,1,0.638],[6,5,0.985],[2,17,0.568],[8,14,0.011],[1,4,0.502],[13,18,0.761],[8,1,0.292],[14,7,0.802]]},"out":{"1":{"x":[79.80175740529855,-82.00531166496089,18.12728977528701,-7.378669749133135,-113.45,-60.16542602441134,-7.626765328840862,-1.810007847614164,-59.35146116335346,62.7824104467356,-25.182691679715546,-75.61359006183328,-47.724517896475334,-2.962244515195551,72.49804798250253,30.856080662830458,-27.78238353221562,-22.472870644445997,69.05768482147684,23.24461703060521,72.06096894289796,-11.10939605921141,-1.4814398021742399,43.34468856994803],"y":[-71.34167561813604,-38.32510244730146,19.220506280526084,-31.793115130395908,49.96,65.29123545910588,82.84059413396366,-69.84428482429072,-27.587989979833843,3.1563799447776475,-29.39947495947971,64.87031440250496,-55.37038130968648,65.71296550580689,36.566698974863314,-39.04198475027437,-0.7347360961346219,61.43295975618583,12.073067644697167,115.2149419957486,41.750053770380525,124.44241403529091,-74.97971575553612,-47.99968195360789],"alpha":0.982},"10":{"x":[37.17323522875331,-87.95897990203976,37.66808313222005,4.366892757183958,-113.45,-7.076224113936906,13.830955213951002,20.281673904355042,-50.37080869122642,-26.80026366696987,-57.50907575674493,-26.28911159514116,-1.0684821825784427,-44.2225120905668,23.120292948895784,-31.979939564850017,-50.871587468438435,-17.119641050545653,27.177183971424764,-2.1288589303294705,63.96081211435376,-22.75682920749716,-54.74322737953779,10.92931071582852],"y":[-17.409784342614053,-12.354638867057215,18.76717643396028,-49.07683136277831,49.96,0.6063818116701104,41.733772910959615,-1.8409293592246536,-18.505587498756285,-30.01631885761983,4.2415244869752184,-7.068082316381521,-21.15406063291663,41.74608141822742,-37.268984444269,20.46716220579852,-34.945078730206546,9.910608345438273,12.523737746266386,55.93221269731964,32.09912505227494,47.46243305580122,-45.48582633891928,14.178712651166702],"alpha":0.8339017358584585},"60":{"x":[-47.24959939877886,-66.7593836206353,92.65592441758731,-0.26415004631330974,-113.45,-0.8737698581373332,-23.48225424886275,30.555065701655913,-34.68175047772618,-79.35433296416726,-10.888546120351116,8.22588191571433,43.98036827584911,-51.93898299094651,23.91554608754234,-52.9422968915894,-87.25322575560946,72.71009075206561,3.1579298240557176,22.925846904859817,43.996043649660976,5.745512075086418,-29.684739780676836,53.256591448574014],"y":[-50.86992200519798,11.640307830207718,11.485396025402805,-68.89916598484062,49.96,-28.355513748398693,8.350839489954318,-35.974537328598714,-38.102248856392,-35.32955959738314,35.29121827050441,-4.037654840487588,51.73416179467348,72.27585303761013,-65.42677370684666,-6.293884292461988,-18.931032087367047,27.11268073134348,73.64053061789869,9.61304967558243,11.945743267602161,38.29958757739814,-15.031489532260514,-26.583951096562476],"alpha":0.33627088527254617}}}
"""#

struct D3Fixture: Decodable {
  struct Init: Decodable { var x: [Double]; var y: [Double]; var pinned: [Bool]; var links: [[Double]] }
  struct Out: Decodable { var x: [Double]; var y: [Double]; var alpha: Double }
  var start: Init
  enum CodingKeys: String, CodingKey { case start = "init", out }
  var out: [String: Out]
}

@Suite struct ForceSimulationTests {
  func fixtureSim() throws -> (ForceSimulation, D3Fixture) {
    let f = try JSONDecoder().decode(D3Fixture.self, from: Data(d3Fixture.utf8))
    let links = f.start.links.map { (Int($0[0]), Int($0[1]), $0[2]) }
    let sim = ForceSimulation(count: f.start.x.count, links: links, params: ForceParams())
    for i in 0..<f.start.x.count {
      sim.x[i] = f.start.x[i]; sim.y[i] = f.start.y[i]
      if f.start.pinned[i] { sim.fx[i] = f.start.x[i]; sim.fy[i] = f.start.y[i] }
    }
    sim.initializeMissing()
    return (sim, f)
  }

  @Test func matchesD3TickForTick() throws {
    let (sim, f) = try fixtureSim()
    for t in 1...60 {
      sim.tick()
      guard let want = f.out[String(t)] else { continue }
      #expect(abs(sim.alpha - want.alpha) < 1e-15)
      for i in 0..<sim.n {
        #expect(abs(sim.x[i] - want.x[i]) < 1e-9, "tick \(t) node \(i) x \(sim.x[i]) vs \(want.x[i])")
        #expect(abs(sim.y[i] - want.y[i]) < 1e-9, "tick \(t) node \(i) y \(sim.y[i]) vs \(want.y[i])")
      }
    }
  }

  @Test func pinnedNodesDontMove() throws {
    let (sim, f) = try fixtureSim()
    for _ in 0..<200 { sim.tick() }
    #expect(sim.x[4] == f.start.x[4] && sim.y[4] == f.start.y[4])
  }

  @Test func alphaDecaysAndTheEngineStopsWithinTheCooldown() throws {
    let (sim, _) = try fixtureSim()
    var ticks = 0
    while sim.step() { ticks += 1 }
    #expect(!sim.running)
    #expect(ticks <= 900)
    #expect(sim.alpha < 0.001)
    // (1 − 0.018)^n < 0.001 ⇒ n = 381.
    #expect(ticks == 381)
    sim.reheat()
    #expect(sim.running && sim.alpha == 1)
    sim.alphaMin = 0 // the desktop's force-graph default: only the 900-tick cooldown stops it.
    ticks = 0
    while sim.step() { ticks += 1 }
    #expect(ticks == 900)
  }

  @Test func settlesAndCollideKeepsDotsApart() {
    var rng = SeededRandom(seed: 42)
    let g = syntheticGraph(nodes: 120, links: 220, rng: &rng)
    let sim = ForceSimulation(g, params: ForceParams())
    sim.place(ids: g.nodes.map(\.id), pins: [:], live: [:], random: { rng.next() })
    var speeds: [Double] = []
    while sim.step() { speeds.append(zip(sim.vx, sim.vy).map { ($0 * $0 + $1 * $1).squareRoot() }.max() ?? 0) }
    // Converges: the fastest dot at the end barely moves, far slower than at the start.
    #expect(speeds.last! < 0.05)
    #expect(speeds.last! < speeds[5] / 100)
    // Collide (strength 0.6) keeps dots from piling up: no two centres closer than their radii.
    var tooClose = 0
    for i in 0..<sim.n { for j in (i + 1)..<sim.n {
      let d = ((sim.x[i] - sim.x[j]) * (sim.x[i] - sim.x[j]) + (sim.y[i] - sim.y[j]) * (sim.y[i] - sim.y[j])).squareRoot()
      if d < (sim.radii[i] + sim.radii[j] - 2) * 0.8 { tooClose += 1 }
    } }
    #expect(tooClose == 0)
  }

  @Test func placeKeepsLiveNodesPinsAndScattersNewOnes() {
    let sim = ForceSimulation(count: 3, links: [(0, 1, 0.5)], params: ForceParams())
    var rng = SeededRandom(seed: 1)
    sim.place(ids: ["a", "b", "c"], pins: ["b": (10, 20)], live: ["a": .init(x: 1, y: 2, vx: 3, vy: 4, fx: .nan, fy: .nan)], random: { rng.next() })
    #expect(sim.x[0] == 1 && sim.vx[0] == 3)
    #expect(sim.x[1] == 10 && sim.fx[1] == 10 && sim.fy[1] == 20)
    let r = (sim.x[2] * sim.x[2] + sim.y[2] * sim.y[2]).squareRoot()
    #expect(r <= 60 + 18 && sim.fx[2].isNaN) // one fresh node: spread 60 + √1·18
  }

  @Test func hitTestPicksTheTopmostDotWithinItsRadiusPlusThree() {
    let xs: [Float] = [0, 4, 100], ys: [Float] = [0, 0, 100]
    let grid = HitGrid(xs: xs, ys: ys, reach: [5.2, 5.2, 5.2], count: 3)
    #expect(grid.pick(x: 2, y: 0) == 1) // both cover it: the later-drawn wins
    #expect(grid.pick(x: -4, y: 0) == 0)
    #expect(grid.pick(x: 50, y: 50) == nil)
    #expect(grid.pick(x: 100, y: 106) == nil)
    #expect(grid.pick(x: 100, y: 106, slop: 2) == 2)
  }

  /// The owner's real shape: 671 notes, 2,119 links. Must stay well under 8 ms a tick.
  @Test func realSizeTickCost() {
    var rng = SeededRandom(seed: 671)
    let g = syntheticGraph(nodes: 671, links: 2119, rng: &rng)
    let sim = ForceSimulation(g, params: ForceParams())
    sim.place(ids: g.nodes.map(\.id), pins: [:], live: [:], random: { rng.next() })
    for _ in 0..<5 { sim.tick() }
    let ticks = 100
    let start = DispatchTime.now().uptimeNanoseconds
    for _ in 0..<ticks { sim.tick() }
    let ms = Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6 / Double(ticks)
    print("mind map: \(String(format: "%.3f", ms)) ms/tick (671 nodes, 2119 links)")
    #expect(ms < 16) // a Debug build; optimised it is ~0.6 ms (see the commit message)
  }
}

/// A graph shaped like a real second brain: clusters (themes) with most links inside, some across.
func syntheticGraph(nodes: Int, links: Int, rng: inout SeededRandom) -> WebGraph {
  let themes = Swift.max(1, nodes / 12)
  let theme = (0..<nodes).map { _ in Int(rng.next() * Double(themes)) }
  var seen = Set<Int>()
  var out: [(Int, Int, Double)] = []
  while out.count < links {
    let a = Int(rng.next() * Double(nodes))
    var b = Int(rng.next() * Double(nodes))
    if rng.next() < 0.8 { // same theme
      let peers = (0..<8).map { _ in Int(rng.next() * Double(nodes)) }.filter { theme[$0] == theme[a] }
      if let p = peers.first { b = p }
    }
    if a == b || seen.contains(a * nodes + b) || seen.contains(b * nodes + a) { continue }
    seen.insert(a * nodes + b)
    out.append((a, b, 0.1 + rng.next() * 0.6))
  }
  var m = BrainMap(themes: (0..<themes).map { .init(id: "t\($0)", label: "Theme \($0)", size: 1) }, placement: [:], links: [], notes: [])
  for i in 0..<nodes { m.notes.append(.init(id: "n\(i)", text: "Note \(i)", kind: "fact")); m.placement["n\(i)"] = "t\(theme[i])" }
  m.links = out.map { .init(a: "n\($0.0)", b: "n\($0.1)", w: $0.2) }
  return BrainWeb.toWeb(m, WebOptions())
}
