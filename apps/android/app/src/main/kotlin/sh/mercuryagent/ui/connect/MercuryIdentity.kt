package sh.mercuryagent.ui.connect

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import sh.mercuryagent.core.Connection
import sh.mercuryagent.core.ConnectionLogos
import sh.mercuryagent.ui.components.LogoLook
import sh.mercuryagent.ui.components.MercuryLogo

// A Mercury's friendly name and logo: the connect flow's last step, the switcher (the drawer's
// header) and its Edit sheet. iOS: MercuryIdentity.swift.

/** The twelve logos in a grid of four; the chosen one ringed in ink. */
@Composable
fun LogoPicker(selected: String, onSelect: (String) -> Unit, size: Dp = 56.dp) {
  val ink = MaterialTheme.colorScheme.onSurface
  Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
    for (row in ConnectionLogos.ids.chunked(4)) {
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        for (id in row) {
          val on = id == selected
          val scale by animateFloatAsState(if (on) 1f else 0.94f, label = "logo")
          Box(
            Modifier.clip(CircleShape)
              .border(if (on) 2.5.dp else 0.dp, if (on) ink else Color.Transparent, CircleShape)
              .clickable(role = Role.RadioButton, onClickLabel = LogoLook.name(id)) { onSelect(id) }
              .semantics { this.selected = on }
              .padding(4.dp),
          ) { MercuryLogo(id, size, Modifier.scale(scale)) }
        }
      }
    }
  }
}

/** The name field and the logo grid under a large preview: shared by the connect flow and Edit. */
@Composable
fun NameAndLogoForm(name: String, onName: (String) -> Unit, logo: String, onLogo: (String) -> Unit, placeholder: String, onDone: () -> Unit = {}) {
  val focus = LocalFocusManager.current
  Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
      MercuryLogo(logo, 96.dp)
      Text(name.trim().ifEmpty { placeholder }, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    OutlinedTextField(
      name, onName, label = { Text("Name") }, placeholder = { Text(placeholder) }, singleLine = true,
      keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done),
      keyboardActions = KeyboardActions(onDone = { focus.clearFocus(); onDone() }),
      modifier = Modifier.fillMaxWidth(),
    )
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Text("Logo", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
      LogoPicker(logo, onLogo)
    }
  }
}

/** The connect flow's last step: connected, now a name and a face for it. */
@Composable
fun NameStep(vm: ConnectViewModel, ui: ConnectUi) {
  Column(
    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 8.dp),
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    Text("Name this Mercury", style = MaterialTheme.typography.headlineSmall)
    Text(
      "You're connected. Pick a name and a face so you can tell your Mercurys apart. You can change both later.",
      style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    NameAndLogoForm(ui.name, vm::setName, ui.logo, vm::setLogo, ui.suggestedName)
    Button(onClick = vm::save, modifier = Modifier.fillMaxWidth().height(52.dp)) { Text("Done") }
  }
}

/**
 * Tapping the Mercury at the top of the drawer: every Mercury this phone knows (logo, name, address),
 * the one in use ticked; tap one to switch, Edit to rename it or pick its logo; and Add another.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MercurySwitcherSheet(
  connections: List<Connection>, current: String,
  onSwitch: (String) -> Unit, onEdit: (id: String, name: String, logo: String) -> Unit, onAdd: () -> Unit, onDismiss: () -> Unit,
) {
  var editing by remember { mutableStateOf<Connection?>(null) }
  ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
    Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 8.dp)) {
      Text("Your Mercurys", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
      for (c in connections) {
        ListItem(
          headlineContent = { Text(c.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis) },
          supportingContent = { Text(hostOf(c.baseUrl), maxLines = 1, overflow = TextOverflow.Ellipsis) },
          leadingContent = { MercuryLogo(c.logoId, 44.dp) },
          trailingContent = {
            Row(verticalAlignment = Alignment.CenterVertically) {
              if (c.id == current) Icon(Icons.Outlined.Check, "In use")
              TextButton(onClick = { editing = c }) { Text("Edit") }
            }
          },
          colors = ListItemDefaults.colors(containerColor = Color.Transparent),
          modifier = Modifier.clickable(onClickLabel = "Switch to ${c.name}") { onDismiss(); if (c.id != current) onSwitch(c.id) },
        )
      }
      HorizontalDivider(Modifier.padding(vertical = 4.dp))
      ListItem(
        headlineContent = { Text("Add another Mercury") }, leadingContent = { Icon(Icons.Outlined.Add, null) },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier.clickable { onDismiss(); onAdd() },
      )
    }
  }
  editing?.let { c -> EditMercurySheet(c, onDismiss = { editing = null }) { n, l -> onEdit(c.id, n, l); editing = null } }
}

/** Rename a Mercury and pick its logo. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditMercurySheet(connection: Connection, onDismiss: () -> Unit, onSave: (name: String, logo: String) -> Unit) {
  var name by rememberSaveable(connection.id) { mutableStateOf(connection.name) }
  var logo by rememberSaveable(connection.id) { mutableStateOf(connection.logoId) }
  ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(horizontal = 24.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Edit Mercury", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
        TextButton(onClick = onDismiss) { Text("Cancel") }
        TextButton(onClick = { onSave(name, logo) }) { Text("Save", fontWeight = FontWeight.SemiBold) }
      }
      Spacer(Modifier.height(8.dp))
      NameAndLogoForm(name, { name = it }, logo, { logo = it }, connection.name)
      Spacer(Modifier.height(24.dp))
    }
  }
}

private fun hostOf(url: String) = url.substringAfter("://").substringBefore('/').ifEmpty { url }
