import Foundation
import Testing
@testable import MercuryCore

/// The `owner_task` events and GET /api/owner/tasks items src/channels/web.ts and
/// src/web/api/owner-tasks.ts send (ADR-048).
struct OwnerTaskTests {
  static let new = #"{"change":"new","id":"abc_-123","code":"K7Q2M","title":"Solve this CAPTCHA","prompt":"Type the letters in the picture.","who":"plugin captcha","link":"https://example.com/signup","media":{"kind":"image","mimeType":"image/png","url":"/api/owner/tasks/abc_-123/media"},"answerKind":"text","expiresAt":1763820000000,"status":"pending"}"#

  @Test func parsesANewTask() throws {
    let e = try #require(OwnerTaskEvent.parse(name: "owner_task", data: Self.new))
    #expect(e.change == "new")
    #expect(e.isOpen)
    let t = e.task
    #expect(t.id == "abc_-123")
    #expect(t.code == "K7Q2M")
    #expect(t.title == "Solve this CAPTCHA")
    #expect(t.who == "plugin captcha")
    #expect(t.link == URL(string: "https://example.com/signup"))
    #expect(t.media == OwnerTask.Media(kind: .image, mimeType: "image/png", url: "/api/owner/tasks/abc_-123/media"))
    #expect(t.answerKind == .text)
    #expect(t.expiresAt == Date(timeIntervalSince1970: 1_763_820_000))
  }

  @Test func settledOrNotPendingMeansItGoes() throws {
    let settled = try #require(OwnerTaskEvent.parse(name: "owner_task", data: #"{"change":"settled","id":"a","status":"answered","expiresAt":1}"#))
    #expect(!settled.isOpen)
    let odd = try #require(OwnerTaskEvent.parse(name: "owner_task", data: #"{"change":"new","id":"a","status":"expired","expiresAt":1}"#))
    #expect(!odd.isOpen)
  }

  @Test func doneTasksAudioAndDefaults() throws {
    let e = try #require(OwnerTaskEvent.parse(name: "owner_task", data: #"{"change":"new","id":"d1","code":"ABCDE","title":"Finish sign-in","prompt":"Tap the link","who":"","answerKind":"done","media":{"kind":"audio","mimeType":"audio/mpeg"},"expiresAt":1763820000000,"status":"pending"}"#))
    #expect(e.task.answerKind == .done)
    #expect(e.task.who == "Mercury")
    #expect(e.task.media?.kind == .audio)
    #expect(e.task.media?.url == "/api/owner/tasks/d1/media")
    #expect(e.task.link == nil)
  }

  @Test func onlyWebLinksOpen() throws {
    let e = try #require(OwnerTaskEvent.parse(name: "owner_task", data: #"{"change":"new","id":"x","link":"javascript:alert(1)","expiresAt":1,"status":"pending"}"#))
    #expect(e.task.link == nil)
  }

  @Test func ignoresOtherEventsAndJunk() {
    #expect(OwnerTaskEvent.parse(name: "activity", data: Self.new) == nil)
    #expect(OwnerTaskEvent.parse(name: "owner_task", data: "nope") == nil)
    #expect(OwnerTaskEvent.parse(name: "owner_task", data: #"{"change":"new","title":"no id"}"#) == nil)
  }
}
