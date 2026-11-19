plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.kotlin.compose)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "sh.mercuryagent"
  compileSdk = 36

  defaultConfig {
    applicationId = "sh.mercuryagent.android"
    minSdk = 29
    targetSdk = 36
    versionCode = 1
    versionName = "0.1.0"
    // The voice engine is built for phones (arm64) and emulators (x86_64) only.
    ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
  }

  buildTypes {
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  buildFeatures {
    compose = true
    buildConfig = true
  }

  testOptions {
    unitTests.isReturnDefaultValues = true
  }

  packaging {
    resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/versions/9/OSGI-INF/MANIFEST.MF")
  }
}

kotlin {
  jvmToolchain(17)
}

dependencies {
  implementation(project(":core"))
  implementation(project(":voice"))
  implementation(libs.androidx.core.telecom)

  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.lifecycle.runtime.compose)
  implementation(libs.androidx.lifecycle.viewmodel.compose)
  implementation(libs.androidx.navigation.compose)
  implementation(libs.androidx.datastore.preferences)
  implementation(libs.kotlinx.coroutines.android)

  implementation(platform(libs.compose.bom))
  implementation(libs.compose.ui)
  implementation(libs.compose.ui.graphics)
  implementation(libs.compose.ui.tooling.preview)
  implementation(libs.compose.material3)
  implementation(libs.compose.material.icons)
  debugImplementation(libs.compose.ui.tooling)

  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
  testImplementation(libs.okhttp.mockwebserver)
}
