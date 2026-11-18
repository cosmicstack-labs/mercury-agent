import Foundation
import Testing
@testable import MercuryCore

/// The ring / ring_end / notify events src/reach/service.ts sends on /api/chat/activity (ADR-046).
struct PhoneReachTests {
  @Test func parsesARing() {
    let e = ReachEvent.parse(name: "ring", data: #"{"id":"r1","caller":"Mercury","reason":"the deploy failed","urgency":"high","at":"2026-11-18T14:00:00.000Z","expiresAt":"2026-11-18T14:00:45.000Z"}"#)
    guard case .ring(let r) = e else { Issue.record("not a ring"); return }
    #expect(r.id == "r1")
    #expect(r.reason == "the deploy failed")
    #expect(r.urgency == "high")
    #expect(r.expiresAt == ISO8601DateFormatter.withFractions.date(from: "2026-11-18T14:00:45.000Z"))
  }

  @Test func parsesRingEndAndNotify() {
    #expect(ReachEvent.parse(name: "ring_end", data: #"{"id":"r1","outcome":"answered_elsewhere"}"#) == .ringEnd(id: "r1", outcome: "answered_elsewhere"))
    let n = ReachEvent.parse(name: "notify", data: #"{"id":"n1","title":"Done","body":"Report ready","kind":"result","urgency":"normal","threadId":"t9","silent":true,"at":"x"}"#)
    #expect(n == .notify(ReachNotice(id: "n1", title: "Done", body: "Report ready", kind: "result", urgency: "normal", threadId: "t9", silent: true)))
  }

  @Test func ignoresOtherEventsAndJunk() {
    #expect(ReachEvent.parse(name: "activity", data: #"{"id":"x"}"#) == nil)
    #expect(ReachEvent.parse(name: "ring", data: "not json") == nil)
    #expect(ReachEvent.parse(name: "ring", data: #"{"reason":"no id"}"#) == nil)
  }

  @Test func settingsPatchCarriesOnlyWhatTheAppChanges() {
    var s = ReachSettings()
    s.calls = false
    s.quietHours = true
    s.quietStart = "23:30"
    let q = s.patch["quietHours"] as? [String: Any]
    #expect(s.patch["calls"] as? Bool == false)
    #expect(q?["enabled"] as? Bool == true)
    #expect(q?["start"] as? String == "23:30")
    #expect(s.patch["maxCallsPerHour"] == nil)
  }
}
