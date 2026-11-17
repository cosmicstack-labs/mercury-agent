package sh.mercuryagent.ui.conversation

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.MusicNote
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import sh.mercuryagent.core.MediaAvailability
import sh.mercuryagent.core.MediaIntent
import sh.mercuryagent.ui.components.MercuryMark
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.EventAvailable
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.MenuBook
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.TravelExplore
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.LocalTime
import sh.mercuryagent.core.Suggestion
import sh.mercuryagent.core.SuggestionPick
import sh.mercuryagent.ui.components.MarkTile
import sh.mercuryagent.ui.theme.Mercury

// A new chat (iOS WelcomeView, Desktop's Welcome.tsx): a greeting, a line about what the owner is up
// to, and a few things they might want next, made by the runtime (GET /api/suggestions). Tapping one
// puts it in the message box; nothing runs by itself. It never breaks a new chat: without
// suggestions it shows the mark and the media chips alone.

object Welcome {
  const val ASK = "Ask"
  const val CODE = "Code"
  const val PLAIN = "Ask, delegate, or think out loud. I'll remember what matters."

  /** "Good morning" and the like, for when the runtime has no greeting. */
  fun greeting(now: LocalTime = LocalTime.now()): String = when (now.hour) {
    in 5..11 -> "Good morning"
    in 12..16 -> "Good afternoon"
    in 17..21 -> "Good evening"
    else -> "Hello"
  }

  fun icon(kind: String?) = when (kind) {
    "continue" -> Icons.Outlined.History
    "plan" -> Icons.Outlined.EventAvailable
    "check" -> Icons.Outlined.Checklist
    "learn" -> Icons.Outlined.MenuBook
    "explore" -> Icons.Outlined.TravelExplore
    else -> Icons.Outlined.AutoAwesome
  }
}

/** The middle of an empty chat, as in Grok: a large, faint mark and one quiet line. */
@Composable
fun WelcomeHello(pick: SuggestionPick?, modifier: Modifier = Modifier, compact: Boolean = false) {
  Box(modifier.fillMaxSize().padding(horizontal = 32.dp), Alignment.Center) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(if (compact) 10.dp else 18.dp)) {
      MercuryMark(Modifier.size(if (compact) 64.dp else 120.dp).alpha(0.9f), color = Mercury.colors.ink4.copy(alpha = 0.55f))
      Text(
        pick?.greeting ?: Welcome.greeting(), style = MaterialTheme.typography.bodyLarge, color = Mercury.colors.ink3,
        textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis,
      )
    }
  }
}

/**
 * Ask | Code, the top bar's mode (Grok's segmented pill). Code sends each message as a coding turn
 * (`programming: "auto"`, in Mercury's project folder as `cwd`); Ask is a chat.
 */
