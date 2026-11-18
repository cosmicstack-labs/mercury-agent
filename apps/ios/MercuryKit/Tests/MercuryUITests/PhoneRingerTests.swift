import Foundation
import Testing
import MercuryCore
@testable import MercuryUI

/// Mercury ringing this iPhone (ADR-046), with a fake CallKit: what's reported to iOS and to Mercury.
@MainActor
final class FakePresenter: IncomingCallPresenter {
  var reported: [UUID] = []
  var ended: [(UUID, IncomingEnd)] = []
  var refuse = false
  var inCall = false
  var onIncomingAnswer: (UUID) -> Void = { _ in }
  var onIncomingDecline: (UUID) -> Void = { _ in }

  func reportIncoming(_ uuid: UUID, caller: String) async throws {
    if refuse { throw CallKitUnavailable() }
    reported.append(uuid)
  }
  func endIncoming(_ uuid: UUID, _ how: IncomingEnd) { ended.append((uuid, how)) }
}

@MainActor
struct PhoneRingerTests {
  final class Box { var outcomes: [(String, RingOutcome)] = []; var posts: [String] = [] }

  func make(_ given: FakePresenter? = nil) -> (PhoneRinger, FakePresenter, Box) {
    let fake = given ?? FakePresenter()
    let defaults = UserDefaults(suiteName: "ringer-\(UUID().uuidString)")!
    let r = PhoneRinger(presenter: fake, defaults: defaults)
    let box = Box()
    r.reportOutcome = { id, o in box.outcomes.append((id, o)) }
    r.post = { _, title, body, _, _ in box.posts.append("\(title): \(body)") }
    return (r, fake, box)
  }

  func invite(_ id: String = "r1", in seconds: Double = 45) -> RingInvite {
    RingInvite(id: id, reason: "the deploy failed", expiresAt: .now.addingTimeInterval(seconds))
  }

  func settle() async { for _ in 0..<5 { await Task.yield() } }

  @Test func aRingShowsAnIncomingCallAndAnsweringStartsTheCall() async {
    let (r, fake, box) = make()
    r.handle(.ring(invite()))
    await settle()
    #expect(fake.reported.count == 1)
    #expect(r.ringing?.invite.id == "r1")
    fake.onIncomingAnswer(fake.reported[0])
    await settle()
    #expect(r.answered?.reason == "the deploy failed")
    #expect(r.ringing == nil)
    #expect(box.outcomes.map(\.1) == [.answered])
  }

  @Test func declineIsReported() async {
    let (r, fake, box) = make()
    r.handle(.ring(invite()))
    await settle()
    fake.onIncomingDecline(fake.reported[0])
    await settle()
    #expect(box.outcomes.map(\.1) == [.declined])
    #expect(r.answered == nil)
  }

  @Test func theSameRingOnASecondStreamRingsOnce() async {
    let (r, fake, _) = make()
    r.handle(.ring(invite()))
    r.handle(.ring(invite()))
    await settle()
    #expect(fake.reported.count == 1)
  }

  @Test func answeredElsewhereStopsTheRing() async {
    let (r, fake, box) = make()
    r.handle(.ring(invite()))
    await settle()
    r.handle(.ringEnd(id: "r1", outcome: "answered_elsewhere"))
    #expect(fake.ended.map(\.1) == [.answeredElsewhere])
    #expect(r.ringing == nil)
    #expect(box.outcomes.isEmpty)
  }

  @Test func noAnswerBeforeItExpiresIsAMissedCall() async throws {
    let (r, fake, box) = make()
    r.handle(.ring(invite(in: 1.2)))
    try await Task.sleep(for: .seconds(1.6))
    await settle()
    #expect(fake.ended.map(\.1) == [.unanswered])
    #expect(box.outcomes.map(\.1) == [.missed])
    #expect(box.posts == ["Missed call from Mercury: the deploy failed"])
  }

  @Test func busyOffOrRefusedByIOSIsMissedNotShown() async {
    let fake = FakePresenter()
    fake.inCall = true
    let (r, _, box) = make(fake)
    r.handle(.ring(invite("a")))
    await settle()
    #expect(fake.reported.isEmpty)
    fake.inCall = false
    r.prefs.ring = false
    r.handle(.ring(invite("b")))
    await settle()
    r.prefs.ring = true
    fake.refuse = true
    r.handle(.ring(invite("c")))
    await settle()
    #expect(fake.reported.isEmpty)
    #expect(box.outcomes.map(\.1) == [.missed, .missed, .missed])
    #expect(r.ringing == nil)
  }

  @Test func anExpiredRingIsIgnored() async {
    let (r, fake, box) = make()
    r.handle(.ring(invite(in: -1)))
    await settle()
    #expect(fake.reported.isEmpty)
    #expect(box.outcomes.isEmpty)
  }

  @Test func notificationsAreShownOnceAndRespectTheSwitch() {
    let (r, _, box) = make()
    let n = ReachNotice(id: "n1", title: "Done", body: "Report ready")
    r.handle(.notify(n))
    r.handle(.notify(n))
    r.prefs.notify = false
    r.handle(.notify(ReachNotice(id: "n2", title: "x", body: "y")))
    #expect(box.posts == ["Done: Report ready"])
  }

  @Test func quietHoursTimesRoundTrip() {
    #expect(CallsSettings.hhmm(CallsSettings.date("07:05")) == "07:05")
    #expect(CallsSettings.hhmm(CallsSettings.date("23:30")) == "23:30")
  }
}
