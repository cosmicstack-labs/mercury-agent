import SwiftUI
import MercuryCore

/// Screen 1: connect this phone to a Mercury running on a computer or a server.
public struct ConnectView: View {
  @State var model: ConnectModel

  public init(store: ConnectionStore) { _model = State(initialValue: ConnectModel(store: store)) }
  init(model: ConnectModel) { _model = State(initialValue: model) }

  public var body: some View {
    ZStack {
      Theme.bg.ignoresSafeArea()
      switch model.step {
      case .welcome: Welcome(model: model)
      case .signIn: SignIn(model: model)
      case .token: PasteToken(model: model)
      case .waiting(let p): Waiting(model: model, pairing: p)
      case .name: NameStep(model: model)
      }
    }
    .animation(.snappy(duration: 0.25), value: model.step)
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
      Button { model.step = .signIn } label: {
        HStack(alignment: .top, spacing: 14) {
          Image(systemName: "desktopcomputer").font(.system(size: 18)).foregroundStyle(Theme.accent)
            .frame(width: 40, height: 40).background(Theme.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 12))
          VStack(alignment: .leading, spacing: 4) {
            Text("Your own Mercury").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.ink)
            Text("On your computer or a server. Sign in, then approve this phone with a short code.")
              .font(.system(size: 14)).foregroundStyle(Theme.ink2).multilineTextAlignment(.leading)
          }
          Spacer(minLength: 0)
          Image(systemName: "chevron.right").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink3).padding(.top, 12)
        }
        .padding(18)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius).stroke(Theme.accent.opacity(0.45)))
      }
      .buttonStyle(.plain)
      Spacer()
      VStack(spacing: 12) {
        Button("Sign in to your Mercury") { model.step = .signIn }.buttonStyle(PrimaryButtonStyle())
        Button("I have a device token") { model.step = .token }
          .font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.accent).frame(minHeight: 44)
      }
    }
    .padding(.horizontal, 24).padding(.bottom, 24)
  }
}

private struct SignIn: View {
  @Bindable var model: ConnectModel
  var body: some View {
    // Scrolls only when the keyboard or a large text size makes it taller than the screen.
    ViewThatFits(in: .vertical) {
      form
      ScrollView { form }
    }
  }

  var form: some View {
      VStack(alignment: .leading, spacing: 18) {
        BackButton { model.step = .welcome }
        Text("Sign in to your Mercury").font(.system(size: 26, weight: .bold)).tracking(-0.4)
        Text("Use the address you reach Mercury at, and the username and password you set for it.")
          .font(.system(size: 15)).foregroundStyle(Theme.ink2)
        Field(label: "Address") {
          TextField("mercury.example.com", text: $model.address)
            .textContentType(.URL).autocorrectionDisabled()
            #if os(iOS)
            .keyboardType(.URL).textInputAutocapitalization(.never)
            #endif
        }
        Field(label: "Username") {
          TextField("Username", text: $model.username)
            .textContentType(.username).autocorrectionDisabled()
            #if os(iOS)
            .textInputAutocapitalization(.never)
            #endif
        }
        Field(label: "Password") {
          SecureField("Password", text: $model.password).textContentType(.password)
        }
        if let e = model.error { ErrorText(text: e) }
        Button {
          Task { await model.signIn() }
        } label: {
          HStack(spacing: 8) {
            if model.busy { ProgressView().tint(Theme.onAccent) }
            Text(model.busy ? "Connecting…" : "Connect")
          }
        }
        .buttonStyle(PrimaryButtonStyle()).disabled(!model.canSignIn).padding(.top, 6)
        Text("Your password goes only to that Mercury. This phone keeps a device token in the Keychain, never the password.")
          .font(.system(size: 13)).foregroundStyle(Theme.ink3)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 24).padding(.vertical, 12)
  }
}

private struct PasteToken: View {
  @Bindable var model: ConnectModel
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      BackButton { model.step = .welcome }
      Text("Connect with a token").font(.system(size: 26, weight: .bold)).tracking(-0.4)
      Text("Paste a device token (it starts with mdt_) made for this phone on your Mercury.")
        .font(.system(size: 15)).foregroundStyle(Theme.ink2)
      Field(label: "Address") {
        TextField("mercury.example.com", text: $model.address).autocorrectionDisabled()
          #if os(iOS)
          .keyboardType(.URL).textInputAutocapitalization(.never)
          #endif
      }
      Field(label: "Device token") {
        SecureField("mdt_…", text: $model.pastedToken)
      }
      if let e = model.error { ErrorText(text: e) }
      Button(model.busy ? "Checking…" : "Connect") { Task { await model.useToken() } }
        .buttonStyle(PrimaryButtonStyle())
        .disabled(model.address.isEmpty || !model.pastedToken.hasPrefix("mdt_") || model.busy)
      Spacer()
    }
    .padding(.horizontal, 24).padding(.vertical, 12)
  }
}

private struct Waiting: View {
  @Bindable var model: ConnectModel
  var pairing: Pairing
  var body: some View {
    VStack(spacing: 22) {
      Spacer()
      MarkTile(size: 64)
      Text("Approve this phone").font(.system(size: 26, weight: .bold)).tracking(-0.4)
      Text("Your Mercury is asking its owner to let this phone in. Approve it with this code:")
        .font(.system(size: 15)).foregroundStyle(Theme.ink2).multilineTextAlignment(.center).frame(maxWidth: 310)
      HStack(spacing: 8) {
        ForEach(Array(pairing.code.enumerated()), id: \.offset) { _, ch in
          Text(String(ch)).font(.system(size: 34, weight: .bold, design: .monospaced)).foregroundStyle(Theme.ink)
            .frame(width: 50, height: 64).background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        }
      }
      .accessibilityElement(children: .ignore).accessibilityLabel("Code \(pairing.code.map(String.init).joined(separator: " "))")
      VStack(alignment: .leading, spacing: 10) {
        Hint(icon: "message", text: "Reply \"approve \(pairing.code)\" to Mercury on Telegram or WhatsApp")
        Hint(icon: "desktopcomputer", text: "Or approve it in Mercury Desktop on that computer")
        Hint(icon: "terminal", text: "Or run /server approve \(pairing.code) there")
      }
      .padding(16).frame(maxWidth: .infinity, alignment: .leading)
      .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius))
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text("Waiting for approval").font(.system(size: 14)).foregroundStyle(Theme.ink3)
      }
      Spacer()
      Button("Cancel") { model.cancelWaiting() }
        .font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.ink2).frame(minHeight: 44)
    }
    .padding(.horizontal, 24).padding(.bottom, 16)
  }
}

private struct Hint: View {
  var icon: String
  var text: String
  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: icon).font(.system(size: 14)).foregroundStyle(Theme.accent).frame(width: 18)
      Text(text).font(.system(size: 14)).foregroundStyle(Theme.ink2)
    }
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
