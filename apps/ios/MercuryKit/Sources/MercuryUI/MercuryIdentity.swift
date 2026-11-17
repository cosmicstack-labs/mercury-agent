import SwiftUI
import MercuryCore

/// A Mercury's friendly name and logo: the connect flow's last step, the switcher (the side panel's
/// header) and its Edit sheet. Android: ui/connect/MercuryIdentity.kt.

/// The twelve logos in a grid; the chosen one ringed in ink.
struct LogoPicker: View {
  @Binding var selection: String
  var size: CGFloat = 58

  var body: some View {
    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 4), spacing: 12) {
      ForEach(ConnectionLogos.ids, id: \.self) { id in
        Button { withAnimation(.snappy(duration: 0.2)) { selection = id } } label: {
          LogoBadge(id: id, size: size)
            .padding(4)
            .overlay(Circle().stroke(Theme.ink, lineWidth: selection == id ? 2.5 : 0))
            .scaleEffect(selection == id ? 1 : 0.94)
            .frame(maxWidth: .infinity)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(LogoLook.name(id))
        .accessibilityAddTraits(selection == id ? .isSelected : [])
      }
    }
  }
}

/// The name field and the logo grid under a large preview: shared by the connect flow and Edit.
struct NameAndLogoForm: View {
  @Binding var name: String
  @Binding var logo: String
  var placeholder: String
  /// Snapshots: the renderer can't draw text fields.
  var still = false

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      VStack(spacing: 10) {
        LogoBadge(id: logo, size: 96)
        Text(name.trimmingCharacters(in: .whitespaces).isEmpty ? placeholder : name)
          .font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
      }
      .frame(maxWidth: .infinity)
      .accessibilityHidden(true)
      Field(label: "Name") {
        if still {
          Text(name.isEmpty ? placeholder : name).foregroundStyle(name.isEmpty ? Theme.ink3 : Theme.ink)
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
          TextField(placeholder, text: $name).autocorrectionDisabled().submitLabel(.done)
        }
      }
      VStack(alignment: .leading, spacing: 10) {
        Text("Logo").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink2)
        LogoPicker(selection: $logo)
      }
    }
  }
}

/// The connect flow's last step: connected, now a name and a face for it.
struct NameStep: View {
  @Bindable var model: ConnectModel
  var still = false

  var body: some View {
    ViewThatFits(in: .vertical) {
      form
      ScrollView { form }.scrollDismissesKeyboard(.interactively)
    }
  }

  var form: some View {
    VStack(alignment: .leading, spacing: 18) {
      VStack(alignment: .leading, spacing: 8) {
        Text("Name this Mercury").font(.system(size: 26, weight: .bold)).tracking(-0.4)
        Text("You're connected. Pick a name and a face so you can tell your Mercurys apart. You can change both later.")
          .font(.system(size: 15)).foregroundStyle(Theme.ink2)
      }
      .padding(.top, 8)
      NameAndLogoForm(name: $model.name, logo: $model.logo, placeholder: model.suggestedName, still: still)
      Button("Done") { model.save() }.buttonStyle(PrimaryButtonStyle()).padding(.top, 4)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 24).padding(.vertical, 12)
  }
}

/// Tapping the Mercury at the top of the side panel: every Mercury this phone knows (logo, name,
/// address), the one in use ticked; tap one to switch, Edit to rename it or pick its logo; and Add another.
struct MercurySwitcher: View {
  var store: ConnectionStore
  var current: String
  var onSwitch: (String) -> Void
  var onAdd: () -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var editing: Connection?

  var body: some View {
    NavigationStack {
      List {
        Section {
          ForEach(store.connections) { c in
            HStack(spacing: 12) {
              Button {
                dismiss()
                if c.id != current { onSwitch(c.id) }
              } label: {
                HStack(spacing: 12) {
                  LogoBadge(id: c.logoId, size: 44)
                  VStack(alignment: .leading, spacing: 2) {
                    Text(c.name).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                    Text(c.baseURL.host() ?? c.baseURL.absoluteString).font(.system(size: 13)).foregroundStyle(Theme.ink3).lineLimit(1)
                  }
                  Spacer(minLength: 4)
                  if c.id == current { Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink) }
                }
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              .accessibilityHint(c.id == current ? "In use" : "Switch to this Mercury")
              Button("Edit") { editing = c }
                .font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.ink2).buttonStyle(.borderless)
            }
            .padding(.vertical, 2)
          }
        }
        Section {
          Button { dismiss(); onAdd() } label: { Label("Add another Mercury", systemImage: "plus") }.foregroundStyle(Theme.ink)
        }
      }
      .navigationTitle("Your Mercurys")
      #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      .sheet(item: $editing) { c in EditMercury(store: store, connection: c) }
    }
  }
}

