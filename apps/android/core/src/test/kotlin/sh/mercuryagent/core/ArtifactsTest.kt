package sh.mercuryagent.core

import java.time.Instant
import java.time.ZoneOffset
import java.util.Locale
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Port of apps/ios/MercuryKit/Tests/MercuryCoreTests/ArtifactsTests.swift.
class ArtifactsTest {
  private fun item(id: String, kind: String = "image", batch: String? = null, size: Long = 1000, owned: Boolean? = true) =
    ArtifactItem(id = id, name = "$id.png", kind = kind, size = size, batch = batch, owned = owned, originalExists = true)

  @Test fun batchesBecomeOneCardAtTheirNewestMember() {
    // Newest first, as GET /api/artifacts lists them; a single sits between two batch members.
    val groups = ArtifactGroup.group(listOf(item("a", batch = "b1"), item("x"), item("b", batch = "b1"), item("c", batch = "b2"), item("y")))
    assertEquals(listOf("batch:b1", "x", "c", "y"), groups.map { it.id })
    assertEquals(listOf("a", "b"), groups[0].ids)
    assertTrue(groups[0].isBatch)
    assertFalse(groups[2].isBatch) // a batch of one is just a card
    assertEquals(2000L, groups[0].size)
  }

  @Test fun emptyBatchIdIsNoBatch() {
    assertEquals(2, ArtifactGroup.group(listOf(item("a", batch = ""), item("b", batch = ""))).size)
  }

  @Test fun formatsBytesLikeDesktop() {
    assertEquals("0 B", ArtifactFormat.bytes(0))
    assertEquals("512 B", ArtifactFormat.bytes(512))
    assertEquals("38 KB", ArtifactFormat.bytes(38L * 1024))
    assertEquals("4.2 MB", ArtifactFormat.bytes((4.2 * 1024 * 1024).toLong()))
    assertEquals("1.25 GB", ArtifactFormat.bytes((1.25 * 1024 * 1024 * 1024).toLong()))
  }

  @Test fun freedTextSaysWhatHappened() {
    assertEquals("3 deleted, 4.4 MB freed.", ArtifactRemoved(removed = 3, freed = (4.4 * 1024 * 1024).toLong(), keptOriginals = 0).summary)
    assertEquals("1 deleted. 1 file in your projects stayed where they are.", ArtifactRemoved(removed = 1, freed = 0, keptOriginals = 1).summary)
    assertEquals("5 deleted, 2 KB freed. 2 files in your projects stayed where they are.", ArtifactRemoved(removed = 5, freed = 2048, keptOriginals = 2).summary)
  }

  @Test fun deleteWordingKeepsProjectFiles() {
    val own = item("a")
    val project = item("p", owned = false)
    assertEquals("Delete this file?", ArtifactFormat.deleteTitle(own))
    assertEquals("Remove from Mercury? (your file stays)", ArtifactFormat.deleteTitle(project))
    assertEquals("Removes it from Mercury. The file in your project stays.", ArtifactFormat.deleteDetail(project))
    assertEquals("Deletes the files.", ArtifactFormat.deleteDetail(listOf(own, item("b"))))
    assertEquals("Removes them from Mercury. The files in your projects stay.", ArtifactFormat.deleteDetail(listOf(project, item("q", owned = false))))
    assertTrue(ArtifactFormat.deleteDetail(listOf(own, project)).contains("1 in your projects stay"))
    assertEquals("Deleting removes the files from your output folder too.", ArtifactFormat.outsideNote(0))
    assertEquals("2 artifacts are files in your projects: deleting removes them from Mercury, the files stay.", ArtifactFormat.outsideNote(2))
    assertEquals("1 artifact is a file in your projects: deleting removes it from Mercury, the file stays.", ArtifactFormat.outsideNote(1))
  }

  @Test fun unknownOwnershipIsNotAProjectFile() {
    assertFalse(item("a", owned = null).keepsOriginal)
    assertTrue(item("a", owned = false).keepsOriginal)
  }

  @Test fun usageKindsBiggestFirstWithShares() {
    val u = ArtifactUsage(
      count = 4, bytes = 400,
      byKind = mapOf(
        "image" to ArtifactUsage.Kind(2, 100), "video" to ArtifactUsage.Kind(1, 300),
        "pdf" to ArtifactUsage.Kind(0, 0), "text" to ArtifactUsage.Kind(1, 0),
      ),
      freeable = 400, outside = 0,
    )
    assertEquals(listOf("video", "image", "text"), u.kinds.map { it.kind }) // empty kinds dropped
    assertEquals(1.0, u.kinds[0].share, 0.0)
    assertEquals(1.0 / 3, u.kinds[1].share, 0.001)
  }

  @Test fun usageTiesSortByKindName() {
    val u = ArtifactUsage(byKind = mapOf("video" to ArtifactUsage.Kind(1, 10), "audio" to ArtifactUsage.Kind(1, 10)))
    assertEquals(listOf("audio", "video"), u.kinds.map { it.kind })
    assertTrue(ArtifactUsage().kinds.isEmpty())
  }

