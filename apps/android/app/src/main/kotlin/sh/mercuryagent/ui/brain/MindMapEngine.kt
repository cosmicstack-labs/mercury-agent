package sh.mercuryagent.ui.brain

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import sh.mercuryagent.core.ForceParams
import sh.mercuryagent.core.ForceSimulation
import sh.mercuryagent.core.WebGraph

/**
 * Runs the mind map's force simulation off the main thread (Dispatchers.Default), one tick per 1/60 s
 * (force-graph ticks once per animation frame), and hands positions to the renderer through a
 * lock-guarded triple buffer of FloatArrays: the simulation writes its own back buffer and swaps it
 * with the shared one; the renderer swaps the shared one for its front buffer when there's a newer
 * one. Nothing is allocated per tick. Commands (load, drag, settings) take the simulation's lock for
 * a moment, so they never overlap a tick. iOS: MindMapEngine.swift.
 */
class MindMapEngine(private val scope: CoroutineScope, private val onRunning: (Boolean) -> Unit) {
  class Frame(var generation: Int = -1, var xs: FloatArray = FloatArray(0), var ys: FloatArray = FloatArray(0))

  private val simLock = Any()
  private var sim: ForceSimulation? = null
  private var ids: List<String> = emptyList()
  private var generation = -1
  private var job: Job? = null
  /** A tick loop is running (guarded by simLock, so a loop deciding to stop and a command starting one can't miss each other). */
  private var ticking = false
  private var paused = false
  @Volatile private var runs = 0
  private var back = Frame()
  private var drag: Drag? = null

  private class Drag(val index: Int, val x: Double, val y: Double, val fx: Double, val fy: Double, var dragged: Boolean = false)

  private val bufferLock = Any()
  private var shared = Frame()
  private var sharedVersion = 0L
  /** Main thread only. */
  var front = Frame(); private set
  private var frontVersion = 0L

  /** Scatter's randomness (Math.random on the desktop); tests and previews seed it. */
  var random: () -> Double = { Math.random() }

  /**
   * New dots and lines (desktop: graphData(place(next, live))): keeps where the notes already on screen
   * are, puts pinned ones at their pins, scatters new ones, alpha 1. Returns once the new positions are
   * published, so the next frame draws them.
   */
  fun load(g: WebGraph, generation: Int, params: ForceParams, pins: Map<String, Pair<Double, Double>>) {
    synchronized(simLock) {
      val live = HashMap<String, ForceSimulation.Carry>()
      sim?.let { old -> ids.forEachIndexed { i, id -> live[id] = old.carry(i) } }
      val s = ForceSimulation(g, params)
      s.place(g.nodes.map { it.id }, pins, live, random)
      sim = s
      ids = g.nodes.map { it.id }
      this.generation = generation
      drag = null
      publish()
    }
    start()
  }

  /** The force sliders and node size: re-initialise the forces, then d3ReheatSimulation. */
  fun setParams(p: ForceParams) {
    synchronized(simLock) { sim?.apply { apply(p); reheat() } }
    start()
  }

  /** Reset layout: unpin everything, scatter every dot, reheat. */
  fun resetLayout() {
    synchronized(simLock) {
      val s = sim ?: return
      s.scatter(IntArray(s.n) { it }, true, random)
      s.reheat()
      publish()
    }
    start()
  }

  // MARK: Dragging a dot (force-graph's d3-drag handlers)

  /** Drag start: remember where it was, fix it where it is. */
  fun dragStart(i: Int) = synchronized(simLock) {
    val s = sim ?: return@synchronized
    if (i >= s.n) return@synchronized
    drag = Drag(i, s.x[i], s.y[i], s.fx[i], s.fy[i])
    s.fx[i] = s.x[i]; s.fy[i] = s.y[i]
  }

