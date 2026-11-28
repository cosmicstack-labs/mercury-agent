import Foundation

/// One server-sent event: its name and its raw JSON data.
public struct ServerEvent: Sendable {
  /// Not from Mercury: the stream connected again after a drop (events in between may be lost).
  public static let reconnected = "mercury.reconnected"
  public var name: String
  public var data: String
  public var id: String?
}

extension MercuryClient {
  /// Opens a server-sent event stream with the Bearer token (EventSource can't send one),
  /// and reconnects with a 1 to 15 s backoff, resuming from the last event id, until cancelled.
  public func events(_ path: String) -> AsyncStream<ServerEvent> {
    AsyncStream { continuation in
      let task = Task {
        var lastId: String?
        var delay: Double = 1
        var connected = false
        while !Task.isCancelled {
          do {
            var r = try request("GET", path, timeout: 3600)
            r.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            if let lastId { r.setValue(lastId, forHTTPHeaderField: "Last-Event-ID") }
            let (bytes, res) = try await session.bytes(for: r)
            guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw MercuryError.unreachable("stream refused") }
            delay = 1
            // Back after a drop: events sent meanwhile may be lost, so listeners re-read what they show.
            if connected { continuation.yield(ServerEvent(name: ServerEvent.reconnected, data: "{}", id: nil)) }
            connected = true
            // Mercury writes "event: <name>" then one "data: <json>" line per event, so each
            // data line is a whole event. (AsyncBytes.lines drops the blank separator lines.)
            var name = "message"
            for try await line in bytes.lines {
              if line.hasPrefix(":") { continue }
              if let v = line.field("event") { name = v }
              else if let v = line.field("id") { lastId = v }
              else if let v = line.field("data") { continuation.yield(ServerEvent(name: name, data: v, id: lastId)); name = "message" }
            }
          } catch {
            if Task.isCancelled { break }
          }
          try? await Task.sleep(for: .seconds(delay))
          delay = min(delay * 2, 15)
        }
        continuation.finish()
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }
}

extension String {
  func field(_ name: String) -> String? {
    guard hasPrefix(name + ":") else { return nil }
    let v = dropFirst(name.count + 1)
    return String(v.hasPrefix(" ") ? v.dropFirst() : v)
  }
}
