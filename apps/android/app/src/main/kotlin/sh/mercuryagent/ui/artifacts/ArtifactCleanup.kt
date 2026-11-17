package sh.mercuryagent.ui.artifacts

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sh.mercuryagent.core.ArtifactCleanup
import sh.mercuryagent.core.ArtifactFormat
import sh.mercuryagent.core.ArtifactUsage
import sh.mercuryagent.ui.components.ErrorText
import sh.mercuryagent.ui.theme.Mercury

/**
 * Clean up, behind the overflow menu in Artifacts (iOS: ArtifactCleanupSheet, Mercury Desktop's
 * Cleanup dialog): the space what Mercury made takes, counted the way the disk counts it, and ways
 * to give it back: a kind at a time, everything older than a while, or all of it. Files Mercury
 * wrote into a project are never deleted from here; only its copy goes.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArtifactCleanupSheet(ui: ArtifactsUi, onDismiss: () -> Unit, onAge: (Int) -> Unit, onRun: (ArtifactCleanup) -> Unit) {
  val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
  val scope = rememberCoroutineScope()
  var confirm by remember { mutableStateOf<ArtifactCleanup?>(null) }
  val u = ui.usage
  val c = ui.cleanup

  ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state) {
    Column(
      Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = 24.dp),
      verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Clean up", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).semantics { heading() })
        TextButton(onClick = { scope.launch { state.hide() }.invokeOnCompletion { onDismiss() } }) { Text("Done") }
      }
      when {
        u != null -> {
          Total(u)
          Kinds(u, busy = c.busy) { confirm = ArtifactCleanup.OfKind(it) }
          Older(u, age = c.age, busy = c.busy, onAge = onAge) { confirm = ArtifactCleanup.OlderThan(c.age) }
          Everything(u, busy = c.busy) { confirm = ArtifactCleanup.All }
        }
        c.error != null -> ErrorText(c.error)
        else -> Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
      }
      if (c.busy) Text("Deleting…", style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3)
      c.note?.let { note ->
        Row(
          horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
          modifier = Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        ) {
          Icon(Icons.Filled.CheckCircle, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurface)
          Text(note, style = MaterialTheme.typography.bodyMedium)
        }
      }
      if (c.error != null && u != null) ErrorText(c.error)
    }
  }

  confirm?.let { scopeToDelete ->
    AlertDialog(
      onDismissRequest = { confirm = null },
      title = { Text(cleanupTitle(scopeToDelete, u)) },
      text = { Text(ArtifactFormat.outsideNote(u?.outside ?: 0) + " This can't be undone.") },
      confirmButton = {
        TextButton(onClick = { confirm = null; onRun(scopeToDelete) }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
      },
      dismissButton = { TextButton(onClick = { confirm = null }) { Text("Cancel") } },
    )
  }
}

internal fun cleanupTitle(scope: ArtifactCleanup, u: ArtifactUsage?): String = when (scope) {
  is ArtifactCleanup.OfKind -> "Delete ${u?.byKind?.get(scope.kind)?.count ?: 0} ${ArtifactFormat.kindLabel(scope.kind).lowercase()}?"
  is ArtifactCleanup.OlderThan -> "Delete everything older than ${scope.days} days?"
  is ArtifactCleanup.All -> "Delete all ${u?.count ?: 0}?"
  is ArtifactCleanup.Ids -> "Delete ${scope.ids.size}?"
}

/**
 * A kind's shade in the bars. iOS and Desktop colour the kinds; this app is monochrome, so they
 * are steps of ink instead, darkest for the kinds that usually take the most.
 */
@Composable
private fun kindColor(kind: String): Color {
  val ink = MaterialTheme.colorScheme.onSurface
  return when (kind) {
    "image" -> ink
    "video" -> ink.copy(alpha = 0.72f)
    "audio" -> ink.copy(alpha = 0.52f)
    "pdf" -> ink.copy(alpha = 0.38f)
    "document" -> ink.copy(alpha = 0.27f)
    "text" -> ink.copy(alpha = 0.19f)
    else -> ink.copy(alpha = 0.13f)
  }
}

@Composable
private fun SectionTitle(text: String) {
  Text(
    text.uppercase(), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = Mercury.colors.ink3,
    modifier = Modifier.semantics { heading() },
  )
}

