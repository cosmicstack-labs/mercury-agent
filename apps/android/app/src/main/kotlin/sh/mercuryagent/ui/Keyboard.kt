package sh.mercuryagent.ui

import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.material3.DrawerState
import androidx.compose.material3.DrawerValue
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import kotlinx.coroutines.flow.drop

/**
 * Puts the keyboard away: hides it and lets go of the text field, so it doesn't come straight
 * back. The keyboard belongs to typing; opening the drawer, a menu, a sheet or another screen,
 * or scrolling the chat, means you've stopped (as ChatGPT and Grok behave).
 */
@Composable
fun rememberDismissKeyboard(): () -> Unit {
  val focus = LocalFocusManager.current
  val keyboard = LocalSoftwareKeyboardController.current
  return remember(focus, keyboard) { { keyboard?.hide(); focus.clearFocus(force = true) } }
}

/** The keyboard goes as soon as the drawer starts to open (a swipe or the menu button) or closes. */
@Composable
fun DismissKeyboardWithDrawer(drawer: DrawerState) {
  val dismiss = rememberDismissKeyboard()
  LaunchedEffect(drawer) {
    // Closed is the drawer's lowest offset; any movement past it is the drawer coming out.
    var closedAt = Float.NaN
    snapshotFlow { drawer.currentOffset }.collect { offset ->
      if (offset.isNaN()) return@collect
      if (closedAt.isNaN() || offset < closedAt) closedAt = offset
      else if (offset > closedAt + 8f) dismiss()
    }
  }
  LaunchedEffect(drawer) {
    snapshotFlow { drawer.targetValue }.drop(1).collect { if (it == DrawerValue.Open || it == DrawerValue.Closed) dismiss() }
  }
}

/** The keyboard goes when you drag the list yourself (not when a streaming reply scrolls it). */
@Composable
fun DismissKeyboardOnDrag(list: LazyListState) {
  val dismiss = rememberDismissKeyboard()
  LaunchedEffect(list) {
    list.interactionSource.interactions.collect { if (it is DragInteraction.Start) dismiss() }
  }
}
