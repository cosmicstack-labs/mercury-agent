import AVFoundation

/// The voice engine's audio: 16 kHz mono PCM16, little-endian, both ways.
enum PCM {
  static let rate: Double = 16_000
  /// 60 ms at 16 kHz: the frame the voice links use.
  static let frame = 960

  /// The engine's wire format, and the player's (float, so the mixer takes it as is).
  static let wireFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true)!
  static let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!

  /// Float samples (-1…1, clipped) to PCM16 LE bytes.
  static func data(fromFloats samples: UnsafeBufferPointer<Float>) -> Data {
    var out = Data(count: samples.count * 2)
    out.withUnsafeMutableBytes { raw in
      let dst = raw.bindMemory(to: Int16.self)
      for i in samples.indices {
        let v = max(-1, min(1, samples[i]))
        dst[i] = Int16(v < 0 ? v * 32768 : v * 32767).littleEndian
      }
    }
    return out
  }

  static func data(fromSamples samples: [Int16]) -> Data {
    samples.withUnsafeBufferPointer { b in
      var d = Data(capacity: b.count * 2)
      for s in b { withUnsafeBytes(of: s.littleEndian) { d.append(contentsOf: $0) } }
      return d
    }
  }

  /// PCM16 LE bytes to float samples (an odd trailing byte is ignored).
  static func floats(fromData data: Data) -> [Float] {
    let n = data.count / 2
    var out = [Float](repeating: 0, count: n)
    data.withUnsafeBytes { raw in
      for i in 0..<n {
        let lo = UInt16(raw[2 * i]), hi = UInt16(raw[2 * i + 1])
        out[i] = Float(Int16(bitPattern: lo | hi << 8)) / 32768
      }
    }
    return out
  }

  /// A player buffer for engine audio, or nil when there's nothing to play.
  static func playBuffer(_ data: Data) -> AVAudioPCMBuffer? {
    let samples = floats(fromData: data)
    guard !samples.isEmpty, let buf = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(samples.count)) else { return nil }
    buf.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { src in buf.floatChannelData![0].update(from: src.baseAddress!, count: samples.count) }
    return buf
  }

  /// The loudest sample, 0…1.
  static func peak(_ samples: UnsafeBufferPointer<Float>) -> Float {
    var p: Float = 0
    for s in samples { p = max(p, abs(s)) }
    return min(p, 1)
  }

  static func peak(_ samples: [Int16]) -> Float {
    var p: Int32 = 0
    for s in samples { p = max(p, abs(Int32(s))) }
    return min(Float(p) / 32768, 1)
  }

  /// A peak as the orb shows it: speech peaks sit around 0.1–0.5, so it's lifted and capped.
  static func display(_ peak: Float) -> Float { min(1, sqrt(max(0, peak)) * 1.25) }
}

/// Collects microphone samples and hands them on in whole 60 ms frames.
struct PCMFramer {
  let frame: Int
  private(set) var pending: [Int16] = []

  init(frame: Int = PCM.frame) { self.frame = frame }

  /// The whole frames now ready, as PCM16 LE; the remainder waits for more.
  mutating func append(_ samples: UnsafeBufferPointer<Int16>) -> [Data] {
    pending.append(contentsOf: samples)
    guard pending.count >= frame else { return [] }
    var out: [Data] = []
    var start = 0
    while pending.count - start >= frame {
      out.append(PCM.data(fromSamples: Array(pending[start..<start + frame])))
      start += frame
    }
    pending.removeFirst(start)
    return out
  }

  mutating func append(_ samples: [Int16]) -> [Data] {
    samples.withUnsafeBufferPointer { append($0) }
  }

  mutating func reset() { pending.removeAll(keepingCapacity: true) }
}

/// Turns microphone buffers (any rate, float) into 16 kHz mono PCM16 samples.
/// AVAudioConverter keeps its filter state between buffers, so the stream has no seams.
final class MicResampler {
  let input: AVAudioFormat
  private let converter: AVAudioConverter

  init?(input: AVAudioFormat) {
    guard let c = AVAudioConverter(from: input, to: PCM.wireFormat) else { return nil }
    self.input = input
    converter = c
  }

  /// One buffer in, the 16 kHz samples it makes out (may be a few short while the filter fills).
  func convert(_ buf: AVAudioPCMBuffer) -> [Int16] {
    let capacity = AVAudioFrameCount(Double(buf.frameLength) * PCM.rate / buf.format.sampleRate) + 64
    guard let out = AVAudioPCMBuffer(pcmFormat: PCM.wireFormat, frameCapacity: capacity) else { return [] }
    var given = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if given { status.pointee = .noDataNow; return nil }
      given = true
      status.pointee = .haveData
      return buf
    }
    guard error == nil, let ch = out.int16ChannelData?[0], out.frameLength > 0 else { return [] }
    return Array(UnsafeBufferPointer(start: ch, count: Int(out.frameLength)))
  }
}