@Composable
private fun Total(u: ArtifactUsage) {
  Column(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.semantics(mergeDescendants = true) {}) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
      Box(
        Modifier.size(42.dp).clip(RoundedCornerShape(11.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh),
        contentAlignment = Alignment.Center,
      ) {
        Icon(Icons.Outlined.Storage, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
      }
      Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(ArtifactFormat.bytes(u.bytes), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        Text(
          "${u.count} artifact${if (u.count == 1) "" else "s"}" +
            (if (u.freeable < u.bytes) " · ${ArtifactFormat.bytes(u.freeable)} can be freed" else ""),
          style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3,
        )
      }
    }
    if (u.bytes > 0) {
      Row(
        Modifier.fillMaxWidth().height(8.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainerHigh)
          .clearAndSetSemantics {},
      ) {
        var used = 0f
        for (row in u.kinds) {
          val f = (row.usage.bytes.toFloat() / u.bytes.toFloat()).coerceIn(0f, 1f)
          if (f > 0f) {
            Box(Modifier.weight(f).fillMaxHeight().background(kindColor(row.kind)))
            used += f
          }
        }
        if (used < 0.999f) Spacer(Modifier.weight(1f - used))
      }
    }
  }
}

@Composable
private fun Kinds(u: ArtifactUsage, busy: Boolean, onDelete: (String) -> Unit) {
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    SectionTitle("By kind")
    Surface(
      shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.surfaceContainerLow,
      border = BorderStroke(1.dp, Mercury.colors.line), modifier = Modifier.fillMaxWidth(),
    ) {
      Column {
        val rows = u.kinds
        if (rows.isEmpty()) Text(
          "Nothing here yet.", style = MaterialTheme.typography.bodyMedium, color = Mercury.colors.ink3,
          modifier = Modifier.padding(14.dp),
        )
        rows.forEachIndexed { i, row ->
          if (i > 0) HorizontalDivider(Modifier.padding(start = 14.dp), color = Mercury.colors.line)
          val label = ArtifactFormat.kindLabel(row.kind)
          val color = kindColor(row.kind)
          Row(
            Modifier.fillMaxWidth().padding(start = 14.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Column(Modifier.weight(1f).semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(6.dp)) {
              Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(9.dp).clip(CircleShape).background(color))
                Text(label, style = MaterialTheme.typography.bodyLarge)
                Text("${row.usage.count}", style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, color = Mercury.colors.ink4)
                Spacer(Modifier.weight(1f))
                Text(ArtifactFormat.bytes(row.usage.bytes), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
              }
              Box(Modifier.fillMaxWidth().height(4.dp).clearAndSetSemantics {}) {
                Box(
                  Modifier.fillMaxWidth(row.share.toFloat().coerceIn(0.02f, 1f)).fillMaxHeight().clip(CircleShape).background(color),
                )
              }
            }
            Spacer(Modifier.width(4.dp))
            IconButton(onClick = { onDelete(row.kind) }, enabled = !busy) {
              Icon(
                Icons.Outlined.Delete, "Delete all ${label.lowercase()}",
                tint = if (busy) Mercury.colors.ink4 else MaterialTheme.colorScheme.error,
              )
            }
          }
        }
      }
    }
  }
}

@Composable
private fun Older(u: ArtifactUsage, age: Int, busy: Boolean, onAge: (Int) -> Unit, onDelete: () -> Unit) {
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    SectionTitle("Older than")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
      for (d in ArtifactsViewModel.ages) {
        FilterChip(selected = age == d, onClick = { onAge(d) }, label = { Text("$d days") })
      }
    }
    OutlinedButton(onClick = onDelete, enabled = !busy && u.count > 0, modifier = Modifier.heightIn(min = 48.dp)) {
      Text("Delete older than $age days")
    }
  }
}

@Composable
private fun Everything(u: ArtifactUsage, busy: Boolean, onDelete: () -> Unit) {
  Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(top = 4.dp)) {
    Text(ArtifactFormat.outsideNote(u.outside), style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3)
    val enabled = !busy && u.count > 0
    OutlinedButton(
      onClick = onDelete, enabled = enabled,
      modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
      colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
      border = BorderStroke(1.dp, if (enabled) MaterialTheme.colorScheme.error.copy(alpha = 0.5f) else Mercury.colors.line),
    ) {
      Icon(Icons.Outlined.Delete, null, Modifier.size(18.dp))
      Spacer(Modifier.width(8.dp))
      Text("Delete all", fontWeight = FontWeight.SemiBold)
    }
  }
}
