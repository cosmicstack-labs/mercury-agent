package sh.mercuryagent.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.unit.dp
import sh.mercuryagent.data.Appearance
import sh.mercuryagent.data.ThemeMode

/** Default Material type scale: Roboto, or the phone's own font (Google Sans on Pixels). */
val MercuryTypography = Typography()

val MercuryShapes = Shapes(
  extraSmall = RoundedCornerShape(6.dp),
  small = RoundedCornerShape(10.dp),
  medium = RoundedCornerShape(14.dp),
  large = RoundedCornerShape(18.dp),
  extraLarge = RoundedCornerShape(28.dp),
)

@Composable
fun Appearance.isDark(): Boolean = when (mode) {
  ThemeMode.System -> isSystemInDarkTheme()
  ThemeMode.Light -> false
  ThemeMode.Dark -> true
}

/** Mercury's monochrome theme, light or dark as the person picks (System, Light, Dark). */
@Composable
fun MercuryTheme(appearance: Appearance = Appearance(), content: @Composable () -> Unit) {
  val dark = appearance.isDark()
  val scheme = mercuryColorScheme(dark)
  CompositionLocalProvider(LocalMercuryColors provides MercuryColors.of(dark)) {
    MaterialTheme(colorScheme = scheme, typography = MercuryTypography, shapes = MercuryShapes, content = content)
  }
}

object Mercury {
  val colors: MercuryColors
    @Composable @ReadOnlyComposable get() = LocalMercuryColors.current
}