/// Rename a Mercury and pick its logo.
struct EditMercury: View {
  var store: ConnectionStore
  var connection: Connection
  @State private var name: String
  @State private var logo: String
  @Environment(\.dismiss) private var dismiss

  init(store: ConnectionStore, connection: Connection) {
    self.store = store; self.connection = connection
    _name = State(initialValue: connection.name)
    _logo = State(initialValue: connection.logoId)
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        NameAndLogoForm(name: $name, logo: $logo, placeholder: connection.name).padding(20)
      }
      .scrollDismissesKeyboard(.interactively)
      .background(Theme.bg)
      .navigationTitle("Edit Mercury")
      #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") { store.update(connection.id, name: name, logo: logo); dismiss() }.fontWeight(.semibold)
        }
      }
    }
  }
}

/// Snapshots: the logo set on one sheet, large and at the sizes the app uses them.
@MainActor
enum IdentityGallery {
  static var sheet: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("Mercury logos").font(.system(size: 22, weight: .bold)).foregroundStyle(Theme.ink)
      LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 3), spacing: 14) {
        ForEach(ConnectionLogos.ids, id: \.self) { id in
          VStack(spacing: 6) {
            LogoBadge(id: id, size: 84)
            Text(LogoLook.name(id)).font(.system(size: 12)).foregroundStyle(Theme.ink3)
          }
        }
      }
      Text("At 24, 32, 44 and 64 pt").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink2)
      ForEach([(CGFloat(24), 12), (32, 9), (44, 7), (64, 5)], id: \.0) { s, n in
        HStack(spacing: 6) { ForEach(ConnectionLogos.ids.prefix(n), id: \.self) { LogoBadge(id: $0, size: s) } }
      }
      Spacer(minLength: 0)
    }
    .padding(16).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).background(Theme.bg)
  }

  static func nameStep(store: ConnectionStore) -> some View {
    let m = ConnectModel(store: store)
    m.pending = .init(url: URL(string: "http://192.168.1.7:6175")!, token: "mdt_x", deviceId: nil)
    m.suggestedName = "Mercury on Salmans MacBook Pro"
    m.name = m.suggestedName
    m.logo = "party"
    m.step = .name
    return ZStack { Theme.bg; NameStep(model: m, still: true) }
  }

  static func switcher() -> some View {
    let rows: [Connection] = [
      Connection(id: "a", name: "Mercury on MacBook", baseURL: URL(string: "http://salmans-macbook.local:6175")!, logo: "shades"),
      Connection(id: "b", name: "Home server", baseURL: URL(string: "https://mercury.tail1234.ts.net")!, logo: "party"),
      Connection(id: "c", name: "Studio Mac mini", baseURL: URL(string: "http://studio.local:6175")!, logo: "astronaut"),
    ]
    return VStack(alignment: .leading, spacing: 0) {
      Text("Your Mercurys").font(.system(size: 17, weight: .semibold)).frame(maxWidth: .infinity).padding(.vertical, 14)
      ForEach(rows) { c in
        HStack(spacing: 12) {
          LogoBadge(id: c.logoId, size: 44)
          VStack(alignment: .leading, spacing: 2) {
            Text(c.name).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.ink)
            Text(c.baseURL.host() ?? "").font(.system(size: 13)).foregroundStyle(Theme.ink3)
          }
          Spacer()
          if c.id == "a" { Image(systemName: "checkmark").foregroundStyle(Theme.ink) }
          Text("Edit").font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.ink2)
        }
        .padding(.horizontal, 20).padding(.vertical, 10)
      }
      Label("Add another Mercury", systemImage: "plus").foregroundStyle(Theme.ink).padding(20)
      Spacer()
    }
    .background(Theme.bg)
  }

  static func edit() -> some View {
    VStack(spacing: 0) {
      Text("Edit Mercury").font(.system(size: 17, weight: .semibold)).frame(maxWidth: .infinity).padding(.vertical, 14)
      NameAndLogoForm(name: .constant("Home server"), logo: .constant("wizard"), placeholder: "Home server", still: true).padding(20)
      Spacer(minLength: 0)
    }
    .background(Theme.bg)
  }
}