  @Test fun cleanupScopesMatchTheServer() {
    assertEquals("image", ArtifactCleanup.OfKind("image").body()["kind"]!!.jsonPrimitive.content)
    assertEquals(30, ArtifactCleanup.OlderThan(30).body()["olderThanDays"]!!.jsonPrimitive.int)
    assertEquals(true, ArtifactCleanup.All.body()["all"]!!.jsonPrimitive.boolean)
    assertEquals(listOf("a", "b"), ArtifactCleanup.Ids(listOf("a", "b")).body()["ids"]!!.jsonArray.map { it.jsonPrimitive.content })
    assertEquals("""{"ids":["a","b"]}""", ArtifactCleanup.Ids(listOf("a", "b")).body().toString())
  }

  @Test fun decodesTheListAndUsageShapes() {
    val list = """{"items":[{"id":"a1","threadId":"t","name":"x.png","kind":"image","mime":"image/png","size":10,"originalPath":"/x.png","createdAt":1700000000000,"tool":"generate_image","batch":"b","prompt":"cat","threadTitle":"T","threadExists":true,"originalExists":true,"owned":true}],"nextCursor":null,"counts":{"all":1,"image":1}}"""
    val page = MercuryJson.decodeFromString(ArtifactPage.serializer(), list)
    val a = page.items[0]
    assertTrue(a.batch == "b" && a.owned == true && a.prompt == "cat")
    assertEquals("t", a.threadId)
    assertEquals(1_700_000_000_000.0, a.createdAt!!, 0.0)
    assertEquals(null, page.nextCursor)
    assertEquals(1, page.counts!!["image"])
    val usage = """{"count":1,"bytes":10,"byKind":{"image":{"count":1,"bytes":10}},"freeable":10,"outside":0}"""
    assertEquals(10L, MercuryJson.decodeFromString(ArtifactUsage.serializer(), usage).byKind["image"]?.bytes)
    val removed = """{"ok":true,"removed":2,"freed":20,"keptOriginals":0}"""
    assertEquals(2, MercuryJson.decodeFromString(ArtifactRemoved.serializer(), removed).removed)
  }

  @Test fun oddItemNeverFailsThePage() {
    val list = """{"items":[{"id":"a1","name":"x.png","kind":"image"},{"name":"no id"},7],"nextCursor":"c2"}"""
    val page = MercuryJson.decodeFromString(ArtifactPage.serializer(), list)
    assertEquals(listOf("a1"), page.items.map { it.id })
    assertEquals("c2", page.nextCursor)
  }

  @Test fun tokenOnlyGoesToThisMercury() {
    val c = MercuryClient("http://127.0.0.1:6174", "tok")
    assertEquals("http://127.0.0.1:6174/api/artifacts/a1/file", c.artifactFileUrl("a1"))
    assertTrue(c.owns(c.artifactFileUrl("a1")))
    assertFalse(c.owns("https://example.com/x.png"))
    assertFalse(c.owns("http://127.0.0.1:9999/x.png"))
  }

  @Test fun whenShowsTimeTodayAndDateOtherwise() {
    val utc = ZoneOffset.UTC
    val locale = Locale.US
    val now = Instant.ofEpochSecond(1_763_200_000) // 2025-11-15 09:46 UTC
    val time = ArtifactFormat.`when`(1_763_200_000_000.0 - 3_600_000, now, utc, locale).replace(' ', ' ')
    assertEquals("8:46 AM", time)
    assertEquals("Nov 3", ArtifactFormat.`when`(1_763_200_000_000.0 - 86_400_000.0 * 12, now, utc, locale))
    assertEquals("Nov 14, 2023", ArtifactFormat.`when`(1_700_000_000_000.0, now, utc, locale))
    assertEquals("", ArtifactFormat.`when`(null, now, utc, locale))
    assertEquals("2 images", ArtifactFormat.batchLabel(listOf(item("a"), item("b"))))
  }

  @Test fun batchLabelsByKind() {
    assertEquals("1 video", ArtifactFormat.batchLabel(listOf(item("a", kind = "video"))))
    assertEquals("3 sounds", ArtifactFormat.batchLabel(listOf(item("a", kind = "audio"), item("b", kind = "audio"), item("c", kind = "audio"))))
    assertEquals("2 files", ArtifactFormat.batchLabel(listOf(item("a"), item("b", kind = "pdf"))))
  }

  @Test fun yearDropsOutOfTheLocalPattern() {
    assertEquals("MMM d", ArtifactFormat.withoutYear("MMM d, y"))
    assertEquals("d MMM", ArtifactFormat.withoutYear("d MMM y"))
    assertEquals("dd.MM", ArtifactFormat.withoutYear("dd.MM.y"))
    assertEquals("MM/dd", ArtifactFormat.withoutYear("y/MM/dd"))
    assertEquals("d 'de' MMM", ArtifactFormat.withoutYear("d 'de' MMM 'de' y"))
  }
}
