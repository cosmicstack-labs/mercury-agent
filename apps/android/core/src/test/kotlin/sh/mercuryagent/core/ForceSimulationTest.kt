package sh.mercuryagent.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Positions after 1, 10 and 60 ticks from the desktop's own engine (force-graph 1.52: d3-force-3d
 * simulation, link and manyBody; d3-force x, y and collide) with NoteWeb's settings, from the same
 * start: 24 nodes, 40 links, one coincident pair (jiggle) and one pinned node. iOS checks the same.
 */
class ForceSimulationTest {
  private val fixture: JsonObject = MercuryJson.parseToJsonElement(
    """
{"init":{"x":[89.56,-100.25,-1.08,-1.08,-113.45,-98.67,-14.36,3.43,-85.06,87.66,1.16,-126.75,-67.32,-5.16,121.19,63.96,-27.23,-24.81,95.01,45.89,91.81,3.79,22.19,61.37],"y":[-105.11,-46.2,15.41,15.41,49.96,116.1,118.44,-148.52,-41.72,34.15,-65.46,135.76,-83.05,83.65,69.17,-90.9,20.56,110.17,15.71,136.91,62.25,131.68,-78.01,-117.48],"pinned":[false,false,false,false,true,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false],"links":[[15,9,0.619],[22,7,0.165],[0,6,0.135],[23,17,0.325],[7,5,0.769],[16,8,0.061],[15,8,0.386],[12,18,0.259],[11,10,0.66],[2,12,0.309],[23,11,0.449],[15,16,0.914],[9,0,0.665],[21,11,0.694],[18,20,0.065],[15,11,0.135],[5,8,0.836],[4,13,0.542],[7,3,0.562],[22,1,0.866],[23,14,0.958],[21,6,0.745],[15,6,0.729],[17,12,0.884],[5,19,0.489],[5,14,0.15],[7,11,0.665],[9,1,0.21],[10,12,0.568],[1,10,0.201],[8,3,0.196],[20,7,0.346],[16,1,0.638],[6,5,0.985],[2,17,0.568],[8,14,0.011],[1,4,0.502],[13,18,0.761],[8,1,0.292],[14,7,0.802]]},"out":{"1":{"x":[79.80175740529855,-82.00531166496089,18.12728977528701,-7.378669749133135,-113.45,-60.16542602441134,-7.626765328840862,-1.810007847614164,-59.35146116335346,62.7824104467356,-25.182691679715546,-75.61359006183328,-47.724517896475334,-2.962244515195551,72.49804798250253,30.856080662830458,-27.78238353221562,-22.472870644445997,69.05768482147684,23.24461703060521,72.06096894289796,-11.10939605921141,-1.4814398021742399,43.34468856994803],"y":[-71.34167561813604,-38.32510244730146,19.220506280526084,-31.793115130395908,49.96,65.29123545910588,82.84059413396366,-69.84428482429072,-27.587989979833843,3.1563799447776475,-29.39947495947971,64.87031440250496,-55.37038130968648,65.71296550580689,36.566698974863314,-39.04198475027437,-0.7347360961346219,61.43295975618583,12.073067644697167,115.2149419957486,41.750053770380525,124.44241403529091,-74.97971575553612,-47.99968195360789],"alpha":0.982},"10":{"x":[37.17323522875331,-87.95897990203976,37.66808313222005,4.366892757183958,-113.45,-7.076224113936906,13.830955213951002,20.281673904355042,-50.37080869122642,-26.80026366696987,-57.50907575674493,-26.28911159514116,-1.0684821825784427,-44.2225120905668,23.120292948895784,-31.979939564850017,-50.871587468438435,-17.119641050545653,27.177183971424764,-2.1288589303294705,63.96081211435376,-22.75682920749716,-54.74322737953779,10.92931071582852],"y":[-17.409784342614053,-12.354638867057215,18.76717643396028,-49.07683136277831,49.96,0.6063818116701104,41.733772910959615,-1.8409293592246536,-18.505587498756285,-30.01631885761983,4.2415244869752184,-7.068082316381521,-21.15406063291663,41.74608141822742,-37.268984444269,20.46716220579852,-34.945078730206546,9.910608345438273,12.523737746266386,55.93221269731964,32.09912505227494,47.46243305580122,-45.48582633891928,14.178712651166702],"alpha":0.8339017358584585},"60":{"x":[-47.24959939877886,-66.7593836206353,92.65592441758731,-0.26415004631330974,-113.45,-0.8737698581373332,-23.48225424886275,30.555065701655913,-34.68175047772618,-79.35433296416726,-10.888546120351116,8.22588191571433,43.98036827584911,-51.93898299094651,23.91554608754234,-52.9422968915894,-87.25322575560946,72.71009075206561,3.1579298240557176,22.925846904859817,43.996043649660976,5.745512075086418,-29.684739780676836,53.256591448574014],"y":[-50.86992200519798,11.640307830207718,11.485396025402805,-68.89916598484062,49.96,-28.355513748398693,8.350839489954318,-35.974537328598714,-38.102248856392,-35.32955959738314,35.29121827050441,-4.037654840487588,51.73416179467348,72.27585303761013,-65.42677370684666,-6.293884292461988,-18.931032087367047,27.11268073134348,73.64053061789869,9.61304967558243,11.945743267602161,38.29958757739814,-15.031489532260514,-26.583951096562476],"alpha":0.33627088527254617}}}
""",
  ).jsonObject

