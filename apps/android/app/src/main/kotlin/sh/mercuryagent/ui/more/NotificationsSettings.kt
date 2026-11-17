package sh.mercuryagent.ui.more

import android.Manifest
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.NotificationsOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import sh.mercuryagent.AppContainer
import sh.mercuryagent.notify.Notice
import sh.mercuryagent.notify.NotifyPrefs
import sh.mercuryagent.ui.theme.Mercury

/** What this phone tells you about, whether Android lets it, and the background connection (iOS: NotificationsSettings). */
@Composable
fun NotificationsSettings(container: AppContainer, onBack: () -> Unit) {
  val prefs by container.notifyPrefs.state.collectAsStateWithLifecycle()
  val context = LocalContext.current
  var allowed by remember { mutableStateOf(container.notifier.canPost) }
  var tick by remember { mutableIntStateOf(0) }
  var picking by remember { mutableStateOf(false) }
  LifecycleResumeEffect(tick) { allowed = container.notifier.canPost; onPauseOrDispose {} }
  val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = container.notifier.canPost; tick++ }
  fun set(change: (NotifyPrefs) -> NotifyPrefs) = container.notifyPrefs.update(change)
  val openSystem = {
    context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
  }

  SettingsPage("Notifications", onBack) {
    item {
      ListItem(
        headlineContent = { Text(if (allowed) "On" else "Off for Mercury") },
        supportingContent = {
          Column {
            Text(
              if (allowed) "Mercury tells you when a chat needs you, finishes a long task or fails, unless you're looking at it."
              else "Android isn't showing Mercury's notifications.",
            )
            if (!allowed) {
              val firstAsk = Build.VERSION.SDK_INT >= 33 && !prefs.asked
              Button(
                onClick = {
                  if (firstAsk) { set { it.copy(asked = true) }; ask.launch(Manifest.permission.POST_NOTIFICATIONS) } else openSystem()
                },
                modifier = Modifier.padding(top = 8.dp),
              ) { Text(if (firstAsk) "Turn on notifications" else "Open Android settings") }
            }
          }
        },
        leadingContent = { Icon(if (allowed) Icons.Outlined.NotificationsActive else Icons.Outlined.NotificationsOff, null, tint = if (allowed) Mercury.colors.green else Mercury.colors.ink3) },
      )
    }

    item { SettingsHeader("Tell me when") }
    item { ToggleRow("Mercury needs an answer", "A permission, a choice or a question", prefs.needsYou) { v -> set { it.copy(needsYou = v) } } }
    item { ToggleRow("A long task finishes", "With the first words of the reply, and research reports", prefs.done) { v -> set { it.copy(done = v) } } }
    if (prefs.done) item {
      ListItem(
        headlineContent = { Text("Long means over") },
        supportingContent = { Text(NotifyPrefs.afterChoices.firstOrNull { it.first == prefs.doneAfterSec }?.second ?: "${prefs.doneAfterSec} seconds") },
        modifier = Modifier.clickable(onClickLabel = "Change") { picking = true }.padding(start = 16.dp),
      )
    }
    item { ToggleRow("Something fails", null, prefs.failed) { v -> set { it.copy(failed = v) } } }
    item { ToggleRow("A bot has news", "Its results, failures and questions", prefs.bots) { v -> set { it.copy(bots = v) } } }

    item { SettingsHeader("In the background") }
    item {
      ToggleRow(
        "Stay connected",
        "Keep listening even when nothing is running, with a quiet notification that says so. Off: Mercury listens in the background only while a chat is working or waiting on you.",
        prefs.stayConnected,
      ) { v ->
        set { it.copy(stayConnected = v) }
        if (v && !allowed && Build.VERSION.SDK_INT >= 33 && !prefs.asked) { set { it.copy(asked = true) }; ask.launch(Manifest.permission.POST_NOTIFICATIONS) }
      }
    }

    item { SettingsHeader("On this phone") }
    item {
      ListItem(
        headlineContent = { Text("Sounds and pop-ups") },
        supportingContent = { Text("Needs you, Finished and Failed each have their own Android settings") },
        modifier = Modifier.clickable(onClick = openSystem),
      )
    }
    if (allowed) item {
      OutlinedButton(
        onClick = { container.notifier.post(Notice(Notice.Kind.Done, "test", "Mercury", "Notifications are working. You'll see this when a long task finishes.")) },
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
      ) { Text("Send a test notification") }
    }
  }

  if (picking) AlertDialog(
    onDismissRequest = { picking = false },
    title = { Text("Long means over") },
    text = {
      Column {
        NotifyPrefs.afterChoices.forEach { (sec, label) ->
          ListItem(
            headlineContent = { Text(label) },
            leadingContent = { RadioButton(selected = prefs.doneAfterSec == sec, onClick = null) },
            modifier = Modifier.clickable(role = Role.RadioButton) { set { it.copy(doneAfterSec = sec) }; picking = false },
          )
        }
      }
    },
    confirmButton = { TextButton(onClick = { picking = false }) { Text("Done") } },
  )
}

@Composable
fun ToggleRow(title: String, detail: String?, on: Boolean, onChange: (Boolean) -> Unit) {
  ListItem(
    headlineContent = { Text(title) },
    supportingContent = detail?.let { { Text(it, style = MaterialTheme.typography.bodyMedium) } },
    trailingContent = { Switch(on, onCheckedChange = null) },
    modifier = Modifier.clickable(role = Role.Switch) { onChange(!on) },
  )
}
