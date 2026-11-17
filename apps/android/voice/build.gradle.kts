plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.android)
}

// Mercury's shared Rust voice engine (crates/mercury-voice-mobile) for Android: the UniFFI Kotlin
// bindings (src/main/java/app/mercury/voice, generated, committed) over the JNI libraries in
// src/main/jniLibs (built by scripts/build-voice-engine.sh, not committed). JNA loads the library.
android {
  namespace = "app.mercury.voice"
  compileSdk = 36

  defaultConfig {
    minSdk = 29
    consumerProguardFiles("consumer-rules.pro")
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

kotlin {
  jvmToolchain(17)
  compilerOptions {
    // The generated bindings trip a few warnings by design.
    suppressWarnings.set(true)
  }
}

dependencies {
  // The AAR carries JNA's own native dispatch library for each ABI.
  api("net.java.dev.jna:jna:${libs.versions.jna.get()}@aar")
}
