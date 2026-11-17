package sh.mercuryagent.ui.more

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Extension
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material.icons.outlined.Savings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import androidx.navigation.toRoute
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import sh.mercuryagent.AppContainer
import sh.mercuryagent.core.Connection
import sh.mercuryagent.core.Health
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.ui.components.ErrorText
import sh.mercuryagent.ui.components.StatusDot
import sh.mercuryagent.ui.theme.Mercury

/** Settings' screens (the old More tab, opened from the drawer's Mercury row). */
object SettingsNav {
  @Serializable object Root
  @Serializable object Models
  @Serializable object Voice
  @Serializable object Channels
  @Serializable object Appearance
  @Serializable object Notifications
  @Serializable object Budgets
  @Serializable object Activity
  @Serializable object Devices
  @Serializable object Plugins
  @Serializable data class Plugin(val id: String)
}

fun NavGraphBuilder.settingsGraph(nav: NavHostController, container: AppContainer, connection: Connection, client: MercuryClient, onAddMercury: () -> Unit) {
  val back: () -> Unit = { nav.popBackStack() }
  composable<SettingsNav.Root> { SettingsScreen(container, connection, client, onBack = back, onOpen = { nav.navigate(it) }, onAddMercury = onAddMercury) }
  composable<SettingsNav.Appearance> { AppearanceSettings(container, back) }
  composable<SettingsNav.Notifications> { NotificationsSettings(container, back) }
  // Models and Voice link to each other: going back to the one underneath instead of stacking them.
  fun openOrBack(route: Any) {
    if (nav.previousBackStackEntry?.destination?.hasRoute(route::class) == true) nav.popBackStack() else nav.navigate(route)
  }
  composable<SettingsNav.Models> { ModelsSettings(client, back, onVoice = { openOrBack(SettingsNav.Voice) }) }
  composable<SettingsNav.Voice> {
    VoiceSettings(client, container.calls, back, onOpenModels = { openOrBack(SettingsNav.Models) }, onOpenPlugin = { nav.navigate(SettingsNav.Plugin(it)) })
  }
  composable<SettingsNav.Plugins> { PluginsSettings(client, connection.name, back, onOpen = { nav.navigate(SettingsNav.Plugin(it)) }) }
  composable<SettingsNav.Plugin> { entry -> PluginDetailSettings(client, connection.name, entry.toRoute<SettingsNav.Plugin>().id, back) }
  composable<SettingsNav.Channels> { ChannelsSettings(client, back) }
  composable<SettingsNav.Budgets> { BudgetsSettings(client, back) }
  composable<SettingsNav.Activity> { ActivitySettings(client, back) }
  composable<SettingsNav.Devices> { DevicesSettings(client, back) }
}

