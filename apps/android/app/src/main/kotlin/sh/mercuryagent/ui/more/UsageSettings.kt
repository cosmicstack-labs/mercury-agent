package sh.mercuryagent.ui.more

import android.text.format.DateUtils
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.LaptopMac
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material.icons.outlined.PhoneIphone
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import sh.mercuryagent.core.BudgetState
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.PairedDevice
import sh.mercuryagent.core.Tokens
import sh.mercuryagent.core.UsageDay
import sh.mercuryagent.core.budget
import sh.mercuryagent.core.pairedDevices
import sh.mercuryagent.core.revokeDevice
import sh.mercuryagent.core.setBudget
import sh.mercuryagent.core.usageHistory
import sh.mercuryagent.ui.theme.Mercury

// MARK: Budgets

private val dailyPresets = listOf(500_000L, 1_000_000L, 2_000_000L, 5_000_000L, 10_000_000L)
private val perBotPresets = listOf(50_000L, 100_000L, 250_000L, 500_000L, 1_000_000L)
private val fleetPresets = listOf(250_000L, 500_000L, 1_000_000L, 2_000_000L, 5_000_000L)

/**
 * Budgets: how many tokens Mercury may use a day, when Token Saver steps in, and the caps for
 * bots. Saves apply at once (iOS: BudgetsSettings; apps/desktop/src/views/settings/Budgets.tsx).
 */