@Composable
fun AskCode(code: Boolean, onPick: (Boolean) -> Unit) {
  val scheme = MaterialTheme.colorScheme
  Row(
    Modifier.height(32.dp).clip(RoundedCornerShape(16.dp)).background(scheme.surfaceContainerHigh)
      .border(1.dp, Mercury.colors.line, RoundedCornerShape(16.dp)).padding(2.5.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    for ((label, on) in listOf(Welcome.ASK to !code, Welcome.CODE to code)) {
      Box(
        Modifier.fillMaxHeight().clip(RoundedCornerShape(14.dp))
          .background(if (on) scheme.surfaceContainerHighest else Color.Transparent)
          .selectable(selected = on, role = Role.Tab) { onPick(label == Welcome.CODE) }
          .semantics { contentDescription = if (label == Welcome.CODE) "Code mode" else "Ask mode" }
          .padding(horizontal = 12.dp),
        Alignment.Center,
      ) {
        Text(label, style = MaterialTheme.typography.labelLarge.copy(fontSize = 14.sp, fontWeight = FontWeight.Medium), color = if (on) scheme.onSurface else Mercury.colors.ink3)
      }
    }
  }
}

/**
 * What fits in a new chat's room between the bar and the composer: as many quick-action chips as fit
 * (from the first), then the mark and greeting only while not typing and with room left. Pure, so
 * "nothing overlaps at any height" is tested.
 */
data class NewChatLayout(val hello: Boolean, val chips: Int, val compact: Boolean = false) {
  /** The room the mark and greeting take as laid out (0 when hidden). */
  val helloHeight: Float get() = if (!hello) 0f else if (compact) COMPACT_MIN else HELLO_MIN

  companion object {
    /** The mark (120 dp), the gap, the line, a margin. */
    const val HELLO_MIN = 190f
    /** A short screen: a 64 dp mark. */
    const val COMPACT_MIN = 104f
    const val SPACING = 8f
    const val PADDING = 12f

    /** The height `n` chips of `chip` dp take, the column's padding included (0 for none). */
    fun chipsHeight(n: Int, chip: Float): Float = if (n <= 0) 0f else n * chip + (n - 1) * SPACING + PADDING

    fun of(height: Float, chips: Int, chip: Float, typing: Boolean): NewChatLayout {
      var n = chips
      while (n > 0 && chipsHeight(n, chip) > height - 8f) n--
      val left = height - chipsHeight(n, chip)
      return when {
        typing -> NewChatLayout(hello = false, chips = n)
        left >= HELLO_MIN -> NewChatLayout(hello = true, chips = n)
        left >= COMPACT_MIN -> NewChatLayout(hello = true, chips = n, compact = true)
        else -> NewChatLayout(hello = false, chips = n)
      }
    }
  }
}

/**
 * A new chat's room between the bar and the composer, as in the ChatGPT and Grok apps: the mark and
 * greeting in the middle, the quick-action chips just above the composer. Keyboard-aware: the
 * composer rides the keyboard (imePadding), so this room shrinks as it comes up; while the keyboard
 * is up the mark and greeting shrink and fade away, and the chips stay just above the composer, as
 * many as fit (none without room), so nothing overlaps. They come back when the keyboard goes.
 */
@Composable
fun NewChatSpace(
  pick: SuggestionPick?, ideas: List<Suggestion>, media: MediaAvailability?, typing: Boolean,
  onMedia: (MediaIntent) -> Unit, onPick: (Suggestion) -> Unit, modifier: Modifier = Modifier,
) {
  val density = LocalDensity.current
  // A chip's height as drawn (44 dp at least; more with large text), measured from the first one.
  var chip by remember { mutableFloatStateOf(46f) }
  val all = QuickActions.items(ideas, media).size
  BoxWithConstraints(modifier.fillMaxSize()) {
    val lay = NewChatLayout.of(maxHeight.value, all, chip, typing)
    Column(Modifier.fillMaxSize()) {
      Box(Modifier.weight(1f).fillMaxWidth(), Alignment.Center) {
        androidx.compose.animation.AnimatedVisibility(visible = lay.hello, enter = fadeIn() + scaleIn(initialScale = 0.8f), exit = fadeOut() + scaleOut(targetScale = 0.8f)) {
          WelcomeHello(pick, compact = lay.compact)
        }
      }
      AnimatedVisibility(lay.chips > 0, enter = fadeIn() + expandVertically(expandFrom = Alignment.Top), exit = fadeOut() + shrinkVertically()) {
        QuickActions(ideas, media, onMedia, onPick, limit = maxOf(lay.chips, 1)) { px -> chip = with(density) { px.toDp().value } }
      }
    }
  }
}

/**
 * Above the composer in a new chat, stacked on the left as in Grok: Make an image, Create a video,
 * Make music (each sets the next message, as the + sheet does), then up to two of the runtime's
 * ideas in the same style (a tap puts it in the box; nothing runs by itself). At most [limit] of
 * them where the screen is short.
 */
@Composable
fun QuickActions(
  ideas: List<Suggestion>, media: MediaAvailability?, onMedia: (MediaIntent) -> Unit, onPick: (Suggestion) -> Unit,
  limit: Int = Int.MAX_VALUE, onChipHeight: (Int) -> Unit = {},
) {
  Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    QuickActions.items(ideas, media).take(limit).forEachIndexed { i, item ->
      val m = if (i == 0) Modifier.onSizeChanged { onChipHeight(it.height) } else Modifier
      when (item) {
        is QuickActions.Item.Media -> QuickChip(item.icon, item.label, m) { onMedia(item.intent) }
        is QuickActions.Item.Idea -> QuickChip(Welcome.icon(item.s.kind), item.s.title, m) { onPick(item.s) }
      }
    }
  }
}

object QuickActions {
  sealed interface Item {
    data class Media(val intent: MediaIntent, val icon: androidx.compose.ui.graphics.vector.ImageVector, val label: String) : Item
    data class Idea(val s: Suggestion) : Item
  }

  fun items(ideas: List<Suggestion>, media: MediaAvailability?): List<Item> {
    val a = media ?: MediaAvailability.unknown
    return buildList {
      if (a.image) add(Item.Media(MediaIntent(MediaIntent.IMAGE, MediaIntent.SQUARE), Icons.Outlined.Image, "Make an image"))
      if (a.video) add(Item.Media(MediaIntent(MediaIntent.VIDEO, MediaIntent.LANDSCAPE), Icons.Outlined.Movie, "Create a video"))
      if (a.music) add(Item.Media(MediaIntent(MediaIntent.MUSIC), Icons.Outlined.MusicNote, "Make music"))
      ideas.forEach { add(Item.Idea(it)) }
    }
  }
}

@Composable
private fun QuickChip(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
  Surface(
    onClick = onClick, shape = RoundedCornerShape(22.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh,
    border = BorderStroke(1.dp, Mercury.colors.line), modifier = modifier.heightIn(min = 44.dp).widthIn(max = 320.dp),
  ) {
    Row(Modifier.padding(horizontal = 16.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
      Icon(icon, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurface)
      Text(label, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
  }
}
