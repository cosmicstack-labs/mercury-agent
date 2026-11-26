import Foundation
#if canImport(AVFoundation)
import AVFoundation
#endif

/// A short on-phone record of the last calls' audio path (Documents/call-log.txt), so a call that
/// connects but stays silent can be diagnosed: whether Mercury's audio arrived, was scheduled and
/// played, what flushed it, and where the sound was routed. No words or audio are written, only
/// counts and states. Copy it off a development phone with
/// `xcrun devicectl device copy from --domain-type appDataContainer --domain-identifier
/// sh.mercuryagent.ios --source Documents/call-log.txt --destination call-log.txt --device <id>`.
enum CallLog {
  private static let queue = DispatchQueue(label: "mercury.call-log")
  private static let limit = 256 * 1024
  private nonisolated(unsafe) static var counters: [String: Int] = [:]

  static var url: URL? {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?.appendingPathComponent("call-log.txt")
  }

  /// One line, timestamped.
  static func note(_ line: String) {
    let stamp = ISO8601DateFormatter.string(from: Date(), timeZone: .current, formatOptions: [.withTime, .withFractionalSeconds, .withColonSeparatorInTime])
    queue.async {
      guard let url else { return }
      let text = "\(stamp) \(line)\n"
      if let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? Int, size > limit {
        try? FileManager.default.removeItem(at: url)
      }
      if let h = try? FileHandle(forWritingTo: url) {
        h.seekToEndOfFile(); h.write(Data(text.utf8)); try? h.close()
      } else {
        try? Data(text.utf8).write(to: url)
      }
    }
  }

  /// Counts a frequent event (audio chunks, buffers) without a line each time; `summary` writes them.
  static func count(_ key: String, by n: Int = 1) {
    queue.async { counters[key, default: 0] += n }
  }

  /// The counts since the last summary, plus where the sound goes now.
  static func summary(_ extra: String = "") {
    let route = routeLine()
    queue.async {
      let c = counters.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")
      counters.removeAll()
      queue.async { } // keep ordering simple
      note("tick \(c.isEmpty ? "(nothing)" : c) \(extra) \(route)")
    }
  }

  /// The audio session as it is now: category, mode, outputs, volume.
  static func routeLine() -> String {
    #if os(iOS)
    let s = AVAudioSession.sharedInstance()
    let outs = s.currentRoute.outputs.map { $0.portType.rawValue }.joined(separator: ",")
    let ins = s.currentRoute.inputs.map { $0.portType.rawValue }.joined(separator: ",")
    return "[session \(s.category.rawValue)/\(s.mode.rawValue) out=\(outs) in=\(ins) vol=\(String(format: "%.2f", s.outputVolume)) other=\(s.isOtherAudioPlaying)]"
    #else
    return ""
    #endif
  }
}
