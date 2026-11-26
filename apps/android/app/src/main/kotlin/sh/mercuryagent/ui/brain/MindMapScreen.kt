package sh.mercuryagent.ui.brain

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculateCentroidSize
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.FilterCenterFocus
import androidx.compose.material.icons.outlined.FitScreen
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Remove
import androidx.compose.material.icons.outlined.RestartAlt
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.abs
import sh.mercuryagent.core.BrainWeb
import sh.mercuryagent.core.LocalGraph
import sh.mercuryagent.ui.theme.Mercury

/**
 * Brain → Mind map: every note a dot, every "related" link a line, dots coloured by theme and sized
 * by connections (Mercury Desktop's NoteWeb, same layout and look). Tap a dot to light its
 * neighbourhood and open the note; hold and drag a dot to pin it; pinch and pan to move around.
 * The chrome is the app's monochrome Material 3; the dots keep their theme hues. iOS: MindMapScreen.swift.
 */
@Composable
fun MindMapScreen(vm: MindMapViewModel, onBack: () -> Unit) {
  DisposableEffect(vm) {
    vm.appear()
    onDispose { vm.disappear() }
  }
  BackHandler(enabled = vm.showDetail) { vm.showDetail = false }
  val bg = MaterialTheme.colorScheme.background
  Box(Modifier.fillMaxSize().background(bg)) {
    MindMapCanvas(vm, Modifier.fillMaxSize())
    States(vm, Modifier.align(Alignment.Center))
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
      TopBar(vm, onBack)
      Spacer(Modifier.weight(1f))
      BottomBar(vm)
    }
    AnimatedVisibility(
      vm.showDetail && vm.selected != null, Modifier.align(Alignment.BottomCenter),
      enter = slideInVertically { it }, exit = slideOutVertically { it },
    ) {
      vm.selected?.let { NotePanel(vm, it) }
    }
  }
  if (vm.showSettings) MindMapSettingsSheet(vm) { vm.showSettings = false }
}

/** The map and its touch: one finger pans, two pinch (around the fingers) and pan, tap selects, double tap zooms in, hold-and-drag pins. */
@Composable
fun MindMapCanvas(vm: MindMapViewModel, modifier: Modifier = Modifier) {
  val density = LocalDensity.current.density
  val dark = Mercury.colors.dark
  val haptics = LocalHapticFeedback.current
  val focus = LocalFocusManager.current
  // Redraw every display frame while something moves; otherwise the canvas is still.
  val live = vm.live
  LaunchedEffect(live) { if (live) while (true) withFrameNanos { vm.frame.longValue = it } }
  Canvas(
    modifier
      .pointerInput(vm) {
        // Pan and pinch (Compose's detectTransformGestures, with an end so the frame loop can stop).
        awaitEachGesture {
          awaitFirstDown(requireUnconsumed = false)
          var zoomAcc = 1f
          var panAcc = Offset.Zero
          var moving = false
          do {
            val event = awaitPointerEvent()
            if (event.changes.any { it.isConsumed } || vm.isDragging) break
            val zoom = event.calculateZoom()
            val pan = event.calculatePan()
            if (!moving) {
              zoomAcc *= zoom; panAcc += pan
              val centroidSize = event.calculateCentroidSize(useCurrent = false)
              if (abs(1 - zoomAcc) * centroidSize > viewConfiguration.touchSlop || panAcc.getDistance() > viewConfiguration.touchSlop) {
                moving = true; vm.gesturing = true
              }
            }
            if (moving) {
              val c = event.calculateCentroid(useCurrent = true)
              if (zoom != 1f || pan != Offset.Zero) {
                if (c.isSpecified()) vm.pinch(c.x / density.toDouble(), c.y / density.toDouble(), zoom.toDouble(), pan.x / density.toDouble(), pan.y / density.toDouble())
              }
              event.changes.forEach { if (it.positionChanged()) it.consume() }
            }
          } while (event.changes.any { it.pressed })
          if (moving) { vm.gesturing = vm.isDragging; vm.updateZoomPct() }
        }
      }
      .pointerInput(vm) {
        detectTapGestures(
          onTap = { focus.clearFocus(); vm.tap(it.x / density.toDouble(), it.y / density.toDouble()) },
          onDoubleTap = { vm.zoom(2.0, it.x / density.toDouble(), it.y / density.toDouble()) },
        )
      }
      .pointerInput(vm) {
        detectDragGesturesAfterLongPress(
          onDragStart = { o ->
            vm.pick(o.x / density.toDouble(), o.y / density.toDouble())?.let { i ->
              haptics.performHapticFeedback(HapticFeedbackType.LongPress)
              vm.dragBegan(i, o.x / density.toDouble(), o.y / density.toDouble())
            }
          },
          onDrag = { change, _ -> if (vm.isDragging) { change.consume(); vm.dragMoved(change.position.x / density.toDouble(), change.position.y / density.toDouble()) } },
          onDragEnd = { vm.dragEnded() },
          onDragCancel = { vm.dragEnded() },
        )
      }
      .semantics { contentDescription = "Mind map of ${vm.graph.nodes.size} notes" },
  ) {
    vm.frame.longValue
    val w = size.width / density; val h = size.height / density
    vm.width = w.toDouble(); vm.height = h.toDouble()
    vm.advance(System.nanoTime())
    vm.engine.pull()
    drawIntoCanvas { vm.renderer.draw(it.nativeCanvas, density, w, h, vm, dark) }
  }
}

