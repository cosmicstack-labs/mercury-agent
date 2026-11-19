import Testing
import Foundation
@testable import MercuryUI

/// The echo guard: Mercury's own voice can't interrupt it; the caller always can.
struct EchoGuardTests {
  let frame = Data(count: 1920) // 60 ms at 16 kHz mono PCM16

  /// Learns a quiet room (-60 dBFS) while Mercury is silent.
  func calibrated() -> EchoGuard {
    var g = EchoGuard()
    for i in 0..<30 { _ = g.frame(frame, level: -60, duration: 0.06, at: Double(i) * 0.06, mercuryAudible: false, ownerTalking: false) }
    return g
  }

  @Test func everyFrameGoesUpWhileMercuryIsQuiet() {
    var g = calibrated()
    for level: Float in [-80, -60, -45, -20] {
      let r = g.frame(frame, level: level, duration: 0.06, at: 3, mercuryAudible: false, ownerTalking: false)
      #expect(r.out == .send([frame]))
      #expect(!r.opened)
    }
  }

  @Test func echoWhileMercurySpeaksBecomesSilence() {
    var g = calibrated()
    // Residual echo: a little over the floor but under the near-voice bar.
    for i in 0..<20 {
      let r = g.frame(frame, level: -52, duration: 0.06, at: 2 + Double(i) * 0.06, mercuryAudible: true, ownerTalking: false)
      #expect(r.out == .silence(frame.count))
      #expect(!r.opened)
    }
  }

  @Test func theCallerTalkingOverMercuryOpensTheWayWithoutLosingWords() {
    var g = calibrated()
    var sent: [Data] = []
    var opened = false
    for i in 0..<6 {
      let r = g.frame(frame, level: -28, duration: 0.06, at: 2 + Double(i) * 0.06, mercuryAudible: true, ownerTalking: false)
      if case .send(let f) = r.out { sent += f }
      opened = opened || r.opened
    }
    #expect(opened)
    // The held-back frames went up when it opened, then each new one.
    #expect(sent.count >= 4)
    // Still open while the caller keeps talking.
    let next = g.frame(frame, level: -30, duration: 0.06, at: 2.5, mercuryAudible: true, ownerTalking: true)
    #expect(next.out == .send([frame]))
  }

  @Test func aShortClatterDoesNotOpen() {
    var g = calibrated()
    let a = g.frame(frame, level: -25, duration: 0.06, at: 2.0, mercuryAudible: true, ownerTalking: false)
    let b = g.frame(frame, level: -55, duration: 0.06, at: 2.06, mercuryAudible: true, ownerTalking: false)
    #expect(!a.opened && !b.opened)
    #expect(b.out == .silence(frame.count))
  }

  @Test func withoutCalibrationOnlyTheAbsoluteBarApplies() {
    var g = EchoGuard()
    let quiet = g.frame(frame, level: -50, duration: 0.06, at: 0.1, mercuryAudible: true, ownerTalking: false)
    #expect(quiet.out == .silence(frame.count))
    #expect(g.isNear(-30))
  }
}
