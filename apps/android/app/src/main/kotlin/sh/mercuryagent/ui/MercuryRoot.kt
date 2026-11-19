package sh.mercuryagent.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivity
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import sh.mercuryagent.AppContainer
import sh.mercuryagent.core.Connection
import sh.mercuryagent.ui.chats.ChatDrawer
import sh.mercuryagent.ui.chats.ChatsViewModel
import sh.mercuryagent.ui.connect.ConnectScreen
import sh.mercuryagent.ui.connect.ConnectViewModel
import sh.mercuryagent.ui.conversation.ConversationScreen
import sh.mercuryagent.ui.conversation.ConversationViewModel
import sh.mercuryagent.ui.media.LocalMediaLoader
import sh.mercuryagent.ui.media.MediaLoader
import sh.mercuryagent.ui.more.SettingsNav
import sh.mercuryagent.ui.more.settingsGraph

// Routes (type-safe Navigation Compose). The app is one chat at a time with a drawer, as in the
// ChatGPT and Grok apps; Bots, Artifacts, Brain and Settings open over it and back returns to the chat.
/** A chat: [id] null is a new one; [n] makes each "New chat" its own screen. */
@Serializable data class ChatRoute(val id: String? = null, val n: Long = 0)
@Serializable object BotsRoute
@Serializable object ArtifactsRoute
@Serializable object BrainRoute
@Serializable object AddMercuryRoute

/** Connect when no Mercury is saved yet, otherwise the app for the active one (iOS: RootView). */
@Composable
fun MercuryRoot(container: AppContainer) {
  val state by container.connections.state.collectAsStateWithLifecycle()
  Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) {
    val active = state.active
    if (active == null) {
      val vm: ConnectViewModel = viewModel(key = "connect-first", factory = viewModelFactory {
        initializer { ConnectViewModel(container.connections, container.deviceName) }
      })
      ConnectScreen(vm)
    } else key(active.id) {
      Home(container, active)
    }
  }
}

