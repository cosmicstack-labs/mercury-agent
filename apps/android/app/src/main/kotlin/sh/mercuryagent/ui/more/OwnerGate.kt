package sh.mercuryagent.ui.more

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.ArrowDropDown
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SheetValue
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.Switch
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sh.mercuryagent.core.ApprovalStatus
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.MercuryException
import sh.mercuryagent.core.OwnerQuestion
import sh.mercuryagent.core.approvalStatus
import sh.mercuryagent.ui.components.ErrorText
import sh.mercuryagent.ui.theme.Mercury

/**
 * Runs a settings change. When the owner must allow it first (a change from a remote device,
 * src/web/owner-gate.ts), shows the code to approve on the computer or a messaging channel, waits
 * for the answer, then repeats the change once with that approval (iOS: OwnerGate).
 */
@Stable
class OwnerGate(val client: MercuryClient) {
  /** The question the owner is answering now; the sheet shows while it's set. */
  var question by mutableStateOf<OwnerQuestion?>(null)
    private set

  suspend fun <T> run(change: suspend (approval: String?) -> T): T {
    val q = try {
      return change(null)
    } catch (e: MercuryException.NeedsOwner) {
      e.question
    }
    question = q
    try {
      var status = ApprovalStatus.PENDING
      while (status == ApprovalStatus.PENDING) {
        delay(2000)
        status = client.approvalStatus(q.id)
      }
      return when (status) {
        ApprovalStatus.ALLOWED -> change(q.id)
        ApprovalStatus.DENIED -> throw MercuryException.Server(403, "The owner said no.")
        else -> throw MercuryException.Server(410, "Nobody approved it in time. Try again.")
      }
    } finally {
      question = null
    }
  }
}

@Composable
fun rememberOwnerGate(client: MercuryClient): OwnerGate = remember(client) { OwnerGate(client) }

/** The question the owner is answering: its code, big, and where to approve it. Can't be dismissed while waiting. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OwnerGateSheet(gate: OwnerGate) {
  val q = gate.question ?: return
  val state = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { it != SheetValue.Hidden })
  ModalBottomSheet(
    onDismissRequest = {},
    sheetState = state,
    dragHandle = null,
    properties = ModalBottomSheetProperties(shouldDismissOnBackPress = false),
  ) {
    Column(
      Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 28.dp).navigationBarsPadding(),
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      Icon(Icons.Outlined.Lock, null, tint = Mercury.colors.amber, modifier = Modifier.size(32.dp))
      Text("Approve on ${q.where}", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
      Text(
        q.code,
        fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold, fontSize = 34.sp, letterSpacing = 6.sp,
        modifier = Modifier.semantics { contentDescription = "Code " + q.code.toList().joinToString(" ") },
      )
      Text(
        "Changes from your phone need the owner's go-ahead. It goes through as soon as it's approved.",
        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
      )
      LinearProgressIndicator(Modifier.fillMaxWidth(0.4f), color = MaterialTheme.colorScheme.primary)
    }
  }
}

/** Runs [block], showing any failure in [snackbar]. */
fun CoroutineScope.launchReporting(snackbar: SnackbarHostState, block: suspend CoroutineScope.() -> Unit): Job = launch {
  try {
    block()
  } catch (e: CancellationException) {
    throw e
  } catch (e: Exception) {
    snackbar.showSnackbar(e.message ?: "Something went wrong.", withDismissAction = true)
  }
}

/**
 * A settings page like [SettingsPage], plus what the server-backed pages need: errors in a
 * snackbar, pull to refresh, and the owner's approval sheet.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GatedSettingsPage(
  title: String,
  onBack: () -> Unit,
  snackbar: SnackbarHostState,
  gate: OwnerGate? = null,
  onRefresh: (suspend () -> Unit)? = null,
  actions: @Composable RowScope.() -> Unit = {},
  content: LazyListScope.() -> Unit,
) {
  val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
  val scope = rememberCoroutineScope()
  var refreshing by remember { mutableStateOf(false) }
  Scaffold(
    modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
    topBar = {
      LargeTopAppBar(
        title = { Text(title) }, scrollBehavior = scroll,
        navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
        actions = actions,
      )
    },
    snackbarHost = { SnackbarHost(snackbar) },
  ) { padding ->
    val listPadding = PaddingValues(bottom = padding.calculateBottomPadding() + 24.dp)
    val boxModifier = Modifier.fillMaxSize().padding(top = padding.calculateTopPadding())
    if (onRefresh != null) {
      PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
          scope.launch {
            refreshing = true
            try { onRefresh() } finally { refreshing = false }
          }
        },
        modifier = boxModifier,
      ) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = listPadding, content = content)
      }
    } else {
      Box(boxModifier) { LazyColumn(Modifier.fillMaxSize(), contentPadding = listPadding, content = content) }
    }
  }
  gate?.let { OwnerGateSheet(it) }
}

/** A status line under a settings row: green when it works, grey when off, amber when it needs you. */
enum class StatusTone { Good, Off, Warn }

@Composable
fun StatusText(text: String, tone: StatusTone, modifier: Modifier = Modifier) {
  val color = when (tone) {
    StatusTone.Good -> Mercury.colors.green
    StatusTone.Warn -> Mercury.colors.amber
    StatusTone.Off -> Mercury.colors.ink3
  }
  Text(text, style = MaterialTheme.typography.bodySmall, color = color, modifier = modifier)
}

/** Quiet text under a group of rows. */
@Composable
fun SettingsFooter(text: String) {
  Text(
    text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
    modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 4.dp),
  )
}

/** While the first load runs: a spinner. When it failed and nothing shows: the reason. */
fun LazyListScope.loadingOrError(error: String?) {
  item(key = "loading") {
    Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
      if (error != null) ErrorText(error) else CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.5.dp)
    }
  }
}

@Composable
fun Chevron() {
  Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = Mercury.colors.ink3)
}

/** A row whose value is picked from a menu: the title on the left, the current choice on the right. */
@Composable
fun <T> ChoiceRow(
  title: String,
  options: List<T>,
  selected: T,
  label: (T) -> String,
  supporting: String? = null,
  enabled: Boolean = true,
  onPick: (T) -> Unit,
) {
  var open by remember { mutableStateOf(false) }
  Box(Modifier.fillMaxWidth()) {
    ListItem(
      headlineContent = { Text(title) },
      supportingContent = supporting?.let { { Text(it) } },
      trailingContent = {
        Row(verticalAlignment = Alignment.CenterVertically) {
          Text(label(selected), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
          Icon(Icons.Outlined.ArrowDropDown, null, tint = Mercury.colors.ink3)
        }
      },
      modifier = Modifier.clickable(enabled = enabled, onClickLabel = "Change $title", role = Role.DropdownList) { open = true },
    )
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
      options.forEach { o ->
        DropdownMenuItem(
          text = { Text(label(o)) },
          onClick = { open = false; if (o != selected) onPick(o) },
          trailingIcon = if (o == selected) ({ Icon(Icons.Outlined.Check, "Selected") }) else null,
        )
      }
    }
  }
}

@Composable
fun SectionSpacer() = Spacer(Modifier.height(8.dp))

/** A row with a switch; the whole row toggles it. */
@Composable
fun SwitchRow(title: String, checked: Boolean, supporting: String? = null, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
  ListItem(
    headlineContent = { Text(title) },
    supportingContent = supporting?.let { { Text(it) } },
    trailingContent = { Switch(checked = checked, onCheckedChange = null, enabled = enabled) },
    modifier = Modifier.toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onChange),
  )
}