private fun Offset.isSpecified() = !x.isNaN() && !y.isNaN()

@Composable
private fun TopBar(vm: MindMapViewModel, onBack: () -> Unit) {
  val chip = MaterialTheme.colorScheme.surfaceContainerHigh
  Column(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      RoundButton(Icons.AutoMirrored.Outlined.ArrowBack, "Back", onBack)
      Row(
        Modifier.weight(1f).height(44.dp).clip(CircleShape).background(chip).padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        Icon(Icons.Outlined.Search, null, Modifier.size(18.dp), tint = Mercury.colors.ink3)
        Box(Modifier.weight(1f)) {
          if (vm.query.isEmpty()) Text("Filter notes", color = Mercury.colors.ink3, style = MaterialTheme.typography.bodyLarge)
          BasicTextField(
            vm.query, vm::filter, singleLine = true,
            textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.onSurface),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Filter notes" },
          )
        }
        if (vm.query.isNotEmpty()) Icon(
          Icons.Outlined.Close, "Clear filter", tint = Mercury.colors.ink3,
          modifier = Modifier.clip(CircleShape).clickable { vm.filter("") }.padding(4.dp).size(18.dp),
        )
      }
      Box(contentAlignment = Alignment.Center) {
        RoundButton(Icons.Outlined.Refresh, "Reload") { vm.reload() }
        if (vm.loading && vm.data != null) CircularProgressIndicator(Modifier.size(44.dp), strokeWidth = 2.dp, color = Mercury.colors.ink3)
      }
      RoundButton(Icons.Outlined.Tune, "Graph settings") { vm.showDetail = false; vm.showSettings = true }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
      if (vm.data != null) {
        Text(
          "${vm.graph.nodes.size} notes · ${vm.graph.links.size} links", style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3,
          modifier = Modifier.clip(CircleShape).background(chip).padding(horizontal = 12.dp, vertical = 7.dp),
        )
      }
      val local = vm.local
      val selected = vm.selected
      if (local != null) {
        Row(
          Modifier.clip(CircleShape).background(chip).padding(start = 12.dp, end = 4.dp).height(32.dp),
          verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
          Icon(Icons.Outlined.FilterCenterFocus, null, Modifier.size(16.dp))
          Text("Local", style = MaterialTheme.typography.labelLarge)
          Text("depth", style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3)
          for (d in 1..3) {
            val on = local.depth == d
            Text(
              "$d", style = MaterialTheme.typography.labelLarge.copy(fontFamily = FontFamily.Monospace), textAlign = TextAlign.Center,
              color = if (on) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
              modifier = Modifier.clip(RoundedCornerShape(7.dp)).background(if (on) MaterialTheme.colorScheme.primary else Color.Transparent)
                .clickable { vm.showLocal(LocalGraph(local.id, d)) }.width(26.dp).padding(vertical = 3.dp)
                .semantics { contentDescription = "Local graph depth $d" },
            )
          }
          Icon(
            Icons.Outlined.Close, "Back to the whole web", tint = Mercury.colors.ink3,
            modifier = Modifier.clip(CircleShape).clickable { vm.showLocal(null) }.padding(5.dp).size(16.dp),
          )
        }
      } else if (selected != null) {
        Row(
          Modifier.clip(CircleShape).background(chip).clickable { vm.showLocal(LocalGraph(selected, 1)) }.padding(horizontal = 12.dp).height(32.dp),
          verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          Icon(Icons.Outlined.FilterCenterFocus, null, Modifier.size(16.dp))
          Text("Local graph", style = MaterialTheme.typography.labelLarge)
        }
      }
    }
  }
}

