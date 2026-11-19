package sh.mercuryagent.call

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import sh.mercuryagent.MainActivity
import sh.mercuryagent.MercuryApplication
import sh.mercuryagent.ui.components.MercuryMark
import sh.mercuryagent.ui.theme.MercuryTheme

/**
 * The full-screen incoming call (the ring notification's full-screen intent), over the lock screen:
 * Mercury, why it's calling, Answer and Decline. It closes itself when the ring stops (answered on
 * another phone, timed out). Answer opens the app's normal call, which starts by saying why.
 */
class IncomingCallActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setShowWhenLocked(true)
    setTurnScreenOn(true)
    val container = (application as MercuryApplication).container
    val id = intent.getStringExtra(RingTelecom.EXTRA_RING)
    setContent {
      val appearance by container.appearance.state.collectAsStateWithLifecycle()
      val ringing by container.ringer.ringing.collectAsStateWithLifecycle()
      LaunchedEffect(ringing) { if (ringing == null || (id != null && ringing?.id != id)) finish() }
      MercuryTheme(appearance) {
        val r = ringing
        if (r != null) IncomingCall(
          reason = r.reason,
          onAnswer = {
            if (container.answerRing(r.id)) startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            finish()
          },
          onDecline = { container.ringer.declineHere(r.id); finish() },
        )
      }
    }
  }
}

@Composable
fun IncomingCall(reason: String, onAnswer: () -> Unit, onDecline: () -> Unit) {
  Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(32.dp)) {
    Column(Modifier.fillMaxWidth().align(Alignment.TopCenter).padding(top = 72.dp), horizontalAlignment = Alignment.CenterHorizontally) {
      MercuryMark(Modifier.size(96.dp))
      Spacer(Modifier.height(24.dp))
      Text("Mercury", fontSize = 30.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onBackground)
      Spacer(Modifier.height(8.dp))
      Text("is calling", fontSize = 16.sp, color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.7f))
      if (reason.isNotBlank()) {
        Spacer(Modifier.height(24.dp))
        Text(reason, fontSize = 17.sp, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onBackground)
      }
    }
    Row(Modifier.fillMaxWidth().align(Alignment.BottomCenter).padding(bottom = 48.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
      RingButton("Decline", Icons.Filled.CallEnd, Color(0xFFE5484D), onDecline)
      RingButton("Answer", Icons.Filled.Call, Color(0xFF30A46C), onAnswer)
    }
  }
}

@Composable
private fun RingButton(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector, color: Color, onClick: () -> Unit) {
  Column(horizontalAlignment = Alignment.CenterHorizontally) {
    FilledIconButton(onClick = onClick, modifier = Modifier.size(72.dp), shape = CircleShape, colors = IconButtonDefaults.filledIconButtonColors(containerColor = color)) {
      Icon(icon, contentDescription = label, tint = Color.White, modifier = Modifier.size(32.dp))
    }
    Spacer(Modifier.height(8.dp))
    Text(label, color = MaterialTheme.colorScheme.onBackground)
  }
}
