package sh.mercuryagent.ui.more

import android.content.ClipboardManager
import android.os.Build
import android.view.HapticFeedbackConstants
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sh.mercuryagent.call.CallManager
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.MercuryException
import sh.mercuryagent.core.VoiceKeyResult
import sh.mercuryagent.core.VoiceProvider
import sh.mercuryagent.core.VoiceSetup
import sh.mercuryagent.core.setOpenAIVoiceKey
import sh.mercuryagent.core.setVoiceKey
import sh.mercuryagent.core.voiceProviders
import sh.mercuryagent.ui.components.ErrorText
import sh.mercuryagent.ui.theme.Mercury

/** Where the setup sheet is. */
sealed interface VoiceSetupStage {
  data object Loading : VoiceSetupStage
  data class Failed(val message: String) : VoiceSetupStage
  /** The voices; [notice] says why it came back here (a voice that can't do what was asked). */
  data class Choose(val notice: String? = null) : VoiceSetupStage
  /** Paste a key; [checking] while Mercury checks it (and while the owner approves). */
  data class Key(val provider: VoiceProvider, val checking: Boolean = false, val error: String? = null) : VoiceSetupStage
  /** "✓ Voice is ready". */
  data class Ready(val name: String, val next: VoiceSetup.Next) : VoiceSetupStage
  /** Set on the computer: can't be changed from here. */
  data class Locked(val provider: VoiceProvider, val message: String) : VoiceSetupStage
}

/** What the trigger continues with when a voice is already set ("Start talking"). */
fun VoiceSetup.Trigger.goAhead(): VoiceSetup.Next = when (this) {
  VoiceSetup.Trigger.Call -> VoiceSetup.Next.StartCall
  VoiceSetup.Trigger.Dictation -> VoiceSetup.Next.StartDictation
  VoiceSetup.Trigger.Settings -> VoiceSetup.Next.Done
}

/**
 * "Set up voice" (iOS: VoiceSetupSheet): opened by a call entry or the dictation mic when this
 * Mercury can't do it yet, or from Settings → Voice. The voices that can do what was asked, a key
 * step (paste, get a key, save and check), then "Voice is ready" and on to what the owner was doing.
 * Keys are saved on the computer (PUT /api/voice/providers/:id, or the OpenAI model's key); nothing
 * is kept on the phone.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VoiceSetupSheet(
  client: MercuryClient,
  calls: CallManager,
  trigger: VoiceSetup.Trigger,
  onDismiss: () -> Unit,
  /** A voice works now: start the call or dictation (Done from Settings closes the sheet). */
  onContinue: (VoiceSetup.Next) -> Unit,
) {
  val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
  val scope = rememberCoroutineScope()
  val gate = rememberOwnerGate(client)
  val view = LocalView.current
  var stage by remember(trigger) { mutableStateOf<VoiceSetupStage>(VoiceSetupStage.Loading) }
  var plan by remember(trigger) { mutableStateOf<VoiceSetup.Plan?>(null) }

  suspend fun load() {
    stage = VoiceSetupStage.Loading
    stage = try {
      val r = client.voiceProviders()
      plan = VoiceSetup.plan(trigger, r.providers)
      VoiceSetupStage.Choose()
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      VoiceSetupStage.Failed(e.message ?: "Couldn't load the voices.")
    }
  }
  LaunchedEffect(client, trigger) { load() }

  fun saved(p: VoiceProvider, r: VoiceKeyResult) {
    calls.voiceChanged(client, r.capabilities)
    when (val next = VoiceSetup.next(trigger, r.capabilities)) {
      is VoiceSetup.Next.StillMissing -> scope.launch { load(); stage = VoiceSetupStage.Choose(next.message) }
      else -> {
        view.performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY)
        stage = VoiceSetupStage.Ready(p.name.ifEmpty { p.id }, next)
      }
    }
  }

  fun save(p: VoiceProvider, key: String) {
    val k = key.trim()
    if (k.isEmpty()) return
    stage = VoiceSetupStage.Key(p, checking = true)
    scope.launch {
      try {
        val r = gate.run { a -> if (p.id == "openai") client.setOpenAIVoiceKey(k, a) else client.setVoiceKey(p.id, k, a) }
        if (r.ok) saved(p, r) else stage = VoiceSetupStage.Key(p, error = r.error ?: "That key didn't work. Check it and try again.")
      } catch (e: CancellationException) {
        throw e
      } catch (e: MercuryException.Server) {
        stage = if (e.code == 409) VoiceSetupStage.Locked(p, e.message ?: lockedLine(p))
        else VoiceSetupStage.Key(p, error = e.message ?: "That key didn't work. Check it and try again.")
      } catch (e: Exception) {
        stage = VoiceSetupStage.Key(p, error = e.message ?: "That didn't work. Try again.")
      }
    }
  }

  // Voice is ready: carry on with what the owner was doing.
  val ready = stage as? VoiceSetupStage.Ready
  LaunchedEffect(ready) {
    if (ready != null && ready.next != VoiceSetup.Next.Done) {
      delay(800)
      onContinue(ready.next)
    }
  }

  val busy = (stage as? VoiceSetupStage.Key)?.checking == true
  ModalBottomSheet(onDismissRequest = { if (!busy) onDismiss() }, sheetState = state) {
    Column(
      Modifier.fillMaxWidth().fillMaxHeight().verticalScroll(rememberScrollState())
        .padding(horizontal = 20.dp).padding(bottom = 24.dp).navigationBarsPadding().imePadding(),
      verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
      VoiceSetupContent(
        trigger, stage, plan, gate.question?.code,
        onPick = { c ->
          stage = when (c.state) {
            VoiceSetup.Choice.State.Locked -> VoiceSetupStage.Locked(c.provider, c.provider.note ?: lockedLine(c.provider))
            else -> VoiceSetupStage.Key(c.provider)
          }
        },
        onStart = { onContinue(trigger.goAhead()) },
        onSave = ::save,
        onBack = { stage = VoiceSetupStage.Choose() },
        onRetry = { scope.launch { load() } },
        onDone = { r -> onContinue(r.next) },
      )
    }
  }
}