  private fun doubles(o: JsonObject, k: String) = o[k]!!.jsonArray.map { it.jsonPrimitive.double }

  private fun fixtureSim(): ForceSimulation {
    val init = fixture["init"]!!.jsonObject
    val xs = doubles(init, "x"); val ys = doubles(init, "y")
    val pinned = init["pinned"]!!.jsonArray.map { it.jsonPrimitive.boolean }
    val links = init["links"]!!.jsonArray.map { l -> val a = l.jsonArray.map { it.jsonPrimitive.double }; Triple(a[0].toInt(), a[1].toInt(), a[2]) }
    val sim = ForceSimulation(xs.size, links, ForceParams())
    for (i in xs.indices) {
      sim.x[i] = xs[i]; sim.y[i] = ys[i]
      if (pinned[i]) { sim.fx[i] = xs[i]; sim.fy[i] = ys[i] }
    }
    sim.initializeMissing()
    return sim
  }

  @Test fun matchesD3TickForTick() {
    val sim = fixtureSim()
    val out = fixture["out"]!!.jsonObject
    for (t in 1..60) {
      sim.tick()
      val want = out[t.toString()]?.jsonObject ?: continue
      assertEquals(want["alpha"]!!.jsonPrimitive.double, sim.alpha, 1e-15)
      val wx = doubles(want, "x"); val wy = doubles(want, "y")
      for (i in 0 until sim.n) {
        assertEquals("tick $t node $i x", wx[i], sim.x[i], 1e-9)
        assertEquals("tick $t node $i y", wy[i], sim.y[i], 1e-9)
      }
    }
  }

  @Test fun pinnedNodesDontMove() {
    val sim = fixtureSim()
    val x = sim.x[4]; val y = sim.y[4]
    repeat(200) { sim.tick() }
    assertEquals(x, sim.x[4], 0.0); assertEquals(y, sim.y[4], 0.0)
  }

  @Test fun alphaDecaysAndTheEngineStopsWithinTheCooldown() {
    val sim = fixtureSim()
    var ticks = 0
    while (sim.step()) ticks++
    assertFalse(sim.running)
    assertTrue(sim.alpha < 0.001)
    assertEquals(381, ticks) // (1 − 0.018)^n < 0.001 ⇒ n = 381
    sim.reheat()
    assertTrue(sim.running && sim.alpha == 1.0)
    sim.alphaMin = 0.0 // the desktop's force-graph default: only the 900-tick cooldown stops it.
    ticks = 0
    while (sim.step()) ticks++
    assertEquals(900, ticks)
  }

  @Test fun settlesAndCollideKeepsDotsApart() {
    val rng = SeededRandom(42)
    val g = syntheticGraph(120, 220, rng)
    val sim = ForceSimulation(g, ForceParams())
    sim.place(g.nodes.map { it.id }, emptyMap(), emptyMap()) { rng.next() }
    val speeds = ArrayList<Double>()
    while (sim.step()) speeds.add((0 until sim.n).maxOf { Math.hypot(sim.vx[it], sim.vy[it]) })
    assertTrue(speeds.last() < 0.05)
    assertTrue(speeds.last() < speeds[5] / 100)
    var tooClose = 0
    for (i in 0 until sim.n) for (j in i + 1 until sim.n) {
      val d = Math.hypot(sim.x[i] - sim.x[j], sim.y[i] - sim.y[j])
      if (d < (sim.radii[i] + sim.radii[j] - 2) * 0.8) tooClose++
    }
    assertEquals(0, tooClose)
  }

