plugins {
  alias(libs.plugins.android.application) apply false
  alias(libs.plugins.android.library) apply false
  alias(libs.plugins.kotlin.android) apply false
  alias(libs.plugins.kotlin.compose) apply false
  alias(libs.plugins.kotlin.serialization) apply false
}

// The Mac's internal disk is nearly full: with -Pmercury.buildRoot=<dir> every project builds
// into <dir>/<project name> instead of <project>/build (scripts/dev.sh always sets it).
val buildRoot = providers.gradleProperty("mercury.buildRoot").orNull
if (!buildRoot.isNullOrBlank()) {
  allprojects {
    val name = if (this == rootProject) "root" else project.name
    layout.buildDirectory.set(file("$buildRoot/$name"))
  }
}