@Composable
private fun RoundButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
  Box(
    Modifier.size(44.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainerHigh).clickable(onClick = onClick)
      .semantics { contentDescription = label },
    contentAlignment = Alignment.Center,
  ) { Icon(icon, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurface) }
}

@Composable
private fun BottomBar(vm: MindMapViewModel) {
  Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.Bottom) {
    if (vm.data?.notes?.isNotEmpty() == true) {
      Text(
        "Tap to open · hold and drag to pin · pinch to zoom", style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3,
        maxLines = 1, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.weight(1f, fill = false).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = 0.92f))
          .padding(horizontal = 10.dp, vertical = 6.dp),
      )
    }
    Spacer(Modifier.weight(1f))
    // Map-style controls, bottom right: in, level, out, fit, reset layout (desktop's ZoomPanel).
    Column(
      Modifier.clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh).padding(4.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      ZoomButton(Icons.Outlined.Add, "Zoom in") { vm.zoom(1.4) }
      Text("${vm.zoomPct}%", style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 11.sp), color = Mercury.colors.ink3)
      ZoomButton(Icons.Outlined.Remove, "Zoom out") { vm.zoom(1 / 1.4) }
      HorizontalDivider(Modifier.width(24.dp).padding(vertical = 2.dp), color = Mercury.colors.line)
      ZoomButton(Icons.Outlined.FitScreen, "Fit to screen") { vm.fit(60.0, 0.5) }
      ZoomButton(Icons.Outlined.RestartAlt, "Reset layout") { vm.resetLayout() }
    }
  }
}

@Composable
private fun ZoomButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
  Box(
    Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)).clickable(onClick = onClick).semantics { contentDescription = label },
    contentAlignment = Alignment.Center,
  ) { Icon(icon, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant) }
}

@Composable
private fun States(vm: MindMapViewModel, modifier: Modifier) {
  val ink3 = Mercury.colors.ink3
  Box(modifier.padding(32.dp)) {
    val e = vm.error
    val d = vm.data
    when {
      e != null -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Couldn't load the mind map: $e", color = ink3, textAlign = TextAlign.Center)
        Text(
          "Retry", style = MaterialTheme.typography.labelLarge,
          modifier = Modifier.clip(CircleShape).border(1.dp, Mercury.colors.ink4, CircleShape).clickable { vm.reload() }.padding(horizontal = 18.dp, vertical = 9.dp),
        )
      }
      d == null -> CircularProgressIndicator(color = ink3)
      d.notes.isEmpty() -> Text("Nothing here yet. Notes appear as Mercury learns about you.", color = ink3, textAlign = TextAlign.Center)
      vm.graph.nodes.isEmpty() -> Text("No notes match.", color = ink3)
    }
  }
}

