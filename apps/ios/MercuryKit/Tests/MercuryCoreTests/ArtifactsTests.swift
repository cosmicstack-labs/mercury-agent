import Testing
import Foundation
@testable import MercuryCore

private func item(_ id: String, kind: String = "image", batch: String? = nil, size: Int = 1000, owned: Bool? = true) -> ArtifactItem {
  ArtifactItem(id: id, threadTitle: nil, name: "\(id).png", kind: kind, size: size, batch: batch, owned: owned, originalExists: true)
}

@Test func batchesBecomeOneCardAtTheirNewestMember() {
  // Newest first, as GET /api/artifacts lists them; a single sits between two batch members.
  let groups = ArtifactGroup.group([item("a", batch: "b1"), item("x"), item("b", batch: "b1"), item("c", batch: "b2"), item("y")])
  #expect(groups.map(\.id) == ["batch:b1", "x", "c", "y"])
  #expect(groups[0].ids == ["a", "b"])
  #expect(groups[0].isBatch)
  #expect(!groups[2].isBatch) // a batch of one is just a card
  #expect(groups[0].size == 2000)
}

@Test func emptyBatchIdIsNoBatch() {
  #expect(ArtifactGroup.group([item("a", batch: ""), item("b", batch: "")]).count == 2)
}

@Test func formatsBytesLikeDesktop() {
  #expect(ArtifactFormat.bytes(0) == "0 B")
  #expect(ArtifactFormat.bytes(512) == "512 B")
  #expect(ArtifactFormat.bytes(38 * 1024) == "38 KB")
  #expect(ArtifactFormat.bytes(Int(4.2 * 1024 * 1024)) == "4.2 MB")
  #expect(ArtifactFormat.bytes(Int(1.25 * 1024 * 1024 * 1024)) == "1.25 GB")
}

@Test func freedTextSaysWhatHappened() {
  #expect(ArtifactRemoved(removed: 3, freed: Int(4.4 * 1024 * 1024), keptOriginals: 0).summary == "3 deleted, 4.4 MB freed.")
  #expect(ArtifactRemoved(removed: 1, freed: 0, keptOriginals: 1).summary == "1 deleted. 1 file in your projects stayed where they are.")
  #expect(ArtifactRemoved(removed: 5, freed: 2048, keptOriginals: 2).summary == "5 deleted, 2 KB freed. 2 files in your projects stayed where they are.")
}

@Test func deleteWordingKeepsProjectFiles() {
  let own = item("a"), project = item("p", owned: false)
  #expect(ArtifactFormat.deleteTitle(own) == "Delete this file?")
  #expect(ArtifactFormat.deleteTitle(project) == "Remove from Mercury? (your file stays)")
  #expect(ArtifactFormat.deleteDetail(project) == "Removes it from Mercury. The file in your project stays.")
  #expect(ArtifactFormat.deleteDetail([own, item("b")]) == "Deletes the files.")
  #expect(ArtifactFormat.deleteDetail([project, item("q", owned: false)]) == "Removes them from Mercury. The files in your projects stay.")
  #expect(ArtifactFormat.deleteDetail([own, project]).contains("1 in your projects stay"))
  #expect(ArtifactFormat.outsideNote(0) == "Deleting removes the files from your output folder too.")
  #expect(ArtifactFormat.outsideNote(2) == "2 artifacts are files in your projects: deleting removes them from Mercury, the files stay.")
}

@Test func usageKindsBiggestFirstWithShares() {
  let u = ArtifactUsage(count: 4, bytes: 400, byKind: [
    "image": .init(count: 2, bytes: 100), "video": .init(count: 1, bytes: 300), "pdf": .init(count: 0, bytes: 0), "text": .init(count: 1, bytes: 0),
  ], freeable: 400, outside: 0)
  #expect(u.kinds.map(\.kind) == ["video", "image", "text"]) // empty kinds dropped
  #expect(u.kinds[0].share == 1)
  #expect(abs(u.kinds[1].share - 1.0 / 3) < 0.001)
}

@Test func cleanupScopesMatchTheServer() {
  #expect(ArtifactCleanup.kind("image").body["kind"] as? String == "image")
  #expect(ArtifactCleanup.olderThan(days: 30).body["olderThanDays"] as? Int == 30)
  #expect(ArtifactCleanup.all.body["all"] as? Bool == true)
  #expect(ArtifactCleanup.ids(["a", "b"]).body["ids"] as? [String] == ["a", "b"])
}

@Test func decodesTheListAndUsageShapes() throws {
  let list = #"{"items":[{"id":"a1","threadId":"t","name":"x.png","kind":"image","mime":"image/png","size":10,"originalPath":"/x.png","createdAt":1700000000000,"tool":"generate_image","batch":"b","prompt":"cat","threadTitle":"T","threadExists":true,"originalExists":true,"owned":true}],"nextCursor":null,"counts":{"all":1,"image":1}}"#
  let page = try JSONDecoder().decode(ArtifactPage.self, from: Data(list.utf8))
  #expect(page.items[0].batch == "b" && page.items[0].owned == true && page.items[0].prompt == "cat")
  let usage = #"{"count":1,"bytes":10,"byKind":{"image":{"count":1,"bytes":10}},"freeable":10,"outside":0}"#
  #expect(try JSONDecoder().decode(ArtifactUsage.self, from: Data(usage.utf8)).byKind["image"]?.bytes == 10)
  let removed = #"{"ok":true,"removed":2,"freed":20,"keptOriginals":0}"#
  #expect(try JSONDecoder().decode(ArtifactRemoved.self, from: Data(removed.utf8)).removed == 2)
}

@Test func tokenOnlyGoesToThisMercury() {
  let c = MercuryClient(baseURL: URL(string: "http://127.0.0.1:6174")!, token: "tok")
  #expect(c.headers(for: c.artifactFileURL("a1"))["Authorization"] == "Bearer tok")
  #expect(c.artifactFileURL("a1").absoluteString == "http://127.0.0.1:6174/api/artifacts/a1/file")
  #expect(c.headers(for: URL(string: "https://example.com/x.png")!).isEmpty)
  #expect(c.headers(for: URL(string: "http://127.0.0.1:9999/x.png")!).isEmpty)
}

@Test func whenShowsTimeTodayAndDateOtherwise() {
  var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
  let locale = Locale(identifier: "en_US")
  let now = Date(timeIntervalSince1970: 1_763_200_000) // 2025-11-15 09:46 UTC
  #expect(ArtifactFormat.when(1_763_200_000_000 - 3_600_000, now: now, calendar: cal, locale: locale).replacingOccurrences(of: "\u{202F}", with: " ") == "8:46 AM")
  #expect(ArtifactFormat.when(1_763_200_000_000 - 86_400_000 * 12, now: now, calendar: cal, locale: locale) == "Nov 3")
  #expect(ArtifactFormat.when(1_700_000_000_000, now: now, calendar: cal, locale: locale) == "Nov 14, 2023")
  #expect(ArtifactFormat.batchLabel([item("a"), item("b")]) == "2 images")
}
