package sh.mercuryagent

import android.app.Activity
import android.app.Application
import android.os.Bundle

class MercuryApplication : Application() {
  lateinit var container: AppContainer
    private set

  override fun onCreate() {
    super.onCreate()
    container = AppContainer(this)
    // The app is on screen while any of its activities is started: the activity stream follows it.
    registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
      private var started = 0
      override fun onActivityStarted(a: Activity) { if (started++ == 0) container.monitor.setVisible(true) }
      override fun onActivityStopped(a: Activity) { if (--started == 0) container.monitor.setVisible(false) }
      override fun onActivityCreated(a: Activity, b: Bundle?) {}
      override fun onActivityResumed(a: Activity) {}
      override fun onActivityPaused(a: Activity) {}
      override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}
      override fun onActivityDestroyed(a: Activity) {}
    })
  }
}
