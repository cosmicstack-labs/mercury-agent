pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "mercury-android"

include(":core")
include(":app")
// UniFFI Kotlin bindings + JNI libs for crates/mercury-voice-mobile (scripts/build-voice-engine.sh).
include(":voice")
