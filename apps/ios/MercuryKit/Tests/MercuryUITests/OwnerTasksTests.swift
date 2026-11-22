import Foundation
import Testing
import MercuryCore
@testable import MercuryUI

/// The phone's list of owner tasks (ADR-048): what shows, what goes, when the sheet comes up.
@MainActor
struct OwnerTasksTests {
  static let t0 = Date(timeIntervalSince1970: 1_763_800_000)

  func make() -> OwnerTasksModel {
    let m = OwnerTasksModel()
    m.now = { Self.t0 }
    return m
  }

  func task(_ id: String, minutes: Double = 5, status: String = "pending") -> OwnerTask {
    OwnerTask(id: id, code: "K7Q2M", title: "Solve this CAPTCHA", prompt: "Type the letters", expiresAt: Self.t0.addingTimeInterval(minutes * 60), status: status)
  }

  @Test func aNewTaskShowsAndBringsTheSheetUp() {
    let m = make()
    m.apply(OwnerTaskEvent(change: "new", task: task("a")))
    #expect(m.live.map(\.id) == ["a"])
    #expect(m.presented)
    #expect(!m.waitingInChat)
    m.presented = false
    #expect(m.waitingInChat)
  }

  @Test func anUpdateKeepsItsPlaceAndDoesNotReopen() {
    let m = make()
    m.upsert(task("a")); m.upsert(task("b"))
    m.presented = false
    var changed = task("a"); changed.prompt = "Again"
    m.upsert(changed)
    #expect(m.live.map(\.id) == ["a", "b"])
    #expect(m.live[0].prompt == "Again")
    #expect(!m.presented)
  }

  @Test func settledRemovesAndTheSheetGoesWithTheLast() {
    let m = make()
    m.upsert(task("a")); m.upsert(task("b"))
    m.apply(OwnerTaskEvent(change: "settled", task: task("a", status: "answered")))
    #expect(m.live.map(\.id) == ["b"])
    #expect(m.presented)
    m.apply(OwnerTaskEvent(change: "new", task: task("b", status: "expired")))
    #expect(m.items.isEmpty)
    #expect(!m.presented)
  }

  @Test func expiredOnesDrop() {
    let m = make()
    m.upsert(task("old", minutes: -1))
    #expect(m.items.isEmpty)
    #expect(!m.presented)
    m.upsert(task("soon", minutes: 1))
    #expect(m.live.count == 1)
    m.now = { Self.t0.addingTimeInterval(61) }
    #expect(m.live.isEmpty)
    m.prune()
    #expect(m.items.isEmpty)
  }

  @Test func replaceOpensOnlyForSomethingNew() {
    let m = make()
    m.replace([task("a")])
    #expect(m.presented)
    m.presented = false
    m.replace([task("a")])
    #expect(!m.presented)
    m.replace([task("a"), task("b"), task("c", status: "declined")])
    #expect(m.presented)
    #expect(m.items.map(\.id) == ["a", "b"])
  }

  @Test func minutesLeftIsNeverBelowOne() {
    #expect(OwnerTasksModel.minutesLeft(task("a", minutes: 5), now: Self.t0) == 5)
    #expect(OwnerTasksModel.minutesLeft(task("a", minutes: 0.2), now: Self.t0) == 1)
  }

  @Test func recognisesMercurysTaskNotification() {
    #expect(OwnerTasksModel.isTaskNotice(title: "Mercury needs you: Solve this CAPTCHA", body: "Type the letters\nCode K7Q2M"))
    #expect(!OwnerTasksModel.isTaskNotice(title: "Mercury needs you", body: "Research: waiting for your answer"))
    #expect(!OwnerTasksModel.isTaskNotice(title: "Done", body: "Code K7Q2M"))
  }
}
