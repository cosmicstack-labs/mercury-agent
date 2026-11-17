import Testing
import Foundation
import AVFoundation
@testable import MercuryUI

/// Feeds a gate 60 ms frames at given levels, on a fake clock.
struct GateRun {
  var gate = BargeInGate()
  var t: TimeInterval = 100
  let frame = 0.06

  /// Returns true if a held barge-in became due during these frames.
  @discardableResult
  mutating func feed(_ level: Float, for seconds: TimeInterval, ownerTalking: Bool = false, mercury: Bool = false) -> Bool {
    var due = false
    for _ in 0..<Int((seconds / frame).rounded()) {
      t += frame
      if gate.observe(level: level, at: t, duration: frame, ownerTalking: ownerTalking, mercuryAudible: mercury) { due = true }
    }
    return due
  }
}

struct BargeInGateTests {
  @Test func levelsOfFrames() {
    let silence = Data(count: 1920)
    #expect(BargeInGate.level(pcm16: silence) == -100)
    var loud = Data()
    for i in 0..<960 { let s: Int16 = i % 2 == 0 ? 16384 : -16384; withUnsafeBytes(of: s.littleEndian) { loud.append(contentsOf: $0) } }
    #expect(abs(BargeInGate.level(pcm16: loud) - (-6.02)) < 0.1)
  }

  @Test func unsureMeansTheBargeInHappens() {
    var r = GateRun()
    // Nothing heard yet, then too little to calibrate.
    #expect(r.gate.admits(at: r.t))
    r.feed(-60, for: 0.6)
    #expect(r.gate.admits(at: r.t))
    // Calibrated, but the microphone went silent for a while (no evidence).
    r.feed(-60, for: 1.2)
    #expect(!r.gate.admits(at: r.t))
    #expect(r.gate.admits(at: r.t + 1))
  }

  @Test func theNearOwnerCutsInAndBackgroundTalkDoesnt() {
    var r = GateRun()
    r.feed(-60, for: 2)                       // a quiet room
    r.feed(-25, for: 1.5, ownerTalking: true) // the owner talks: their level is learned
    r.feed(-60, for: 1)
    #expect(r.gate.owner != nil)
    // Mercury speaks; someone across the room talks (15 dB over the floor, 20 dB under the owner).
    r.feed(-45, for: 0.3, mercury: true)
    #expect(!r.gate.admits(at: r.t))
    // The owner talks over Mercury.
    r.feed(-27, for: 0.3, mercury: true)
    #expect(r.gate.admits(at: r.t))
  }

  @Test func withoutTheOwnersLevelTheFloorDecides() {
    var r = GateRun()
    r.feed(-60, for: 2)
    r.feed(-58, for: 0.3, mercury: true)       // a murmur: not over the floor
    #expect(!r.gate.admits(at: r.t))
    r.feed(-40, for: 0.3, mercury: true)       // clear speech near the phone
    #expect(r.gate.admits(at: r.t))
  }

