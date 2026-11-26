package sh.mercuryagent.ui.more

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import sh.mercuryagent.AppContainer
import sh.mercuryagent.call.RingTelecom
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.ReachSettings
import sh.mercuryagent.core.reachSettings
import sh.mercuryagent.core.testRing
import sh.mercuryagent.core.updateReachSettings

/**
 * Settings → Calls from Mercury (ADR-046; iOS: CallsSettings): whether Mercury may ring this phone,
 * the full-screen permission Android 14+ asks for once, the owner's calls switch and quiet hours
 * (for every phone), and a test ring.
 */
@Composable
fun CallsSettings(container: AppContainer, client: MercuryClient, onBack: () -> Unit) {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  var ringOn by remember { mutableStateOf(container.ringer.ringOn) }
  var notifyOn by remember { mutableStateOf(container.ringer.notifyOn) }
  var fullScreen by remember { mutableStateOf(RingTelecom.canRingFullScreen(context)) }
  var settings by remember { mutableStateOf<ReachSettings?>(null) }
  var error by remember { mutableStateOf<String?>(null) }
  var tested by remember { mutableStateOf<String?>(null) }
  var picking by remember { mutableStateOf<String?>(null) }
  val problem by container.reachProblem.collectAsStateWithLifecycle()
  LifecycleResumeEffect(Unit) { fullScreen = RingTelecom.canRingFullScreen(context); onPauseOrDispose {} }
  LaunchedEffect(client.baseUrl) {
    try { settings = client.reachSettings(); error = null } catch (e: Exception) { error = e.message }
  }
  fun save(s: ReachSettings) {
    settings = s
    scope.launch { try { settings = client.updateReachSettings(s); error = null } catch (e: Exception) { error = e.message } }
  }

  SettingsPage("Calls from Mercury", onBack) {
    item {
      ToggleRow("Ring this phone", "Mercury calls you here while the app is open or still running", ringOn) { v -> ringOn = v; container.setReach(ring = v) }
    }
    item { ToggleRow("Show Mercury's notifications", null, notifyOn) { v -> notifyOn = v; container.setReach(notify = v) } }
    if (ringOn && !fullScreen && Build.VERSION.SDK_INT >= 34) item {
      ListItem(
        headlineContent = { Text("Let calls show on the lock screen") },
        supportingContent = {
          androidx.compose.foundation.layout.Column {
            Text("Android asks once before an app can show an incoming call full screen. Without it, Mercury's calls ring as a notification.")
            Button(
              onClick = {
                runCatching {
                  context.startActivity(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}")))
                }
              },
              modifier = Modifier.padding(top = 8.dp),
            ) { Text("Allow") }
          }
        },
      )
    }
    item {
      ListItem(
        headlineContent = { Text("Test ring") },
        supportingContent = { Text(tested ?: "Mercury rings this phone now") },
        modifier = Modifier.clickable(enabled = ringOn) {
          tested = "Ringing…"
          scope.launch { tested = try { client.testRing(); "Ringing…" } catch (e: Exception) { e.message } }
        },
      )
    }
    problem?.let { p -> item { Text(p, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) } }

    settings?.let { s ->
      item { SettingsHeader("All your phones") }
      item { ToggleRow("Calls from Mercury", "When off, Mercury sends a notification instead of ringing", s.calls) { save(s.copy(calls = it)) } }
      item { ToggleRow("Quiet hours", "Only urgent calls ring; notifications arrive silently", s.quietHours) { save(s.copy(quietHours = it)) } }
      if (s.quietHours) {
        item { ListItem(headlineContent = { Text("From") }, trailingContent = { Text(s.quietStart) }, modifier = Modifier.clickable { picking = "start" }) }
        item { ListItem(headlineContent = { Text("Until") }, trailingContent = { Text(s.quietEnd) }, modifier = Modifier.clickable { picking = "end" }) }
      }
      item {
        Text(
          "When no phone is connected or nobody answers, Mercury tries WhatsApp (if linked), tries once more after 5 minutes, then leaves a missed call you'll see when you open Mercury. At most ${s.maxCallsPerHour} calls an hour.",
          style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
          modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
        )
      }
    }
    error?.let { e -> item { Text(e, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) } }
  }

  val s = settings
  val which = picking
  if (s != null && which != null) {
    QuietTimeDialog(if (which == "start") s.quietStart else s.quietEnd, onDismiss = { picking = null }) { hhmm ->
      picking = null
      save(if (which == "start") s.copy(quietStart = hhmm) else s.copy(quietEnd = hhmm))
    }
  }
}

/** "HH:MM" ↔ hour and minute. */
fun parseHhmm(s: String): Pair<Int, Int> {
  val p = s.split(":").mapNotNull { it.toIntOrNull() }
  return (p.getOrNull(0) ?: 0).coerceIn(0, 23) to (p.getOrNull(1) ?: 0).coerceIn(0, 59)
}

fun formatHhmm(h: Int, m: Int): String = "%02d:%02d".format(h, m)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun QuietTimeDialog(value: String, onDismiss: () -> Unit, onPick: (String) -> Unit) {
  val (h, m) = parseHhmm(value)
  val state = rememberTimePickerState(initialHour = h, initialMinute = m, is24Hour = true)
  AlertDialog(
    onDismissRequest = onDismiss,
    confirmButton = { TextButton(onClick = { onPick(formatHhmm(state.hour, state.minute)) }) { Text("Set") } },
    dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    text = { TimePicker(state = state) },
  )
}