/** A tapped note: its text, kind, theme, what Mercury knows about it, and the notes it links to. The map stays live above it. */
@Composable
private fun NotePanel(vm: MindMapViewModel, id: String) {
  LaunchedEffect(id) { vm.loadDetail(id) }
  val note = vm.note(id)
  val theme = vm.theme(id)
  val m = vm.detail
  BoxWithConstraints(Modifier.fillMaxWidth()) {
    Surface(
      Modifier.fillMaxWidth().heightIn(max = maxHeight * 0.55f),
      shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp), color = MaterialTheme.colorScheme.surfaceContainerLow, shadowElevation = 8.dp,
    ) {
      Column(Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding().padding(horizontal = 20.dp).padding(top = 10.dp, bottom = 24.dp)) {
        Box(Modifier.align(Alignment.CenterHorizontally).size(36.dp, 4.dp).clip(CircleShape).background(Mercury.colors.ink4))
        Row(Modifier.padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          if (theme != null) {
            Box(Modifier.size(9.dp).clip(CircleShape).background(hexColor(theme.second)))
            Text(theme.first.uppercase(), style = MaterialTheme.typography.labelMedium, color = Mercury.colors.ink3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
          }
          Spacer(Modifier.weight(1f))
          val kind = note?.kind?.takeIf { it.isNotEmpty() } ?: m?.type
          if (!kind.isNullOrEmpty()) Pill(BrainWeb.KIND_LABEL[kind] ?: kind, MaterialTheme.colorScheme.surfaceContainerHighest, MaterialTheme.colorScheme.onSurfaceVariant)
          if (m?.evidenceKind == "owner") Pill("you said", MaterialTheme.colorScheme.primary, MaterialTheme.colorScheme.onPrimary)
          Icon(
            Icons.Outlined.Close, "Close", tint = Mercury.colors.ink3,
            modifier = Modifier.clip(CircleShape).clickable { vm.showDetail = false }.padding(6.dp).size(18.dp),
          )
        }
        Text(m?.summary ?: note?.text.orEmpty(), style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Normal), modifier = Modifier.padding(top = 12.dp))
        m?.detail?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 10.dp)) }
        when {
          m != null -> Column(
            Modifier.padding(top = 14.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
          ) {
            Fact("Confidence", "${Math.round(m.confidence * 100)}%")
            m.evidenceCount?.let { Fact("Evidence", "$it") }
            m.createdAt?.let { Fact("First learned", date(it)) }
            m.updatedAt?.let { Fact("Last updated", date(it)) }
          }
          vm.detailError != null -> Text(vm.detailError!!, color = Mercury.colors.red, modifier = Modifier.padding(top = 14.dp))
          else -> CircularProgressIndicator(Modifier.padding(top = 14.dp).size(20.dp), strokeWidth = 2.dp, color = Mercury.colors.ink3)
        }
        val related = vm.data?.let { BrainWeb.related(it, id) }.orEmpty()
        if (related.isNotEmpty()) {
          Text("Linked notes", style = MaterialTheme.typography.labelLarge, color = Mercury.colors.ink3, modifier = Modifier.padding(top = 18.dp, bottom = 4.dp))
          for ((n, _) in related) {
            Row(
              Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable { vm.jump(n.id) }.padding(vertical = 10.dp),
              verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
              Box(Modifier.size(8.dp).clip(CircleShape).background(hexColor(vm.theme(n.id)?.second ?: BrainWeb.LOOSE_COLOR)))
              Text(n.text, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
              Icon(Icons.Outlined.ChevronRight, null, Modifier.size(18.dp), tint = Mercury.colors.ink4)
            }
          }
        }
      }
    }
  }
}

@Composable
private fun Pill(text: String, bg: Color, fg: Color) {
  Text(text, style = MaterialTheme.typography.labelMedium, color = fg, modifier = Modifier.clip(CircleShape).background(bg).padding(horizontal = 8.dp, vertical = 3.dp))
}

@Composable
private fun Fact(k: String, v: String) {
  Row(Modifier.fillMaxWidth()) {
    Text(k, color = Mercury.colors.ink3, style = MaterialTheme.typography.bodyMedium)
    Spacer(Modifier.weight(1f))
    Text(v, style = MaterialTheme.typography.bodyMedium)
  }
}

private fun date(ms: Double): String =
  java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM).format(java.util.Date(ms.toLong()))

fun hexColor(hex: String): Color = Color(0xFF000000.toInt() or (hex.removePrefix("#").toIntOrNull(16) ?: 0x8A97A3))