  @Test func aHeldBargeInHappensWhenTheNearVoiceShowsUp() {
    var r = GateRun()
    r.feed(-60, for: 2)
    r.feed(-58, for: 0.3, mercury: true)
    #expect(!r.gate.admits(at: r.t))
    r.gate.hold(at: r.t)
    do { let due = r.feed(-58, for: 0.3, mercury: true); #expect(!due) }
    do { let due = r.feed(-30, for: 0.3, mercury: true); #expect(due) }
    #expect(r.gate.heldUntil == nil)
  }

  @Test func aHeldBargeInLapses() {
    var r = GateRun()
    r.feed(-60, for: 2)
    r.gate.hold(at: r.t)
    do { let due = r.feed(-58, for: 2, mercury: true); #expect(!due) }
    #expect(r.gate.heldUntil == nil)
    // …and ends when Mercury goes quiet.
    r.gate.hold(at: r.t)
    do { let due = r.feed(-30, for: 0.12, mercury: false); #expect(!due) }
    #expect(r.gate.heldUntil == nil)
  }

  @Test func theFloorFollowsTheRoom() {
    var r = GateRun()
    r.feed(-60, for: 2)
    #expect(abs(r.gate.floor! - -60) < 0.5)
    // A noisy café: the floor rises slowly…
    r.feed(-40, for: 1)
    #expect(r.gate.floor! < -50)
    r.feed(-40, for: 20)
    #expect(r.gate.floor! > -41)
    // …and falls fast when it's quiet again.
    r.feed(-60, for: 0.6)
    #expect(r.gate.floor! < -58)
  }

  @Test func echoWhileMercurySpeaksIsntLearnedAsTheOwner() {
    var r = GateRun()
    r.feed(-60, for: 2)
    r.feed(-30, for: 2, ownerTalking: true, mercury: true)
    #expect(r.gate.owner == nil)
  }
}

@MainActor
struct BargeInBrainTests {
  final class Judge: BargeInJudge {
    var admit = true
    var holds = 0, releases = 0
    var talking: [Bool] = []
    func admits() -> Bool { admit }
    func hold() { holds += 1 }
    func release() { releases += 1 }
    func setOwnerTalking(_ on: Bool) { talking.append(on) }
  }

  @Test func backgroundSpeechDoesntStopMercury() {
    let s = CallSetup()
    let j = Judge(); j.admit = false
    s.brain.bargeIn = j
    s.playback.isPlaying = true
    s.brain.playbackChanged(true)
    s.brain.handle(.speechStarted)
    #expect(s.playback.flushes == 0 && s.link.interrupts == 0)
    #expect(j.holds == 1)
    #expect(j.talking == [true])
    // The near voice shows up: Mercury stops then.
    s.brain.bargeInDue()
    #expect(s.playback.flushes == 1 && s.link.interrupts == 1)
    #expect(s.haptics.last == .bargeIn)
  }

  @Test func theOwnerStopsMercuryAtOnce() {
    let s = CallSetup()
    let j = Judge()
    s.brain.bargeIn = j
    s.playback.isPlaying = true
    s.brain.playbackChanged(true)
    s.brain.handle(.speechStarted)
    #expect(s.playback.flushes == 1 && s.link.interrupts == 1 && j.holds == 0)
  }

  @Test func whenMercuryIsQuietNothingIsJudged() {
    let s = CallSetup()
    let j = Judge(); j.admit = false
    s.brain.bargeIn = j
    // Mercury is preparing a reply but not audible: the owner's speech cuts it, unjudged.
    s.brain.handle(.responseStarted)
    s.brain.handle(.speechStarted)
    #expect(s.link.interrupts == 1 && j.holds == 0)
  }

  @Test func aLateBargeInAfterMercuryWentQuietDoesNothing() {
    let s = CallSetup()
    let j = Judge(); j.admit = false
    s.brain.bargeIn = j
    s.playback.isPlaying = true
    s.brain.playbackChanged(true)
    s.brain.handle(.speechStarted)
    s.playback.isPlaying = false
    s.brain.playbackChanged(false)
    #expect(j.releases >= 1)
    s.brain.bargeInDue()
    #expect(s.link.interrupts == 0)
  }

  @Test func onlyOpenAIIsJudgedOnThePhone() {
    #expect(CallBargeIn.judges(engine: "openai"))
    #expect(!CallBargeIn.judges(engine: "gemini"))
    let off = CallBargeIn(enabled: false)
    #expect(off.admits())
  }
}

struct VoiceIsolationTests {
  @Test func suggestedOnceQuietlyAndCheckedWhenOn() {
    typealias V = VoiceIsolation
    #expect(V.hint(live: false, active: .standard, preferred: .standard, dismissed: false, never: false) == .hidden)
    #expect(V.hint(live: true, active: nil, preferred: nil, dismissed: false, never: false) == .hidden)
    #expect(V.hint(live: true, active: .standard, preferred: .standard, dismissed: false, never: false) == .suggest)
    #expect(V.hint(live: true, active: .wideSpectrum, preferred: .wideSpectrum, dismissed: false, never: false) == .suggest)
    #expect(V.hint(live: true, active: .standard, preferred: .standard, dismissed: true, never: false) == .hidden)
    #expect(V.hint(live: true, active: .standard, preferred: .standard, dismissed: false, never: true) == .hidden)
    // The owner chose it but this route can't do it: no nagging.
    #expect(V.hint(live: true, active: .standard, preferred: .voiceIsolation, dismissed: false, never: false) == .hidden)
    #expect(V.hint(live: true, active: .voiceIsolation, preferred: .voiceIsolation, dismissed: false, never: true) == .on)
  }
}
