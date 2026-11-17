# JNA binds the generated UniFFI classes by reflection: keep them and JNA as they are.
-keep class com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.** { public *; }
-keep class app.mercury.voice.** { *; }
-dontwarn java.awt.**