/** The desktop's graph settings panel: Filters, Groups, Display, Forces, Restore defaults. Forces apply live. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MindMapSettingsSheet(vm: MindMapViewModel, onDismiss: () -> Unit) {
  val state = rememberModalBottomSheetState(skipPartiallyExpanded = false)
  ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = MaterialTheme.colorScheme.surfaceContainerLow) {
    val s = vm.settings
    Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Text("Graph settings", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(bottom = 8.dp))
      Section("Filters")
      SwitchRow("Orphans", s.orphans) { v -> vm.updateSettings { it.copy(orphans = v) } }
      SwitchRow("Archive", vm.archive) { vm.useArchive(it) }
      Section("Groups")
      for (t in vm.groups) {
        val off = t.id in s.hidden
        Row(
          Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { vm.toggleGroup(t.id) }.padding(horizontal = 4.dp, vertical = 9.dp)
            .semantics { contentDescription = "${t.label}, ${if (off) "hidden" else "shown"}" },
          verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
          val a = if (off) 0.4f else 1f
          Box(Modifier.size(10.dp).clip(CircleShape).background(hexColor(t.color).copy(alpha = a)))
          Text(t.label, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurface.copy(alpha = a), modifier = Modifier.weight(1f))
          Text("${t.size}", fontFamily = FontFamily.Monospace, color = Mercury.colors.ink3.copy(alpha = a), style = MaterialTheme.typography.bodySmall)
        }
      }
      Section("Display")
      SliderRow("Node size", s.nodeSize, 0.4..2.5, 0.1) { v -> vm.updateSettings { it.copy(nodeSize = v) } }
      SliderRow("Link thickness", s.linkWidth, 0.2..3.0, 0.1) { v -> vm.updateSettings { it.copy(linkWidth = v) } }
      SliderRow("Text fade threshold", s.textFade, 0.3..4.0, 0.1) { v -> vm.updateSettings { it.copy(textFade = v) } }
      Section("Forces")
      SliderRow("Center force", s.center, 0.0..0.3, 0.01) { v -> vm.updateSettings { it.copy(center = v) } }
      SliderRow("Repel force", s.repel, 0.0..200.0, 2.0) { v -> vm.updateSettings { it.copy(repel = v) } }
      SliderRow("Link force", s.linkForce, 0.0..1.0, 0.02) { v -> vm.updateSettings { it.copy(linkForce = v) } }
      SliderRow("Link distance", s.linkDistance, 8.0..200.0, 2.0) { v -> vm.updateSettings { it.copy(linkDistance = v) } }
      TextButton(onClick = { vm.restoreDefaults() }, modifier = Modifier.padding(top = 8.dp)) {
        Text("Restore defaults", color = MaterialTheme.colorScheme.onSurface)
      }
    }
  }
}

@Composable
private fun Section(title: String) {
  Text(title.uppercase(), style = MaterialTheme.typography.labelSmall, color = Mercury.colors.ink3, modifier = Modifier.padding(top = 14.dp, bottom = 2.dp))
}

@Composable
private fun SwitchRow(label: String, on: Boolean, onChange: (Boolean) -> Unit) {
  Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
    Text(label, modifier = Modifier.weight(1f))
    Switch(
      on, onChange,
      colors = SwitchDefaults.colors(checkedTrackColor = MaterialTheme.colorScheme.primary, checkedThumbColor = MaterialTheme.colorScheme.onPrimary),
    )
  }
}

/** Number(value.toFixed(2)), as the desktop shows it. */
fun formatSetting(v: Double): String {
  val r = Math.round(v * 100) / 100.0
  return if (r == Math.rint(r)) r.toLong().toString() else r.toString()
}

@Composable
private fun SliderRow(label: String, value: Double, range: ClosedFloatingPointRange<Double>, step: Double, onChange: (Double) -> Unit) {
  Column(Modifier.fillMaxWidth()) {
    Row(Modifier.fillMaxWidth().padding(top = 6.dp)) {
      Text(label, modifier = Modifier.weight(1f))
      Text(formatSetting(value), fontFamily = FontFamily.Monospace, color = Mercury.colors.ink3, style = MaterialTheme.typography.bodySmall)
    }
    val steps = Math.round((range.endInclusive - range.start) / step).toInt() - 1
    Slider(
      value.toFloat(), { v -> onChange(range.start + Math.round((v - range.start) / step) * step) },
      valueRange = range.start.toFloat()..range.endInclusive.toFloat(), steps = maxOf(0, steps),
      colors = SliderDefaults.colors(
        thumbColor = MaterialTheme.colorScheme.primary, activeTrackColor = MaterialTheme.colorScheme.primary,
        activeTickColor = Color.Transparent, inactiveTickColor = Color.Transparent,
      ),
    )
  }
}
