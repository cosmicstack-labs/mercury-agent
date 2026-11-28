import SwiftUI
import MercuryCore

/// Screen 1: connect this phone to a Mercury running on a computer or a server.
public struct ConnectView: View {
  @State var model: ConnectModel
  /// A `mercury://pair?…` link opened from outside the app: taken (and cleared) as it arrives.
  var link: Binding<URL?>

  public init(store: ConnectionStore, link: Binding<URL?> = .constant(nil)) {
    _model = State(initialValue: ConnectModel(store: store)); self.link = link
  }
  init(model: ConnectModel) { _model = State(initialValue: model); link = .constant(nil) }

  public var body: some View {
    ZStack {
      Theme.bg.ignoresSafeArea()
      switch model.step {
      case .welcome: Welcome(model: model)
      case .scan: Scan(model: model)
      case .enter: EnterCode(model: model)
      case .name: NameStep(model: model)
      }
    }
    .animation(.snappy(duration: 0.25), value: model.step)
    // Scanned or opened links are asked about first: never paired silently.
    .sheet(item: $model.confirm, onDismiss: { if model.pending == nil { model.error = nil } }) { l in
      ConfirmPair(model: model, link: l)
    }
    .onChange(of: link.wrappedValue, initial: true) { _, url in
      guard let url else { return }
      model.open(url)
      link.wrappedValue = nil
    }
    // Connected but the sheet swiped away at the name step: saved as it is, never a lost token.
    .onDisappear { if model.pending != nil { model.save() } }
  }
}

private struct Welcome: View {
  @Bindable var model: ConnectModel
  var body: some View {
    VStack(spacing: 28) {
      Spacer().frame(height: 40)
      VStack(spacing: 18) {
        MarkTile()
        Text("Connect to your Mercury").font(.system(size: 28, weight: .bold)).tracking(-0.5)
        Text("Mercury runs on your computer or a server. This app is how you reach it from anywhere.")
          .font(.system(size: 15)).foregroundStyle(Theme.ink2).multilineTextAlignment(.center).frame(maxWidth: 300)
      }
      HStack(alignment: .top, spacing: 14) {
        Image(systemName: "desktopcomputer").font(.system(size: 18)).foregroundStyle(Theme.accent)
          .frame(width: 40, height: 40).background(Theme.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 12))
        VStack(alignment: .leading, spacing: 4) {
          Text("Your own Mercury").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.ink)
          Text("On your computer or a server. Type /server pair there, then scan the code it shows.")
            .font(.system(size: 14)).foregroundStyle(Theme.ink2).multilineTextAlignment(.leading)
        }
        Spacer(minLength: 0)
      }
      .padding(18)
      .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius))
      Spacer()
      VStack(spacing: 6) {
        Button { model.go(.scan) } label: { Label("Scan to connect", systemImage: "qrcode.viewfinder") }
          .buttonStyle(PrimaryButtonStyle()).padding(.bottom, 6)
        Button("Enter a code or token") { model.go(.enter) }
          .font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.accent).frame(minHeight: 44)
      }
    }
    .padding(.horizontal, 24).padding(.bottom, 24)
  }
}

/// "Scan to connect": the camera reads the QR code the computer shows (`/server pair`, or Pair a
/// phone in Mercury Desktop), then the confirm sheet asks before anything is sent.
private struct Scan: View {
  @Bindable var model: ConnectModel
  @State private var problem: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      BackButton { model.go(.welcome) }
      Text("Scan to connect").font(.system(size: 26, weight: .bold)).tracking(-0.4)
      Text("On the computer Mercury runs on, type /server pair (or Pair a phone in Mercury Desktop). Point the camera at the code.")
        .font(.system(size: 15)).foregroundStyle(Theme.ink2)
      QRViewfinder(running: model.confirm == nil && model.step == .scan, problem: problem,
                   onCode: { text in problem = model.scanned(text) },
                   onTypeCode: { model.go(.enter) })
        .frame(maxWidth: .infinity)
      Spacer(minLength: 0)
      Button("Enter a code or token instead") { model.go(.enter) }.buttonStyle(SecondaryButtonStyle())
    }
    .padding(.horizontal, 24).padding(.vertical, 12)
    // A rejected code's reason fades after a few seconds; the camera keeps looking.
    .task(id: problem) {
      guard problem != nil else { return }
      try? await Task.sleep(for: .seconds(4))
      problem = nil
    }
  }
}