/** The app once connected: the chat on screen, the drawer, and the screens opened over them. */
@Composable
private fun Home(container: AppContainer, connection: Connection) {
  val nav = rememberNavController()
  val activity = LocalActivity.current as ComponentActivity
  val context = LocalContext.current
  val client = remember(connection.id) { container.connections.client(connection) }
  val loader = remember(connection.id) { MediaLoader(client, context.applicationContext) }
  val snackbar = remember { SnackbarHostState() }
  val drawer = rememberDrawerState(DrawerValue.Closed)
  val scope = rememberCoroutineScope()
  val dismissKeyboard = rememberDismissKeyboard()
  DismissKeyboardWithDrawer(drawer)
  // One list per Mercury, shared by the drawer and its conversations (onChange, read marks).
  val state by container.connections.state.collectAsStateWithLifecycle()
  val chats: ChatsViewModel = viewModel(viewModelStoreOwner = activity, key = "chats-${connection.id}", factory = viewModelFactory {
    initializer { ChatsViewModel(client, connection.id, container.readMarks, container.monitor.activity) }
  })
  var currentChat by rememberSaveable { mutableStateOf<String?>(null) }
  var online by remember { mutableStateOf<Boolean?>(null) }
  val entry by nav.currentBackStackEntryAsState()
  val onChat = entry?.destination?.route?.startsWith(ChatRoute::class.qualifiedName.orEmpty()) != false
  // Another screen: the keyboard from the last one doesn't follow you there.
  LaunchedEffect(entry?.id) { dismissKeyboard() }

  // The activity stream runs while the app is started; coming back refreshes the list.
  LifecycleStartEffect(chats) {
    chats.listen()
    chats.reload()
    onStopOrDispose { chats.stopListening() }
  }
  LaunchedEffect(connection.id) {
    while (true) {
      online = runCatching { client.health() }.isSuccess
      delay(if (online == true) 60_000 else 15_000)
    }
  }
  LaunchedEffect(chats) {
    chats.messages.collect { m ->
      scope.launch {
        val r = snackbar.showSnackbar(m.text, actionLabel = if (m.undoDelete != null) "Undo" else null)
        if (r == androidx.compose.material3.SnackbarResult.ActionPerformed) m.undoDelete?.let(chats::undoDelete)
      }
    }
  }
  // A deep link from a notification opens that chat.
  LaunchedEffect(container) {
    container.openChat.collect { key ->
      drawer.close()
      if (key.startsWith("bot:")) nav.navigate(BotsRoute) else nav.openChat(key)
    }
  }

  fun closeThen(go: () -> Unit) { dismissKeyboard(); scope.launch { drawer.close() }; go() }

  // Android's notification permission, asked once at a sensible moment: right after the first
  // message is sent (Mercury may finish it while you're away), or when Stay connected is turned on.
  val askNotifications = androidx.activity.compose.rememberLauncherForActivityResult(
    androidx.activity.result.contract.ActivityResultContracts.RequestPermission(),
  ) { }
  val onSent: () -> Unit = {
    if (android.os.Build.VERSION.SDK_INT >= 33 && !container.notifyPrefs.value.asked && !container.notifier.canPost) {
      container.notifyPrefs.update { it.copy(asked = true) }
      askNotifications.launch(android.Manifest.permission.POST_NOTIFICATIONS)
    }
  }

  CompositionLocalProvider(LocalMediaLoader provides loader) {
    androidx.compose.foundation.layout.Box(Modifier.fillMaxSize()) {
      ModalNavigationDrawer(
        drawerState = drawer,
        gesturesEnabled = onChat || drawer.isOpen,
        drawerContent = {
          ModalDrawerSheet(
            drawerState = drawer, drawerContainerColor = MaterialTheme.colorScheme.background, drawerTonalElevation = 0.dp,
            drawerShape = androidx.compose.ui.graphics.RectangleShape, windowInsets = androidx.compose.foundation.layout.WindowInsets(0),
            modifier = Modifier.fillMaxWidth(0.88f),
          ) {
            ChatDrawer(
              chats, connection, state.connections, online, currentChat,
              onOpen = { t -> closeThen { if (t.id != currentChat) nav.openChat(t.id) } },
              onNewChat = { closeThen { nav.openChat(null) } },
              // Back to the chat on screen (a new one when none), and a call in it.
              onCall = { closeThen { if (!onChat) nav.openChat(currentChat); container.requestCall() } },
              onBots = { closeThen { nav.navigate(BotsRoute) } },
              onArtifacts = { closeThen { nav.navigate(ArtifactsRoute) } },
              onBrain = { closeThen { nav.navigate(BrainRoute) } },
              onSettings = { closeThen { nav.navigate(SettingsNav.Root) } },
              onClose = { closeThen { } },
              onSwitchMercury = { id -> closeThen { container.connections.activate(id) } },
              onAddMercury = { closeThen { nav.navigate(AddMercuryRoute) } },
              onEditMercury = { id, name, logo -> container.connections.update(id, name, logo) },
            )
          }
        },
      ) {
        NavHost(
          nav, startDestination = ChatRoute(container.startChat()),
          enterTransition = { slideIntoContainer(AnimatedContentTransitionScope.SlideDirection.Start, tween(300), initialOffset = { it / 4 }) + fadeIn(tween(300)) },
          exitTransition = { fadeOut(tween(200)) },
          popEnterTransition = { fadeIn(tween(300)) },
          popExitTransition = { slideOutOfContainer(AnimatedContentTransitionScope.SlideDirection.End, tween(300), targetOffset = { it / 4 }) + fadeOut(tween(200)) },
        ) {
          composable<ChatRoute>(
            enterTransition = { fadeIn(tween(220)) }, exitTransition = { fadeOut(tween(150)) },
            popEnterTransition = { fadeIn(tween(220)) }, popExitTransition = { fadeOut(tween(150)) },
          ) { e ->
            val id = e.toRoute<ChatRoute>().id
            val vm: ConversationViewModel = viewModel(factory = viewModelFactory {
              initializer {
                ConversationViewModel(
                  client,
                  chats.ui.value.threads.firstOrNull { it.id == id } ?: id?.let { stubThread(it) },
                  onChange = chats::reload,
                  onSent = onSent,
                  onCreated = { new -> currentChat = new; container.rememberChat(new) },
                  onSeen = { cid, open -> chats.viewing(cid, open); container.viewing(cid, open) },
                )
              }
            })
            LaunchedEffect(id) { currentChat = id; container.rememberChat(id) }
            ConversationScreen(
              vm, snackbar,
              onMenu = { dismissKeyboard(); scope.launch { drawer.open() } },
              onNewChat = { nav.openChat(null) },
              onDeleted = { nav.openChat(null) },
              onVoiceSettings = { nav.navigate(SettingsNav.Voice) },
            )
          }
          composable<BotsRoute> {
            androidx.compose.runtime.DisposableEffect(Unit) {
              container.monitor.botsOnScreen(true)
              onDispose { container.monitor.botsOnScreen(false) }
            }
            val vm: sh.mercuryagent.ui.bots.BotsViewModel = viewModel(key = "bots-${connection.id}", factory = viewModelFactory {
              initializer { sh.mercuryagent.ui.bots.BotsViewModel(client) }
            })
            sh.mercuryagent.ui.bots.BotsScreen(vm, onBack = { nav.popBackStack() }, onOpenChat = { nav.openChat(it) })
          }
          composable<ArtifactsRoute> {
            val vm: sh.mercuryagent.ui.artifacts.ArtifactsViewModel = viewModel(factory = viewModelFactory {
              initializer { sh.mercuryagent.ui.artifacts.ArtifactsViewModel(client) }
            })
            sh.mercuryagent.ui.artifacts.ArtifactsScreen(vm, onBack = { nav.popBackStack() }, onOpenChat = { nav.openChat(it) })
          }
          composable<BrainRoute> {
            // Kept for the activity's life (per Mercury), so the layout stays put between visits (desktop keeps it mounted).
            val vm: sh.mercuryagent.ui.brain.MindMapViewModel = viewModel(viewModelStoreOwner = activity, key = "brain-${connection.id}", factory = viewModelFactory {
              initializer {
                sh.mercuryagent.ui.brain.MindMapViewModel(client, container.mindMapSettings.state.value, { container.mindMapSettings.save(it) })
              }
            })
            sh.mercuryagent.ui.brain.MindMapScreen(vm, onBack = { nav.popBackStack() })
          }
          settingsGraph(nav, container, connection, client, onAddMercury = { nav.navigate(AddMercuryRoute) })
          composable<AddMercuryRoute> {
            val vm: ConnectViewModel = viewModel(factory = viewModelFactory {
              initializer { ConnectViewModel(container.connections, container.deviceName) }
            })
            ConnectScreen(vm, onClose = { nav.popBackStack() })
          }
        }
      }
      // A voice call covers everything until it's closed (back leaves it running in the background).
      container.calls.current?.let { call ->
        sh.mercuryagent.ui.call.VoiceCallScreen(call, onClose = { container.calls.close() })
      }
    }
  }
}

/** One chat at a time: opening another replaces the one on screen (back leaves the app). */
fun NavHostController.openChat(id: String?) = navigate(ChatRoute(id, System.nanoTime())) {
  popUpTo(0) { inclusive = true }
  launchSingleTop = false
}

private fun stubThread(id: String) = sh.mercuryagent.core.ChatThread(id = id, createdAt = java.time.Instant.now())