@Composable
fun BudgetsSettings(client: MercuryClient, onBack: () -> Unit) {
  val gate = rememberOwnerGate(client)
  val snackbar = remember { SnackbarHostState() }
  val scope = rememberCoroutineScope()
  var state by remember(client) { mutableStateOf<BudgetState?>(null) }
  var loadError by remember(client) { mutableStateOf<String?>(null) }

  suspend fun load() {
    try {
      state = client.budget(); loadError = null
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      loadError = e.message
      if (state != null) snackbar.showSnackbar(e.message ?: "Couldn't load the budgets.")
    }
  }

  LaunchedEffect(client) { load() }

  fun save(patch: JsonObject) = scope.launchReporting(snackbar) {
    state = gate.run { a -> client.setBudget(patch, approval = a) }
  }

  GatedSettingsPage("Budgets", onBack, snackbar, gate, onRefresh = { load() }) {
    val s = state
    if (s == null) {
      loadingOrError(loadError)
      return@GatedSettingsPage
    }
    item { SettingsHeader("Daily budget") }
    item {
      val d = s.daily
      val fraction = if (d.budget > 0) (d.used.toFloat() / d.budget.toFloat()).coerceIn(0f, 1f) else 0f
      val color = when {
        d.percentage >= 90 -> Mercury.colors.red
        d.percentage >= 75 -> Mercury.colors.amber
        else -> MaterialTheme.colorScheme.primary
      }
      Column(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)
          .semantics(mergeDescendants = true) { contentDescription = "Today: ${Tokens.short(d.used)} of ${Tokens.short(d.budget)} tokens used" },
        verticalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
          Text("Today", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
          Text("${Tokens.short(d.used)} of ${Tokens.short(d.budget)}", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        LinearProgressIndicator(
          progress = { fraction }, modifier = Modifier.fillMaxWidth(),
          color = color, trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
        )
      }
    }
    item {
      TokenChoice("Daily budget", s.daily.budget, dailyPresets) { save(buildJsonObject { put("dailyBudget", it) }) }
    }
    item { SettingsFooter("Mercury slows down rather than stops when it runs low.") }

    item { SettingsHeader("Token Saver") }
    item {
      SwitchRow("On now", s.saver.state == "on") { v -> save(buildJsonObject { put("saver", buildJsonObject { put("manual", v) }) }) }
    }
    item {
      SwitchRow("Turn on by itself", s.saver.autoEnabled) { v -> save(buildJsonObject { put("saver", buildJsonObject { put("autoEnabled", v) }) }) }
    }
    if (s.saver.autoEnabled) item {
      val options = (listOf(50, 75, 90) + s.saver.autoThreshold).distinct().sorted()
      ChoiceRow("When the day's budget is", options, s.saver.autoThreshold, label = { "$it% used" }) { v ->
        save(buildJsonObject { put("saver", buildJsonObject { put("autoThreshold", v) }) })
      }
    }
    item {
      ListItem(headlineContent = { Text("Saved today") }, trailingContent = { Text(Tokens.short(s.saver.savedToday)) })
    }
    item { SettingsFooter("Shorter context and lighter models for routine work. ${Tokens.short(s.saver.savedLifetime)} saved so far.") }

    item { SettingsHeader("Bots") }
    item {
      TokenChoice("Each bot, a day", s.bots.perBot, perBotPresets) { save(buildJsonObject { put("bots", buildJsonObject { put("perBot", it) }) }) }
    }
    item {
      TokenChoice("All bots, a day", s.bots.fleet, fleetPresets) { save(buildJsonObject { put("bots", buildJsonObject { put("fleet", it) }) }) }
    }
  }
}

@Composable
private fun TokenChoice(title: String, value: Long, presets: List<Long>, onPick: (Long) -> Unit) {
  ChoiceRow(title, (presets + value).distinct().sorted(), value, label = { Tokens.short(it) }, onPick = onPick)
}

// MARK: Activity

private const val WEEKS = 26

/** Activity: half a year of token use as bars, with totals (iOS: ActivitySettings; desktop Analytics.tsx). */
@Composable
fun ActivitySettings(client: MercuryClient, onBack: () -> Unit) {
  val snackbar = remember { SnackbarHostState() }
  var days by remember(client) { mutableStateOf<List<UsageDay>?>(null) }
  var loadError by remember(client) { mutableStateOf<String?>(null) }
  var pickedDay by remember(client) { mutableStateOf<Int?>(null) }
  var pickedWeek by remember(client) { mutableStateOf<Int?>(null) }

  suspend fun load() {
    try {
      days = client.usageHistory(WEEKS * 7); loadError = null
      pickedDay = null; pickedWeek = null
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      loadError = e.message
      if (days != null) snackbar.showSnackbar(e.message ?: "Couldn't load the activity.")
    }
  }

  LaunchedEffect(client) { load() }

  GatedSettingsPage("Activity", onBack, snackbar, onRefresh = { load() }) {
    val all = days
    if (all == null) {
      loadingOrError(loadError)
      return@GatedSettingsPage
    }
    item {
      Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 12.dp)) {
        Total("Today", all.takeLast(1), Modifier.weight(1f))
        Total("7 days", all.takeLast(7), Modifier.weight(1f))
        Total("30 days", all.takeLast(30), Modifier.weight(1f))
      }
    }

    val month = all.takeLast(30)
    item { SettingsHeader("Last 30 days") }
    item {
      Bars(
        values = month.map { it.tokens },
        picked = pickedDay,
        description = "Daily token use for the last ${month.size} days, up to ${Tokens.short(month.maxOfOrNull { it.tokens } ?: 0L)} a day",
        onPick = { pickedDay = it },
      )
    }
    item {
      val p = pickedDay?.let { month.getOrNull(it) }
      SettingsFooter(
        if (p != null) "${dayLabel(p.date)}: ${Tokens.short(p.tokens)} tokens, ${p.requests} requests" else "Tap a day for its numbers.",
      )
    }

    val weeks = all.chunked(7)
    item { SettingsHeader("Last $WEEKS weeks") }
    item {
      Bars(
        values = weeks.map { w -> w.sumOf { it.tokens } },
        picked = pickedWeek,
        description = "Weekly token use for the last ${weeks.size} weeks",
        onPick = { pickedWeek = it },
      )
    }
    item {
      val w = pickedWeek?.let { weeks.getOrNull(it) }
      SettingsFooter(
        if (w != null && w.isNotEmpty()) {
          "Week of ${dayLabel(w.first().date)}: ${Tokens.short(w.sumOf { it.tokens })} tokens, ${w.sumOf { it.requests }} requests"
        } else "Tap a week for its numbers.",
      )
    }
  }
}

