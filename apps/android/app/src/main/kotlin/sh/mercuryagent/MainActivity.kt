package sh.mercuryagent

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import sh.mercuryagent.ui.MercuryRoot
import sh.mercuryagent.ui.theme.MercuryTheme
import sh.mercuryagent.ui.theme.isDark

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val container = (application as MercuryApplication).container
    if (savedInstanceState == null) handle(intent)
    setContent {
      val appearance by container.appearance.state.collectAsStateWithLifecycle()
      val dark = appearance.isDark()
      // System bar icons follow the app's light or dark, not only the system's.
      DisposableEffect(dark) {
        enableEdgeToEdge(
          statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT) { dark },
          navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT) { dark },
        )
        onDispose {}
      }
      MercuryTheme(appearance) { MercuryRoot(container) }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handle(intent)
  }

  /** A notification's tap or a mercury:// link: open that chat (or the bots); Call Mercury (the app shortcut): a call. */
  private fun handle(intent: Intent?) {
    if (intent?.action == ACTION_CALL) { (application as MercuryApplication).container.requestCall(); return }
    // The ring notification's Answer (ADR-046): the call starts here and Mercury says why it called.
    if (intent?.action == ACTION_ANSWER_RING) {
      intent.getStringExtra(sh.mercuryagent.call.RingTelecom.EXTRA_RING)?.let { (application as MercuryApplication).container.answerRing(it) }
      return
    }
    val key = sh.mercuryagent.notify.Notifier.keyOf(intent?.data) ?: return
    (application as MercuryApplication).container.open(key)
  }

  companion object {
    /** The launcher's Call Mercury shortcut (res/xml/shortcuts.xml). */
    const val ACTION_CALL = "sh.mercuryagent.action.CALL"
    /** Answer on the ring notification (call/RingTelecom.kt). */
    const val ACTION_ANSWER_RING = "sh.mercuryagent.action.ANSWER_RING"
  }
}