/** A settings page: a large title that collapses, back, and a list. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsPage(title: String, onBack: () -> Unit, actions: @Composable () -> Unit = {}, content: LazyListScope.() -> Unit) {
  val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
  Scaffold(
    modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
    topBar = {
      LargeTopAppBar(
        title = { Text(title) }, scrollBehavior = scroll,
        navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
        actions = { actions() },
      )
    },
  ) { padding ->
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = padding.calculateTopPadding(), bottom = padding.calculateBottomPadding() + 24.dp), content = content)
  }
}

@Composable
fun SettingsHeader(text: String) {
  Text(
    text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
    modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 4.dp).semantics { heading() },
  )
}

@Composable
fun NavRow(icon: ImageVector, name: String, detail: String? = null, onClick: () -> Unit) {
  ListItem(
    headlineContent = { Text(name) },
    supportingContent = detail?.let { { Text(it) } },
    leadingContent = { Icon(icon, null) },
    modifier = Modifier.clickable(onClick = onClick),
  )
}

/** The Mercury this phone is connected to, its settings, the others it knows, and about (iOS: MoreView). */
@Composable
fun SettingsScreen(
  container: AppContainer, connection: Connection, client: MercuryClient,
  onBack: () -> Unit, onOpen: (Any) -> Unit, onAddMercury: () -> Unit,
) {
  val store = container.connections
  val state by store.state.collectAsStateWithLifecycle()
  var health by remember { mutableStateOf<Health?>(null) }
  var healthError by remember { mutableStateOf<String?>(null) }
  var confirm by remember { mutableStateOf(false) }
  var editing by remember { mutableStateOf<Connection?>(null) }
  val scope = rememberCoroutineScope()
  val context = LocalContext.current

  LaunchedEffect(connection.id) {
    try { health = client.health(); healthError = null } catch (e: Exception) { healthError = e.message }
  }

  SettingsPage("Settings", onBack) {
    item { SettingsHeader("Connected to") }
    item {
      ListItem(
        headlineContent = { Text(connection.name) },
        supportingContent = {
          when {
            healthError != null -> ErrorText(healthError!!)
            health == null -> Text("Checking…")
            else -> Text("Online · Mercury ${health?.version.orEmpty()}")
          }
        },
        leadingContent = { sh.mercuryagent.ui.components.MercuryLogo(connection.logoId, 44.dp) },
        trailingContent = { StatusDot(if (health != null && healthError == null) Mercury.colors.green else Mercury.colors.ink4, size = 10.dp) },
        modifier = Modifier.clickable(onClickLabel = "Rename it or pick its logo") { editing = connection },
      )
    }
    item { ListItem(headlineContent = { Text("Address") }, supportingContent = { Text(connection.baseUrl) }) }
    item {
      ListItem(
        headlineContent = { Text("Disconnect this phone", color = MaterialTheme.colorScheme.error) },
        modifier = Modifier.clickable { confirm = true },
      )
    }

    item { SettingsHeader("Settings") }
    item { NavRow(Icons.Outlined.Memory, "Models") { onOpen(SettingsNav.Models) } }
    item { NavRow(Icons.Outlined.GraphicEq, "Voice") { onOpen(SettingsNav.Voice) } }
    item { NavRow(Icons.Outlined.Extension, "Plugins") { onOpen(SettingsNav.Plugins) } }
    item { NavRow(Icons.Outlined.Forum, "Channels") { onOpen(SettingsNav.Channels) } }
    item { NavRow(Icons.Outlined.Palette, "Appearance") { onOpen(SettingsNav.Appearance) } }
    item { NavRow(Icons.Outlined.Notifications, "Notifications") { onOpen(SettingsNav.Notifications) } }
    item { NavRow(Icons.Outlined.Savings, "Budgets") { onOpen(SettingsNav.Budgets) } }
    item { NavRow(Icons.Outlined.BarChart, "Activity") { onOpen(SettingsNav.Activity) } }
    item { NavRow(Icons.Outlined.Devices, "Paired devices") { onOpen(SettingsNav.Devices) } }

    item { SettingsHeader("Your Mercurys") }
    items(state.connections, key = { it.id }) { c ->
      ListItem(
        headlineContent = { Text(c.name) },
        supportingContent = { Text(c.baseUrl) },
        leadingContent = { sh.mercuryagent.ui.components.MercuryLogo(c.logoId, 36.dp) },
        trailingContent = { if (c.id == connection.id) Icon(Icons.Outlined.Check, "Connected") },
        modifier = Modifier.clickable(onClickLabel = "Switch to ${c.name}") { store.activate(c.id) },
      )
    }
    item { NavRow(Icons.Outlined.Add, "Add another Mercury", onClick = onAddMercury) }

    item { SettingsHeader("About") }
    item { ListItem(headlineContent = { Text("Mercury for Android") }, trailingContent = { Text(container.appVersion) }) }
    health?.version?.let { v -> item { ListItem(headlineContent = { Text("Mercury") }, trailingContent = { Text(v) }) } }
    item {
      ListItem(
        headlineContent = { Text("Mercury website") }, trailingContent = { Icon(Icons.AutoMirrored.Outlined.OpenInNew, null) },
        modifier = Modifier.clickable { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://mercuryagent.sh"))) },
      )
    }
    item {
      ListItem(
        headlineContent = { Text("Source on GitHub") }, trailingContent = { Icon(Icons.AutoMirrored.Outlined.OpenInNew, null) },
        modifier = Modifier.clickable { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/cosmicstack-labs/mercury-agent"))) },
      )
    }
  }

  editing?.let { c ->
    sh.mercuryagent.ui.connect.EditMercurySheet(c, onDismiss = { editing = null }) { n, l -> store.update(c.id, n, l); editing = null }
  }
  if (confirm) AlertDialog(
    onDismissRequest = { confirm = false },
    title = { Text("Disconnect from ${connection.name}?") },
    text = { Text("This phone's device token is revoked on that Mercury. You can connect again any time.") },
    confirmButton = { TextButton(onClick = { confirm = false; scope.launch { store.remove(connection.id) } }) { Text("Disconnect", color = MaterialTheme.colorScheme.error) } },
    dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } },
  )
}
