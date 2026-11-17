package sh.mercuryagent.ui.call

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import kotlinx.coroutines.launch

/** What a refused microphone says (iOS: "Mercury can't hear you…"). */
const val MIC_DENIED = "Mercury can't hear you. Allow the microphone for Mercury in Settings."

/**
 * The microphone permission, asked when it's first needed (a call or dictation): runs the action
 * at once when it's allowed, asks otherwise, and when it's refused says so with a way to Settings
 * (Android stops asking after two refusals).
 */
@Composable
fun rememberMicPermission(snackbar: SnackbarHostState): (onGranted: () -> Unit) -> Unit {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  val pending = remember { arrayOfNulls<() -> Unit>(1) }
  val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    val action = pending[0]
    pending[0] = null
    if (granted) action?.invoke() else scope.launch {
      snackbar.currentSnackbarData?.dismiss()
      val r = snackbar.showSnackbar(MIC_DENIED, actionLabel = "Settings", withDismissAction = true)
      if (r == SnackbarResult.ActionPerformed) {
        runCatching {
          context.startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
          )
        }
      }
    }
  }
  return remember(launcher) {
    { onGranted ->
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) onGranted()
      else { pending[0] = onGranted; launcher.launch(Manifest.permission.RECORD_AUDIO) }
    }
  }
}