@Composable
private fun Total(label: String, slice: List<UsageDay>, modifier: Modifier = Modifier) {
  val total = Tokens.short(slice.sumOf { it.tokens })
  Column(
    modifier.semantics(mergeDescendants = true) { contentDescription = "$label: $total tokens" },
    horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    Text(total, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
    Text(label, style = MaterialTheme.typography.labelMedium, color = Mercury.colors.ink3)
  }
}

/** Monochrome bars, oldest on the left; tap one to pick it. */
@Composable
private fun Bars(values: List<Long>, picked: Int?, description: String, onPick: (Int) -> Unit) {
  val ink = MaterialTheme.colorScheme.primary
  val empty = Mercury.colors.line
  val peak = (values.maxOrNull() ?: 0L).coerceAtLeast(1L)
  Canvas(
    Modifier.fillMaxWidth().height(120.dp).padding(horizontal = 16.dp, vertical = 8.dp)
      .semantics { contentDescription = description }
      .pointerInput(values) {
        detectTapGestures { pos ->
          if (values.isNotEmpty()) {
            val i = (pos.x / (size.width.toFloat() / values.size)).toInt().coerceIn(0, values.size - 1)
            onPick(i)
          }
        }
      },
  ) {
    if (values.isEmpty()) return@Canvas
    val slot = size.width / values.size
    val gap = (slot * 0.25f).coerceAtMost(4.dp.toPx())
    val w = (slot - gap).coerceAtLeast(1f)
    val radius = CornerRadius((w / 2).coerceAtMost(3.dp.toPx()))
    val minH = 2.dp.toPx()
    values.forEachIndexed { i, v ->
      val h = if (v <= 0L) minH else (size.height * v.toFloat() / peak.toFloat()).coerceAtLeast(minH)
      val color = when {
        v <= 0L -> empty
        picked == null || picked == i -> ink
        else -> ink.copy(alpha = 0.35f)
      }
      drawRoundRect(color, topLeft = Offset(i * slot + gap / 2, size.height - h), size = Size(w, h), cornerRadius = radius)
    }
  }
}

private fun dayLabel(iso: String): String =
  runCatching { LocalDate.parse(iso).format(DateTimeFormatter.ofPattern("EEE d MMM", Locale.getDefault())) }.getOrDefault(iso)

// MARK: Paired devices

/** Paired devices: every phone and computer with a token for this Mercury (iOS: DevicesSettings). */
@Composable
fun DevicesSettings(client: MercuryClient, onBack: () -> Unit) {
  val gate = rememberOwnerGate(client)
  val snackbar = remember { SnackbarHostState() }
  val scope = rememberCoroutineScope()
  var devices by remember(client) { mutableStateOf<List<PairedDevice>>(emptyList()) }
  var current by remember(client) { mutableStateOf<String?>(null) }
  var loaded by remember(client) { mutableStateOf(false) }
  var loadError by remember(client) { mutableStateOf<String?>(null) }
  var revoking by remember { mutableStateOf<PairedDevice?>(null) }

  suspend fun load() {
    try {
      val r = client.pairedDevices()
      devices = r.devices; current = r.current; loadError = null
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      loadError = e.message
      if (loaded) snackbar.showSnackbar(e.message ?: "Couldn't load the devices.")
    }
    loaded = true
  }

  LaunchedEffect(client) { load() }

  GatedSettingsPage("Paired devices", onBack, snackbar, gate, onRefresh = { load() }) {
    if (!loaded || (devices.isEmpty() && loadError != null)) {
      loadingOrError(loadError)
      return@GatedSettingsPage
    }
    items(devices, key = { it.id }) { d ->
      val isThis = d.id == current
      ListItem(
        headlineContent = {
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(d.name.ifEmpty { "Unnamed device" })
            if (isThis) Text("This phone", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.primary)
          }
        },
        supportingContent = {
          val seen = d.lastSeenAt
          Text(
            if (seen != null) "Last seen " + DateUtils.getRelativeTimeSpanString(seen.toEpochMilli(), System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS)
            else "Never used",
            color = Mercury.colors.ink3,
          )
        },
        leadingContent = { Icon(platformIcon(d.platform), null) },
        trailingContent = if (!isThis) ({
          IconButton(onClick = { revoking = d }) { Icon(Icons.Outlined.LinkOff, "Revoke ${d.name}") }
        }) else null,
      )
    }
    item { SettingsFooter("Revoking signs a device out of this Mercury at once. To disconnect this phone, use Settings.") }
  }

  revoking?.let { d ->
    AlertDialog(
      onDismissRequest = { revoking = null },
      title = { Text("Revoke ${d.name}?") },
      text = { Text("It's signed out of this Mercury at once and has to pair again.") },
      confirmButton = {
        TextButton(onClick = {
          revoking = null
          scope.launchReporting(snackbar) {
            gate.run { a -> client.revokeDevice(d.id, approval = a) }
            load()
          }
        }) { Text("Revoke", color = MaterialTheme.colorScheme.error) }
      },
      dismissButton = { TextButton(onClick = { revoking = null }) { Text("Cancel") } },
    )
  }
}

private fun platformIcon(platform: String): ImageVector = when (platform.lowercase()) {
  "ios", "iphone" -> Icons.Outlined.PhoneIphone
  "android" -> Icons.Outlined.PhoneAndroid
  "darwin", "macos", "mac" -> Icons.Outlined.LaptopMac
  "windows", "win32", "linux" -> Icons.Outlined.Computer
  else -> Icons.Outlined.Devices
}