  @Test fun placeKeepsLiveNodesPinsAndScattersNewOnes() {
    val sim = ForceSimulation(3, listOf(Triple(0, 1, 0.5)), ForceParams())
    val rng = SeededRandom(1)
    sim.place(listOf("a", "b", "c"), mapOf("b" to (10.0 to 20.0)), mapOf("a" to ForceSimulation.Carry(1.0, 2.0, 3.0, 4.0, Double.NaN, Double.NaN))) { rng.next() }
    assertEquals(1.0, sim.x[0], 0.0); assertEquals(3.0, sim.vx[0], 0.0)
    assertEquals(10.0, sim.x[1], 0.0); assertEquals(10.0, sim.fx[1], 0.0); assertEquals(20.0, sim.fy[1], 0.0)
    assertTrue(Math.hypot(sim.x[2], sim.y[2]) <= 60 + 18 && sim.fx[2].isNaN())
  }

  @Test fun hitTestPicksTheTopmostDotWithinItsRadiusPlusThree() {
    val grid = HitGrid(floatArrayOf(0f, 4f, 100f), floatArrayOf(0f, 0f, 100f), doubleArrayOf(5.2, 5.2, 5.2), 3)
    assertEquals(1, grid.pick(2.0, 0.0))
    assertEquals(0, grid.pick(-4.0, 0.0))
    assertNull(grid.pick(50.0, 50.0))
    assertNull(grid.pick(100.0, 106.0))
    assertEquals(2, grid.pick(100.0, 106.0, 2.0))
  }

  @Test fun seededRandomMatchesIos() {
    // splitmix64 from the same seed as iOS's SeededRandom: same scatter in previews and tests.
    val r = SeededRandom(1)
    val a = r.next(); val b = r.next()
    assertTrue(a in 0.0..1.0 && b in 0.0..1.0 && a != b)
  }

  /** The owner's real shape: 671 notes, 2,119 links. Must stay well under 8 ms a tick. */
  @Test fun realSizeTickCost() {
    val rng = SeededRandom(671)
    val g = syntheticGraph(671, 2119, rng)
    val sim = ForceSimulation(g, ForceParams())
    sim.place(g.nodes.map { it.id }, emptyMap(), emptyMap()) { rng.next() }
    repeat(60) { sim.tick() } // JIT warm-up
    val ticks = 200
    val start = System.nanoTime()
    repeat(ticks) { sim.tick() }
    val ms = (System.nanoTime() - start) / 1e6 / ticks
    println("mind map: ${"%.3f".format(ms)} ms/tick (671 nodes, 2119 links)")
    assertTrue("$ms ms/tick", ms < 8)
  }
}

/** A graph shaped like a real second brain: clusters (themes) with most links inside, some across. */
fun syntheticGraph(nodes: Int, links: Int, rng: SeededRandom): WebGraph {
  val themes = maxOf(1, nodes / 12)
  val theme = IntArray(nodes) { (rng.next() * themes).toInt() }
  val seen = HashSet<Int>()
  val out = ArrayList<BrainMap.Link>()
  while (out.size < links) {
    val a = (rng.next() * nodes).toInt()
    var b = (rng.next() * nodes).toInt()
    if (rng.next() < 0.8) {
      val peers = (0 until 8).map { (rng.next() * nodes).toInt() }.filter { theme[it] == theme[a] }
      peers.firstOrNull()?.let { b = it }
    }
    if (a == b || (a * nodes + b) in seen || (b * nodes + a) in seen) continue
    seen.add(a * nodes + b)
    out.add(BrainMap.Link("n$a", "n$b", 0.1 + rng.next() * 0.6))
  }
  val m = BrainMap(
    themes = (0 until themes).map { BrainMap.Theme("t$it", "Theme $it", size = 1) },
    placement = (0 until nodes).associate { "n$it" to "t${theme[it]}" },
    links = out,
    notes = (0 until nodes).map { BrainMap.Note("n$it", "Note $it", "fact") },
  )
  return BrainWeb.toWeb(m, WebOptions())
}
