# kotlinx.serialization: keep generated serializers of Mercury's models.
-keepclassmembers class sh.mercuryagent.core.** {
    *** Companion;
}
-keepclasseswithmembers class sh.mercuryagent.core.** {
    kotlinx.serialization.KSerializer serializer(...);
}
