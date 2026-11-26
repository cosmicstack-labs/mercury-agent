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
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Chat
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import sh.mercuryagent.core.Pairing
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
            ui.step != ConnectStep.Welcome && ui.step !is ConnectStep.Waiting && ui.step != ConnectStep.Name ->
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
        ConnectStep.SignIn::class -> SignIn(vm, ui)
        ConnectStep.Token::class -> PasteToken(vm, ui)
        ConnectStep.Name::class -> NameStep(vm, ui)
        else -> (ui.step as? ConnectStep.Waiting)?.let { Waiting(vm, it.pairing) }
      }
    }
  }
}

@Composable
private fun Welcome(vm: ConnectViewModel) {
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
      onClick = { vm.go(ConnectStep.Token) },
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
            "On your computer or a server. Make a device token there, then paste it here.",
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
      }
    }
    Spacer(Modifier.weight(1f).height(32.dp))
    Button(onClick = { vm.go(ConnectStep.Token) }, modifier = Modifier.fillMaxWidth().height(52.dp)) { Text("Connect with a device token") }
    TextButton(onClick = { vm.go(ConnectStep.SignIn) }, modifier = Modifier.padding(top = 8.dp)) { Text("Sign in with a password") }
    // QR pairing: iOS has none yet (ConnectModel.swift); when Mercury shows a pairing QR, add CameraX + ML Kit here.
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

@Composable
private fun SignIn(vm: ConnectViewModel, ui: ConnectUi) {
  var show by rememberSaveable { mutableStateOf(false) }
  FormColumn {
    Text("Sign in to your Mercury", style = MaterialTheme.typography.headlineSmall)
    Text(
      "Use the address you reach Mercury at, and the username and password you set for it. This works only if password sign-in is on for your Mercury (/server password on); it's off by default.",
      style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    AddressField(ui.address, vm::setAddress)
    OutlinedTextField(
      ui.username, vm::setUsername, label = { Text("Username") }, singleLine = true,
      keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Next),
      modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
      ui.password, vm::setPassword, label = { Text("Password") }, singleLine = true,
      visualTransformation = if (show) VisualTransformation.None else PasswordVisualTransformation(),
      keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Go),
      keyboardActions = KeyboardActions(onGo = { if (ui.canSignIn) vm.signIn() }),
      trailingIcon = {
        IconButton(onClick = { show = !show }) {
          Icon(if (show) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, if (show) "Hide password" else "Show password")
        }
      },
      modifier = Modifier.fillMaxWidth(),
    )
    ui.error?.let { ErrorText(it) }
    Button(onClick = vm::signIn, enabled = ui.canSignIn, modifier = Modifier.fillMaxWidth().height(52.dp)) {
      if (ui.busy) {
        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
        Spacer(Modifier.size(10.dp))
        Text("Connecting…")
      } else Text("Connect")
    }
    Text(
      "Your password goes only to that Mercury. This phone keeps a device token in the Android Keystore, never the password.",
      style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
  }
}

@Composable
private fun PasteToken(vm: ConnectViewModel, ui: ConnectUi) {
  FormColumn {
    Text("Connect with a token", style = MaterialTheme.typography.headlineSmall)
    Text(
      "On the computer Mercury runs on, type /server token <phone name> (or run mercury devices add <name>), then paste the token here. It starts with mdt_.",
      style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    AddressField(ui.address, vm::setAddress)
    OutlinedTextField(
      ui.token, vm::setToken, label = { Text("Device token") }, placeholder = { Text("mdt_…") }, singleLine = true,
      visualTransformation = PasswordVisualTransformation(),
      keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false, imeAction = ImeAction.Go),
      keyboardActions = KeyboardActions(onGo = { if (ui.canUseToken) vm.useToken() }),
      modifier = Modifier.fillMaxWidth(),
    )
    ui.error?.let { ErrorText(it) }
    Button(onClick = vm::useToken, enabled = ui.canUseToken, modifier = Modifier.fillMaxWidth().height(52.dp)) {
      Text(if (ui.busy) "Checking…" else "Connect")
    }
  }
}

@Composable
private fun Waiting(vm: ConnectViewModel, pairing: Pairing) {
  Column(
    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 16.dp),
    horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(20.dp),
  ) {
    MarkTile(64.dp)
    Text("Approve this phone", style = MaterialTheme.typography.headlineSmall)
    Text(
      "Your Mercury is asking its owner to let this phone in. Approve it with this code:",
      style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
      textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 320.dp),
    )
    Row(
      horizontalArrangement = Arrangement.spacedBy(8.dp),
      modifier = Modifier.semantics { contentDescription = "Code " + pairing.code.toList().joinToString(" ") },
    ) {
      pairing.code.forEach { ch ->
        Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium) {
          Box(Modifier.size(width = 50.dp, height = 64.dp), contentAlignment = Alignment.Center) {
            Text(ch.toString(), fontSize = 32.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
          }
        }
      }
    }
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow), modifier = Modifier.fillMaxWidth()) {
      Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Hint(Icons.Outlined.Chat, "Reply \"approve ${pairing.code}\" to Mercury on Telegram or WhatsApp")
        Hint(Icons.Outlined.Computer, "Or approve it in Mercury Desktop on that computer")
        Hint(Icons.Outlined.Terminal, "Or run /server approve ${pairing.code} there")
      }
    }
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
      LinearProgressIndicator(Modifier.widthIn(max = 200.dp))
      Text("Waiting for approval", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    TextButton(onClick = vm::cancelWaiting) { Text("Cancel") }
  }
}

@Composable
private fun Hint(icon: ImageVector, text: String) {
  Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
    Icon(icon, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
  }
}