  /** Drag: fx = x = the start + the finger's travel / zoom; past 5 px the engine runs gently (alphaTarget 0.3). */
  fun dragMove(dx: Double, dy: Double, screenDistance: Double) {
    var run = false
    synchronized(simLock) {
      val s = sim ?: return
      val d = drag ?: return
      val nx = d.x + dx; val ny = d.y + dy
      s.fx[d.index] = nx; s.x[d.index] = nx
      s.fy[d.index] = ny; s.y[d.index] = ny
      if (d.dragged || screenDistance > 5) {
        d.dragged = true
        s.alphaTarget = 0.3
        s.resetCountdown()
        run = true
      }
      publish()
    }
    if (run) start()
  }

  sealed interface DragEnd {
    /** Moved: pinned here (rounded, as the desktop saves pins). */
    data class Pinned(val x: Double, val y: Double) : DragEnd
    /** Held without moving: a press. */
    data object Pressed : DragEnd
    /** The graph changed under the finger. */
    data object Lost : DragEnd
  }

  /** Drag end: release the target heat; a real drag pins the dot where it was let go (onNodeDragEnd). */
  fun dragEnd(): DragEnd {
    val result: DragEnd
    synchronized(simLock) {
      val s = sim
      val d = drag
      if (s == null || d == null) return DragEnd.Lost
      drag = null
      if (d.fx.isNaN()) s.fx[d.index] = Double.NaN
      if (d.fy.isNaN()) s.fy[d.index] = Double.NaN
      if (s.alphaTarget != 0.0) { s.alphaTarget = 0.0; s.resetCountdown() }
      result = if (d.dragged) {
        s.fx[d.index] = s.x[d.index]; s.fy[d.index] = s.y[d.index]
        publish()
        DragEnd.Pinned(Math.round(s.x[d.index]).toDouble(), Math.round(s.y[d.index]).toDouble())
      } else DragEnd.Pressed
    }
    start()
    return result
  }

  // MARK: Running

  /** Stop ticking while the screen is away (desktop: pauseAnimation), go on when it's back. */
  fun setPaused(p: Boolean) {
    if (p) {
      synchronized(simLock) { paused = true; ticking = false }
      job?.cancel(); job = null
    } else {
      synchronized(simLock) { paused = false }
      start()
    }
  }

  /** Previews and tests: tick to rest right here. */
  fun settleNow(maxTicks: Int = 900) = synchronized(simLock) {
    val s = sim ?: return@synchronized
    var n = 0
    while (n < maxTicks && s.step()) n++
    publish()
  }

  private fun start() {
    synchronized(simLock) {
      if (paused || ticking || sim?.running != true) return
      ticking = true
    }
    val run = ++runs
    job = scope.launch(Dispatchers.Default) {
      scope.launch(Dispatchers.Main) { onRunning(true) }
      var next = System.nanoTime()
      while (isActive) {
        val ticked = synchronized(simLock) {
          val s = sim
          val t = !paused && s != null && s.step().also { if (it) publish() }
          if (!t) ticking = false
          t
        }
        if (!ticked) break
        next += 16_666_667L
        val wait = (next - System.nanoTime()) / 1_000_000
        if (wait > 0) delay(wait) else next = System.nanoTime()
      }
      // Only the newest loop reports stopping (a paused-then-resumed one may still be winding down).
      scope.launch(Dispatchers.Main) { if (run == runs) onRunning(false) }
    }
  }

  private fun publish() {
    val s = sim ?: return
    val n = s.n
    if (back.xs.size != n) { back.xs = FloatArray(n); back.ys = FloatArray(n) }
    back.generation = generation
    val xs = back.xs; val ys = back.ys
    for (i in 0 until n) { xs[i] = s.x[i].toFloat(); ys[i] = s.y[i].toFloat() }
    synchronized(bufferLock) {
      val t = shared; shared = back; back = t
      sharedVersion++
    }
  }

  /** Main thread: the newest positions, if there are newer ones than last time. */
  fun pull(): Boolean = synchronized(bufferLock) {
    if (sharedVersion == frontVersion) return false
    val t = front; front = shared; shared = t
    frontVersion = sharedVersion
    true
  }
}