private fun lockedLine(p: VoiceProvider): String =
  "${p.name.ifEmpty { p.id }}'s key is set on your computer${p.env?.let { " ($it in ~/.mercury/.env)" } ?: ""}. Change it there, or use a different voice."

/** The sheet's content for each stage, apart from the sheet so previews and tests can draw it. */
@Composable
fun VoiceSetupContent(
  trigger: VoiceSetup.Trigger,
  stage: VoiceSetupStage,
  plan: VoiceSetup.Plan?,
  /** The owner's approval code while waiting for it. */
  approvalCode: String?,
  onPick: (VoiceSetup.Choice) -> Unit,
  onStart: () -> Unit,
  onSave: (VoiceProvider, String) -> Unit,
  onBack: () -> Unit,
  onRetry: () -> Unit,
  onDone: (VoiceSetupStage.Ready) -> Unit,
) {
  Text(VoiceSetup.TITLE, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
  Text(VoiceSetup.SUBTITLE, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
  when (stage) {
    VoiceSetupStage.Loading -> Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
      CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.5.dp)
    }
    is VoiceSetupStage.Failed -> {
      ErrorText(stage.message)
      OutlinedButton(onClick = onRetry) { Text("Retry") }
    }
    is VoiceSetupStage.Choose -> plan?.let { ChooseVoice(trigger, it, stage.notice, onPick, onStart) }
    is VoiceSetupStage.Key -> KeyStep(stage, approvalCode, onSave, onBack)
    is VoiceSetupStage.Ready -> ReadyStep(stage, trigger, onDone)
    is VoiceSetupStage.Locked -> {
      VoiceMark(stage.provider)
      Text(stage.message, style = MaterialTheme.typography.bodyMedium)
      Button(onClick = onBack, modifier = Modifier.fillMaxWidth().height(52.dp)) { Text("Use a different voice") }
    }
  }
}

@Composable
private fun ChooseVoice(
  trigger: VoiceSetup.Trigger,
  plan: VoiceSetup.Plan,
  notice: String?,
  onPick: (VoiceSetup.Choice) -> Unit,
  onStart: () -> Unit,
) {
  var more by remember { mutableStateOf(false) }
  notice?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = Mercury.colors.amber) }
  Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
    plan.choices.forEach { VoiceChoiceRow(it) { onPick(it) } }
  }
  plan.ready?.let {
    Button(onClick = onStart, modifier = Modifier.fillMaxWidth().height(52.dp)) {
      Text(if (trigger == VoiceSetup.Trigger.Settings) "Done" else "Start talking")
    }
  }
  if (plan.more.isNotEmpty()) {
    Row(
      Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = if (more) "Hide more options" else "Show more options") { more = !more }
        .padding(vertical = 8.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text("More options", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
      Icon(if (more) Icons.Outlined.KeyboardArrowUp else Icons.Outlined.KeyboardArrowDown, null, tint = Mercury.colors.ink3)
    }
    AnimatedVisibility(more) {
      Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("For dictation only (speech to text in the message box).", style = MaterialTheme.typography.bodySmall, color = Mercury.colors.ink3)
        plan.more.forEach { VoiceChoiceRow(it) { onPick(it) } }
      }
    }
  }
}

