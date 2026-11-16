import SwiftUI

/// Settings → Appearance: the tint and light or dark, for this phone only (Mercury Desktop has
/// its own, in Settings → General). Applied the moment they change.
struct AppearanceSettings: View {
  @State private var look = Appearance.shared

  var body: some View {
    Form {
      Section {
        AppearancePreview().listRowInsets(EdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 12))
      }
      Section {
        TintSwatches(look: look).listRowInsets(EdgeInsets(top: 14, leading: 12, bottom: 14, trailing: 12))
        ColorPicker(selection: Binding(get: { look.accent(dark: false) }, set: { look.setTint(Tint.hex($0)) }), supportsOpacity: false) {
          Label("Custom colour", systemImage: "eyedropper")
        }
      } header: { Text("Tint") } footer: {
        Text("Buttons, links, switches, ticks and the call orb use it. A colour too light or too dark to read is adjusted, and text on it turns white or dark to stay readable.")
      }
      Section("Theme") {
        ThemeModePicker(look: look).listRowInsets(EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12))
      }
      Section {
        Button("Reset to default") {
          withAnimation(.snappy) { look.setTint(nil); look.mode = .system }
        }
        .disabled(look.tintHex == nil && look.mode == .system)
      } footer: { Text("Kept on this phone only.") }
    }
    .navigationTitle("Appearance")
  }
}

/// The preset tints, Mercury's green first; the chosen one ringed and ticked.
struct TintSwatches: View {
  var look: Appearance
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 6), spacing: 14) {
      ForEach(Tint.presets) { p in
        let on = look.preset?.id == p.id
        let shade = scheme == .dark ? p.dark : p.light
        Button { withAnimation(.snappy) { look.setTint(p.id == Tint.mercury.id ? nil : p.hex) } } label: {
          ZStack {
            Circle().fill(Color(hex: shade)).frame(width: 34, height: 34)
            if on {
              Image(systemName: "checkmark").font(.system(size: 13, weight: .bold)).foregroundStyle(Color(hex: Tint.on(shade)))
            }
          }
          .frame(width: 44, height: 44)
          .overlay(Circle().stroke(Color(hex: shade), lineWidth: 2).opacity(on ? 1 : 0))
          .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(p.name)
        .accessibilityAddTraits(on ? .isSelected : [])
      }
      if look.preset == nil {
        // A custom colour: shown in the row so the choice is visible.
        let shade = scheme == .dark ? look.pair.dark : look.pair.light
        ZStack {
          Circle().fill(Color(hex: shade)).frame(width: 34, height: 34)
          Image(systemName: "checkmark").font(.system(size: 13, weight: .bold)).foregroundStyle(Color(hex: Tint.on(shade)))
        }
        .frame(width: 44, height: 44)
        .overlay(Circle().stroke(Color(hex: shade), lineWidth: 2))
        .accessibilityElement().accessibilityLabel("Custom colour").accessibilityAddTraits(.isSelected)
      }
    }
  }
}

/// System, Light, Dark as one segmented control (drawn, so the Snapshots tool can render it).
struct ThemeModePicker: View {
  var look: Appearance
  @Namespace private var ns

  var body: some View {
    HStack(spacing: 2) {
      ForEach(Appearance.Mode.allCases) { m in
        let on = look.mode == m
        Button { withAnimation(.snappy) { look.mode = m } } label: {
          Label(m.label, systemImage: m == .system ? "circle.lefthalf.filled" : m == .light ? "sun.max" : "moon")
            .font(.system(size: 14, weight: on ? .semibold : .regular))
            .foregroundStyle(on ? Theme.ink : Theme.ink3)
            .frame(maxWidth: .infinity).frame(height: 34)
            .background {
              if on { RoundedRectangle(cornerRadius: 9).fill(Theme.surface).shadow(color: .black.opacity(0.08), radius: 2, y: 1).matchedGeometryEffect(id: "on", in: ns) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
      }
    }
    .padding(3)
    .background(Theme.ink.opacity(0.06), in: RoundedRectangle(cornerRadius: 11))
  }
}

/// A little of a chat in the chosen tint: what changes when it does.
struct AppearancePreview: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Make the hero shorter").font(.system(size: 14)).foregroundStyle(Theme.ink)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.surface2, in: UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: 16, bottomTrailingRadius: 5, topTrailingRadius: 16))
        .frame(maxWidth: .infinity, alignment: .trailing)
      HStack(spacing: 6) {
        Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.accent)
        Text("Edited index.html").font(.system(size: 13)).foregroundStyle(Theme.ink2)
      }
      (Text("Done. The hero is one line now, see ").foregroundStyle(Theme.ink) + Text("the preview").foregroundStyle(Theme.accent).underline())
        .font(.system(size: 14))
      HStack(spacing: 10) {
        Text("Deploy").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.onAccent)
          .padding(.horizontal, 14).frame(height: 30).background(Theme.accent, in: Capsule())
        Text("Later").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.accent)
          .padding(.horizontal, 14).frame(height: 30).background(Theme.accent.opacity(0.12), in: Capsule())
        Spacer(minLength: 0)
        Capsule().fill(Theme.accent).frame(width: 40, height: 24)
          .overlay(alignment: .trailing) { Circle().fill(.white).padding(2).shadow(color: .black.opacity(0.15), radius: 1, y: 1) }
        Image(systemName: "arrow.up").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.onAccent)
          .frame(width: 30, height: 30).background(Theme.accent, in: Circle())
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Preview of a chat in this tint")
  }
}
