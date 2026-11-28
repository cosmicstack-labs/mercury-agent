package sh.mercuryagent.ui.connect

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import sh.mercuryagent.ui.components.ErrorText
import sh.mercuryagent.ui.components.MarkTile

/**
 * Screen 1: connect this phone to a Mercury (iOS: ConnectView.swift). [onClose] is set when it's
 * opened from More ("Add another Mercury"); the first connection has nowhere to go back to.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConnectScreen(vm: ConnectViewModel, onClose: (() -> Unit)? = null) {
  val ui by vm.ui.collectAsStateWithLifecycle()
  BackHandler(ui.step != ConnectStep.Welcome) { vm.back() }
  Scaffold(
    topBar = {
      TopAppBar(
        title = {},
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
        navigationIcon = {
          when {
            ui.step != ConnectStep.Welcome && ui.step != ConnectStep.Name ->
              IconButton(onClick = { vm.back() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            onClose != null && ui.step == ConnectStep.Welcome -> IconButton(onClick = onClose) { Icon(Icons.Outlined.Close, "Close") }
          }
        },
      )
    },
  ) { padding ->
    AnimatedContent(
      ui.step::class, modifier = Modifier.padding(padding).fillMaxSize().imePadding(), label = "step",
      transitionSpec = {
        val forward = targetState != ConnectStep.Welcome::class
        (slideInHorizontally(tween(300)) { if (forward) it / 4 else -it / 4 } + fadeIn(tween(300))) togetherWith
          (slideOutHorizontally(tween(300)) { if (forward) -it / 4 else it / 4 } + fadeOut(tween(200)))
      },
    ) { step ->
      when (step) {
        ConnectStep.Welcome::class -> Welcome(vm)
        ConnectStep.Name::class -> NameStep(vm, ui)
        ConnectStep.Enter::class -> EnterCode(vm, ui)
      }
    }
  }
  // A scanned or opened pairing link: always asked about first, never paired silently.
  ui.confirm?.let { link ->
    AlertDialog(
      onDismissRequest = vm::dismissConfirm,
      title = { Text("Connect to ${link.host}?") },
      text = { Text("Only connect if this is your Mercury.") },
      confirmButton = { TextButton(onClick = vm::confirmPair) { Text("Connect") } },
      dismissButton = { TextButton(onClick = vm::dismissConfirm) { Text("Cancel") } },
    )
  }
}

/** Opens Google's code scanner; without it (no Play services), "Enter a code or token" says why. */
@Composable
private fun rememberScan(vm: ConnectViewModel): () -> Unit {
  val context = LocalContext.current
  return { QrScanner.scan(context, onCode = vm::openLink, onUnavailable = vm::scanUnavailable) }
}

@Composable
private fun Welcome(vm: ConnectViewModel) {
  val scan = rememberScan(vm)
  Column(
    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 16.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Spacer(Modifier.height(24.dp))
    MarkTile(80.dp)
    Spacer(Modifier.height(24.dp))
    Text("Connect to your Mercury", style = MaterialTheme.typography.headlineMedium, textAlign = TextAlign.Center)
    Spacer(Modifier.height(12.dp))
    Text(
      "Mercury runs on your computer or a server. This app is how you reach it from anywhere.",
      style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
      textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 340.dp),
    )
    Spacer(Modifier.height(32.dp))
    Card(
      colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
      modifier = Modifier.fillMaxWidth(),
    ) {
      Row(Modifier.padding(18.dp), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
        Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = MaterialTheme.shapes.medium) {
          Icon(Icons.Outlined.Computer, null, Modifier.padding(10.dp), tint = MaterialTheme.colorScheme.onPrimaryContainer)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
          Text("Your own Mercury", style = MaterialTheme.typography.titleMedium)
          Text(
            "On your computer or a server. Run /server pair there, then scan the code it shows.",
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
      }
    }
    Spacer(Modifier.weight(1f).height(32.dp))
    Button(onClick = scan, modifier = Modifier.fillMaxWidth().height(52.dp)) {
      Icon(Icons.Outlined.QrCodeScanner, null, Modifier.size(20.dp))
      Spacer(Modifier.size(10.dp))
      Text("Scan to connect")
    }
    TextButton(onClick = { vm.go(ConnectStep.Enter) }, modifier = Modifier.padding(top = 8.dp)) { Text("Enter a code or token") }
  }
}

@Composable
private fun AddressField(value: String, onChange: (String) -> Unit) {
  OutlinedTextField(
    value, onChange, label = { Text("Address") }, placeholder = { Text("mercury.example.com") }, singleLine = true,
    supportingText = { Text("On your Wi-Fi, http://<your-mac>.local:6175 works too.") },
    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false, imeAction = ImeAction.Next),
    modifier = Modifier.fillMaxWidth(),
  )
}

@Composable
private fun FormColumn(content: @Composable () -> Unit) {
  Column(
    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 8.dp),
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) { content() }
}

/** The fallback: the address, and either the pairing code shown under the QR code or a device token (mdt_…). */
@Composable
private fun EnterCode(vm: ConnectViewModel, ui: ConnectUi) {
  val scan = rememberScan(vm)
  FormColumn {
    Text("Enter a code or token", style = MaterialTheme.typography.headlineSmall)
    Text(
      "Run /server pair on your computer for a code, or /server token for a token.",
      style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    AddressField(ui.address, vm::setAddress)
    OutlinedTextField(
      ui.secret, vm::setSecret, label = { Text("Code or token") }, placeholder = { Text("XXXXX-XXXXX-… or mdt_…") },
      singleLine = true, textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
      keyboardOptions = KeyboardOptions(
        capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false,
        keyboardType = KeyboardType.Password, imeAction = ImeAction.Go,
      ),
      keyboardActions = KeyboardActions(onGo = { if (ui.canConnect) vm.connectTyped() }),
      modifier = Modifier.fillMaxWidth(),
    )
    ui.error?.let { ErrorText(it) }
    Button(onClick = vm::connectTyped, enabled = ui.canConnect, modifier = Modifier.fillMaxWidth().height(52.dp)) {
      if (ui.busy) {
        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
        Spacer(Modifier.size(10.dp))
        Text("Connecting…")
      } else Text("Connect")
    }
    Text(
      "A code works once, for a few minutes. This phone keeps its device token in the Android Keystore.",
      style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    TextButton(onClick = scan, enabled = !ui.busy, modifier = Modifier.fillMaxWidth()) { Text("Scan instead") }
  }
}
