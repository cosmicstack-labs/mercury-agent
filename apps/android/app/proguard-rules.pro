# Navigation routes are @Serializable objects.
-keepclassmembers @kotlinx.serialization.Serializable class sh.mercuryagent.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
