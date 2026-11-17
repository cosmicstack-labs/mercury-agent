package sh.mercuryagent.core

import java.time.Instant
import java.time.OffsetDateTime
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.listSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/** Mercury's JSON: everything the runtime may add is ignored, nulls read as "left out". */
val MercuryJson: Json = Json {
  ignoreUnknownKeys = true
  explicitNulls = false
  coerceInputValues = true
  isLenient = true
  encodeDefaults = true
}

/** Mercury's dates: ISO 8601, usually with milliseconds and a Z. */
object InstantIso : KSerializer<Instant> {
  override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("Instant", PrimitiveKind.STRING)
  override fun serialize(encoder: Encoder, value: Instant) = encoder.encodeString(value.toString())
  override fun deserialize(decoder: Decoder): Instant =
    parseInstant(decoder.decodeString()) ?: throw IllegalArgumentException("Not a date")
}

fun parseInstant(s: String): Instant? =
  runCatching { Instant.parse(s) }.getOrNull() ?: runCatching { OffsetDateTime.parse(s).toInstant() }.getOrNull()

/** A date as Mercury may send it: an ISO string, or seconds or milliseconds since 1970. */
fun JsonElement?.asInstant(): Instant? {
  val p = this as? JsonPrimitive ?: return null
  if (p is JsonNull) return null
  if (p.isString) return parseInstant(p.content)
  val n = p.doubleOrNull ?: return null
  return Instant.ofEpochMilli(if (n > 1e12) n.toLong() else (n * 1000).toLong())
}

/** Decodes each element of an array on its own; one odd element never fails the list. */
@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
class LossyList<T>(private val element: KSerializer<T>) : KSerializer<List<T>> {
  override val descriptor: SerialDescriptor = listSerialDescriptor(element.descriptor)
  override fun serialize(encoder: Encoder, value: List<T>) = throw UnsupportedOperationException()
  override fun deserialize(decoder: Decoder): List<T> {
    val d = decoder as? JsonDecoder ?: return emptyList()
    val arr = d.decodeJsonElement() as? JsonArray ?: return emptyList()
    return arr.mapNotNull { runCatching { d.json.decodeFromJsonElement(element, it) }.getOrNull() }
  }
}

// Reading raw JSON objects the way the runtime's events arrive (each field may be missing or odd).

fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.toInt()
  ?: (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.toInt()
fun JsonObject.double(key: String): Double? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
fun JsonObject.arr(key: String): JsonArray? = this[key] as? JsonArray

/** Raw event data as an object (an empty one when it isn't JSON). */
fun parseObject(raw: String): JsonObject =
  runCatching { MercuryJson.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: JsonObject(emptyMap())