/** A voice as a large row: its mark, its name, one line. */
@Composable
fun VoiceChoiceRow(c: VoiceSetup.Choice, onClick: () -> Unit) {
  val ready = c.state == VoiceSetup.Choice.State.Ready
  Surface(
    shape = RoundedCornerShape(18.dp),
    color = MaterialTheme.colorScheme.surfaceContainerHigh,
    border = if (ready) BorderStroke(1.5.dp, MaterialTheme.colorScheme.onSurface) else null,
    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp))
      .clickable(enabled = !ready, role = Role.Button, onClickLabel = "Use ${c.provider.name}", onClick = onClick),
  ) {
    Row(Modifier.padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
      VoiceMark(c.provider)
      Column(Modifier.weight(1f).padding(start = 14.dp)) {
        Text(c.provider.name.ifEmpty { c.id }, style = MaterialTheme.typography.titleMedium)
        Text(c.line, style = MaterialTheme.typography.bodySmall, color = if (ready) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
      }
      when (c.state) {
        VoiceSetup.Choice.State.Ready -> Icon(Icons.Outlined.CheckCircle, "Ready", tint = MaterialTheme.colorScheme.onSurface)
        VoiceSetup.Choice.State.Locked -> Icon(Icons.Outlined.Lock, null, tint = Mercury.colors.ink3)
        VoiceSetup.Choice.State.Add -> Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = Mercury.colors.ink3)
      }
    }
  }
}

/** A monochrome monogram: the provider's first letter in a ring. */
@Composable
fun VoiceMark(p: VoiceProvider) {
  Box(
    Modifier.size(40.dp).border(1.5.dp, MaterialTheme.colorScheme.onSurface, CircleShape),
    contentAlignment = Alignment.Center,
  ) {
    Text((p.name.ifEmpty { p.id }).take(1).uppercase(), fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
  }
}

@Composable
private fun KeyStep(stage: VoiceSetupStage.Key, approvalCode: String?, onSave: (VoiceProvider, String) -> Unit, onBack: () -> Unit) {
  val p = stage.provider
  val context = LocalContext.current
  val uri = LocalUriHandler.current
  var draft by remember(p.id) { mutableStateOf("") }
  Row(verticalAlignment = Alignment.CenterVertically) {
    VoiceMark(p)
    Column(Modifier.padding(start = 14.dp)) {
      Text(p.name.ifEmpty { p.id }, style = MaterialTheme.typography.titleMedium)
      Text(VoiceSetup.blurb(p.id), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
  OutlinedTextField(
    value = draft, onValueChange = { draft = it },
    label = { Text("${p.name.ifEmpty { p.id }} API key") },
    singleLine = true,
    enabled = !stage.checking,
    isError = stage.error != null,
    supportingText = stage.error?.let { { Text(it) } },
    visualTransformation = PasswordVisualTransformation(),
    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false, capitalization = KeyboardCapitalization.None, imeAction = ImeAction.Done),
    keyboardActions = KeyboardActions(onDone = { if (draft.isNotBlank()) onSave(p, draft) }),
    modifier = Modifier.fillMaxWidth(),
  )
  Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
    AssistChip(
      onClick = {
        val clip = context.getSystemService(ClipboardManager::class.java)?.primaryClip
        val text = clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()?.trim()
        if (!text.isNullOrEmpty()) draft = text
      },
      enabled = !stage.checking,
      label = { Text("Paste") },
      leadingIcon = { Icon(Icons.Outlined.ContentPaste, null, Modifier.size(18.dp)) },
    )
    VoiceSetup.keyPage(p.id)?.let { url ->
      AssistChip(
        onClick = { runCatching { uri.openUri(url) } },
        label = { Text("Get a key") },
        trailingIcon = { Icon(Icons.AutoMirrored.Outlined.OpenInNew, null, Modifier.size(16.dp)) },
      )
    }
  }
  if (stage.checking) {
    if (approvalCode != null) {
      Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Approve on your computer · code $approvalCode", style = MaterialTheme.typography.titleSmall,
          modifier = Modifier.semantics { contentDescription = "Approve on your computer, code " + approvalCode.toList().joinToString(" ") })
        Text(approvalCode, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold, fontSize = 30.sp, letterSpacing = 6.sp)
        Text("Waiting for the go-ahead. It carries on by itself.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        LinearProgressIndicator(Modifier.fillMaxWidth(0.4f), color = MaterialTheme.colorScheme.onSurface)
      }
    } else {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        Text("Checking your key…", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
    }
  } else {
    Button(onClick = { onSave(p, draft) }, enabled = draft.isNotBlank(), modifier = Modifier.fillMaxWidth().height(52.dp)) { Text("Save and check") }
    TextButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) { Text("Use a different voice") }
  }
}

@Composable
private fun ReadyStep(stage: VoiceSetupStage.Ready, trigger: VoiceSetup.Trigger, onDone: (VoiceSetupStage.Ready) -> Unit) {
  Column(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
    Icon(Icons.Outlined.CheckCircle, null, Modifier.size(44.dp), tint = MaterialTheme.colorScheme.onSurface)
    Text("✓ Voice is ready", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
    Text(
      when (stage.next) {
        VoiceSetup.Next.StartCall -> "${stage.name} is set. Calling Mercury…"
        VoiceSetup.Next.StartDictation -> "${stage.name} is set. Listening…"
        else -> "${stage.name} is set. Calls and dictation pick it up now."
      },
      style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.height(4.dp))
    Button(onClick = { onDone(stage) }, modifier = Modifier.fillMaxWidth().height(52.dp)) {
      Text(if (trigger == VoiceSetup.Trigger.Settings) "Done" else "Start talking")
    }
  }
}