/// The fallback: the address, and either the pairing code printed under the QR code or a device
/// token. Which one it is is told from what's typed (a token starts with mdt_).
private struct EnterCode: View {
  @Bindable var model: ConnectModel
  var body: some View {
    ViewThatFits(in: .vertical) {
      form
      ScrollView { form }.scrollDismissesKeyboard(.interactively)
    }
  }

  var form: some View {
    VStack(alignment: .leading, spacing: 18) {
      BackButton { model.go(.welcome) }
      Text("Enter a code or token").font(.system(size: 26, weight: .bold)).tracking(-0.4)
      Text("Run /server pair on your computer for a code, or /server token for a token.")
        .font(.system(size: 15)).foregroundStyle(Theme.ink2)
      Field(label: "Address") {
        TextField("mercury.example.com", text: $model.address)
          .textContentType(.URL).autocorrectionDisabled()
          #if os(iOS)
          .keyboardType(.URL).textInputAutocapitalization(.never)
          #endif
      }
      Field(label: "Code or token") {
        TextField("XXXXX-XXXXX-… or mdt_…", text: $model.secret)
          .font(.system(size: 16, design: .monospaced)).autocorrectionDisabled().privacySensitive()
          #if os(iOS)
          .textInputAutocapitalization(.never)
          #endif
          .onSubmit { if model.canConnectTyped { Task { await model.connectTyped() } } }
      }
      if let e = model.error { ErrorText(text: e) }
      Button {
        Task { await model.connectTyped() }
      } label: {
        HStack(spacing: 8) {
          if model.busy { ProgressView().tint(Theme.onAccent) }
          Text(model.busy ? "Connecting…" : "Connect")
        }
      }
      .buttonStyle(PrimaryButtonStyle()).disabled(!model.canConnectTyped).padding(.top, 6)
      Text("A code works once, for a few minutes. This phone keeps its device token in the Keychain.")
        .font(.system(size: 13)).foregroundStyle(Theme.ink3)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 24).padding(.vertical, 12)
  }
}

/// "Connect to <host>?": asked before a scanned or opened pairing link is used.
private struct ConfirmPair: View {
  @Bindable var model: ConnectModel
  var link: PairLink

  var body: some View {
    VStack(spacing: 16) {
      MarkTile(size: 56)
      Text("Connect to \(link.host)?")
        .font(.system(size: 22, weight: .bold)).tracking(-0.3).multilineTextAlignment(.center)
      Text("Only if you just made this code on your own computer. This phone gets its own device token from that Mercury.")
        .font(.system(size: 15)).foregroundStyle(Theme.ink2).multilineTextAlignment(.center)
      if let e = model.error { ErrorText(text: e) }
      VStack(spacing: 6) {
        Button {
          Task { await model.pair(link) }
        } label: {
          HStack(spacing: 8) {
            if model.busy { ProgressView().tint(Theme.onAccent) }
            Text(model.busy ? "Connecting…" : "Connect")
          }
        }
        .buttonStyle(PrimaryButtonStyle()).disabled(model.busy)
        Button("Cancel") { model.confirm = nil }
          .font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.ink2).frame(minHeight: 44)
      }
      .padding(.top, 4)
    }
    .padding(.horizontal, 24).padding(.top, 28).padding(.bottom, 12)
    .presentationDetents([.medium])
    .interactiveDismissDisabled(model.busy)
  }
}

struct BackButton: View {
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      Image(systemName: "chevron.left").font(.system(size: 18, weight: .semibold)).foregroundStyle(Theme.ink)
        .frame(width: 44, height: 44, alignment: .leading)
    }
    .accessibilityLabel("Back")
  }
}
