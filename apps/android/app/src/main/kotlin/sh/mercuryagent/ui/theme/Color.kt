package sh.mercuryagent.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

fun rgb(v: Int): Color = Color(0xFF000000.toInt() or v)

/**
 * Mercury on Android is monochrome, like the ChatGPT and Grok apps: white paper in light mode,
 * true black in dark mode, greys for surfaces, and ink (black on light, white on dark) for primary
 * actions. Mercury's green lives only in the mark and the small status dots ([MercuryColors]).
 */
fun mercuryColorScheme(dark: Boolean): ColorScheme = if (dark) {
  darkColorScheme(
    primary = rgb(0xF2F2F2),
    onPrimary = rgb(0x000000),
    primaryContainer = rgb(0x2A2A2A),
    onPrimaryContainer = rgb(0xF2F2F2),
    inversePrimary = rgb(0x0D0D0D),
    secondary = rgb(0xB4B4B4),
    onSecondary = rgb(0x000000),
    secondaryContainer = rgb(0x262626),
    onSecondaryContainer = rgb(0xECECEC),
    tertiary = rgb(0xB4B4B4),
    onTertiary = rgb(0x000000),
    tertiaryContainer = rgb(0x262626),
    onTertiaryContainer = rgb(0xECECEC),
    background = rgb(0x000000),
    onBackground = rgb(0xECECEC),
    surface = rgb(0x000000),
    onSurface = rgb(0xECECEC),
    surfaceVariant = rgb(0x1C1C1C),
    onSurfaceVariant = rgb(0xA3A3A3),
    surfaceTint = Color.Transparent,
    inverseSurface = rgb(0xECECEC),
    inverseOnSurface = rgb(0x111111),
    error = rgb(0xFF6B6B),
    onError = rgb(0x000000),
    errorContainer = rgb(0x3D1414),
    onErrorContainer = rgb(0xFFDAD6),
    outline = rgb(0x6B6B6B),
    outlineVariant = rgb(0x2A2A2A),
    scrim = Color.Black,
    surfaceBright = rgb(0x2A2A2A),
    surfaceDim = rgb(0x000000),
    surfaceContainerLowest = rgb(0x000000),
    surfaceContainerLow = rgb(0x0E0E0E),
    surfaceContainer = rgb(0x141414),
    surfaceContainerHigh = rgb(0x1E1E1E),
    surfaceContainerHighest = rgb(0x282828),
  )
} else {
  lightColorScheme(
    primary = rgb(0x0D0D0D),
    onPrimary = rgb(0xFFFFFF),
    primaryContainer = rgb(0xF0F0F0),
    onPrimaryContainer = rgb(0x0D0D0D),
    inversePrimary = rgb(0xF2F2F2),
    secondary = rgb(0x5D5D5D),
    onSecondary = rgb(0xFFFFFF),
    secondaryContainer = rgb(0xEDEDED),
    onSecondaryContainer = rgb(0x0D0D0D),
    tertiary = rgb(0x5D5D5D),
    onTertiary = rgb(0xFFFFFF),
    tertiaryContainer = rgb(0xEDEDED),
    onTertiaryContainer = rgb(0x0D0D0D),
    background = rgb(0xFFFFFF),
    onBackground = rgb(0x0D0D0D),
    surface = rgb(0xFFFFFF),
    onSurface = rgb(0x0D0D0D),
    surfaceVariant = rgb(0xF4F4F4),
    onSurfaceVariant = rgb(0x5D5D5D),
    surfaceTint = Color.Transparent,
    inverseSurface = rgb(0x0D0D0D),
    inverseOnSurface = rgb(0xF2F2F2),
    error = rgb(0xC53030),
    onError = rgb(0xFFFFFF),
    errorContainer = rgb(0xFBE3E1),
    onErrorContainer = rgb(0x5E1414),
    outline = rgb(0x8E8E8E),
    outlineVariant = rgb(0xE5E5E5),
    scrim = Color.Black,
    surfaceBright = rgb(0xFFFFFF),
    surfaceDim = rgb(0xE8E8E8),
    surfaceContainerLowest = rgb(0xFFFFFF),
    surfaceContainerLow = rgb(0xF9F9F9),
    surfaceContainer = rgb(0xF4F4F4),
    surfaceContainerHigh = rgb(0xEEEEEE),
    surfaceContainerHighest = rgb(0xE8E8E8),
  )
}

/**
 * Colours Material has no role for: Mercury's green (the mark, and "working" dots), amber (needs
 * you), red (failed), and the quiet inks for secondary text.
 */
@Immutable
data class MercuryColors(
  val green: Color,
  val amber: Color,
  val red: Color,
  val ink3: Color,
  val ink4: Color,
  val line: Color,
  val dark: Boolean,
) {
  /** Neutral stand-in where iOS used cyan (thinking): the app stays monochrome. */
  val cyan: Color get() = ink3

  companion object {
    fun of(dark: Boolean) = if (dark) {
      MercuryColors(rgb(0x34E1A1), rgb(0xF5C451), rgb(0xFF6B6B), rgb(0x8E8E8E), rgb(0x5E5E5E), Color.White.copy(alpha = 0.10f), true)
    } else {
      MercuryColors(rgb(0x1A9E6E), rgb(0xB7791F), rgb(0xC53030), rgb(0x7A7A7A), rgb(0xABABAB), Color.Black.copy(alpha = 0.08f), false)
    }
  }
}

val LocalMercuryColors = staticCompositionLocalOf { MercuryColors.of(false) }
