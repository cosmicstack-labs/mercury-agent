import SwiftUI
#if os(iOS)
import AVFoundation
import UIKit
#endif

/// Whether the scanner may use the camera. Asked the first time "Scan to connect" opens
/// (NSCameraUsageDescription in project.yml says why).
enum CameraAccess: Equatable {
  case unknown, allowed, denied, noCamera

  @MainActor static func check() async -> CameraAccess {
    #if os(iOS)
    guard AVCaptureDevice.default(for: .video) != nil else { return .noCamera }
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: return .allowed
    case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video) ? .allowed : .denied
    default: return .denied
    }
    #else
    return .noCamera
    #endif
  }
}

#if os(iOS)
/// The camera, full-bleed, reading QR codes with AVFoundation (no other library). `running` false
/// stops the camera (while the confirm sheet is up); every code it sees goes to `onCode`.
struct QRCameraView: UIViewRepresentable {
  var running: Bool
  var onCode: (String) -> Void

  func makeUIView(context: Context) -> CameraPreview {
    let v = CameraPreview()
    v.reader.onCode = onCode
    v.configure()
    return v
  }

  func updateUIView(_ v: CameraPreview, context: Context) {
    v.reader.onCode = onCode
    v.setRunning(running)
  }

  static func dismantleUIView(_ v: CameraPreview, coordinator: ()) { v.setRunning(false) }

  final class CameraPreview: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    nonisolated(unsafe) let session = AVCaptureSession()
    let reader = Reader()
    private let queue = DispatchQueue(label: "sh.mercuryagent.qr-camera")
    private var configured = false
    private var running = false

    func configure() {
      preview.session = session
      preview.videoGravity = .resizeAspectFill
      guard let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera) else { return }
      session.beginConfiguration()
      if session.canAddInput(input) { session.addInput(input) }
      let output = AVCaptureMetadataOutput()
      if session.canAddOutput(output) {
        session.addOutput(output)
        output.setMetadataObjectsDelegate(reader, queue: .main)
        if output.availableMetadataObjectTypes.contains(.qr) { output.metadataObjectTypes = [.qr] }
      }
      session.commitConfiguration()
      configured = true
    }

    func setRunning(_ on: Bool) {
      guard configured, on != running else { return }
      running = on
      let session = session
      // startRunning blocks while the camera spins up: never on the main thread.
      queue.async { on ? session.startRunning() : session.stopRunning() }
    }
  }

  /// Gets the camera's QR codes (on the main queue) and hands their text on.
  final class Reader: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    var onCode: ((String) -> Void)?

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
      for case let o as AVMetadataMachineReadableCodeObject in objects where o.type == .qr {
        guard let text = o.stringValue else { continue }
        MainActor.assumeIsolated { onCode?(text) }
        return
      }
    }
  }
}
#endif

/// The viewfinder: the live camera in a rounded frame, or why there isn't one.
struct QRViewfinder: View {
  var running: Bool
  var problem: String?
  var onCode: (String) -> Void
  var onTypeCode: () -> Void
  @State private var access = CameraAccess.unknown
  @State private var last: String?
  @State private var lastAt = Date.distantPast

  var body: some View {
    ZStack {
      Color.black
      switch access {
      case .unknown:
        ProgressView().tint(.white)
      case .allowed:
        #if os(iOS)
        QRCameraView(running: running) { text in
          // The camera sees a code many times a second: it counts again only once it has been out
          // of sight for 3 s.
          let stillInView = text == last && Date().timeIntervalSince(lastAt) < 3
          last = text; lastAt = .now
          if !stillInView { onCode(text) }
        }
        #endif
        frameMarks
      case .denied:
        unavailable(icon: "video.slash", title: "Mercury can't use the camera",
                    detail: "Allow it in Settings, or enter the code instead.", settings: true)
      case .noCamera:
        unavailable(icon: "video.slash", title: "No camera here", detail: "Enter the code instead.", settings: false)
      }
    }
    .aspectRatio(1, contentMode: .fit)
    .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
    .overlay(alignment: .bottom) {
      if access == .allowed {
        Text(problem ?? "Looking for a code…")
          .font(.system(size: 14, weight: .medium)).foregroundStyle(problem == nil ? Theme.ink : Theme.red)
          .multilineTextAlignment(.center)
          .padding(.horizontal, 16).padding(.vertical, 10)
          .glassSurface(in: Capsule())
          .padding(14)
          .animation(.snappy(duration: 0.2), value: problem)
      }
    }
    .task { access = await CameraAccess.check() }
    // Back from the confirm sheet: a code still in front of the camera doesn't ask again at once.
    .onChange(of: running) { _, on in if on { lastAt = .now } }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Camera viewfinder")
  }

  private var frameMarks: some View {
    RoundedRectangle(cornerRadius: 22, style: .continuous)
      .strokeBorder(.white.opacity(0.55), lineWidth: 2)
      .padding(48)
      .allowsHitTesting(false)
  }

  private func unavailable(icon: String, title: String, detail: String, settings: Bool) -> some View {
    VStack(spacing: 12) {
      Image(systemName: icon).font(.system(size: 30)).foregroundStyle(.white.opacity(0.8))
      Text(title).font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
      Text(detail).font(.system(size: 14)).foregroundStyle(.white.opacity(0.7)).multilineTextAlignment(.center)
      #if os(iOS)
      if settings, let url = URL(string: UIApplication.openSettingsURLString) {
        Link("Open Settings", destination: url)
          .font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
          .padding(.horizontal, 18).frame(minHeight: 40)
          .background(.white.opacity(0.16), in: Capsule())
      }
      #endif
      Button("Enter a code or token", action: onTypeCode)
        .font(.system(size: 15, weight: .medium)).foregroundStyle(.white.opacity(0.85)).frame(minHeight: 40)
    }
    .padding(28)
  }
}
