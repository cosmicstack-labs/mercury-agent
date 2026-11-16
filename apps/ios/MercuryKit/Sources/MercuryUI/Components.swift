import SwiftUI

/// The filled accent button used for each screen's main action.
struct PrimaryButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) var enabled
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 16, weight: .semibold))
      .frame(maxWidth: .infinity, minHeight: 52)
      .foregroundStyle(Theme.onAccent)
      .background(Theme.accent.opacity(enabled ? 1 : 0.4), in: RoundedRectangle(cornerRadius: 14))
      .opacity(configuration.isPressed ? 0.85 : 1)
  }
}

/// A labelled input on a surface card.
struct Field<Input: View>: View {
  var label: String
  @ViewBuilder var input: Input
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(label).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink2)
      input
        .font(.system(size: 16))
        .foregroundStyle(Theme.ink)
        .padding(.horizontal, 14)
        .frame(minHeight: 48)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
    }
  }
}

/// The rounded square that holds the Mercury mark.
struct MarkTile: View {
  var size: CGFloat = 84
  var body: some View {
    MercuryMark()
      .padding(size * 0.2)
      .frame(width: size, height: size)
      .background(Theme.surface, in: RoundedRectangle(cornerRadius: size * 0.26))
      .overlay(RoundedRectangle(cornerRadius: size * 0.26).stroke(Theme.line))
  }
}

struct ErrorText: View {
  var text: String
  var body: some View {
    Label(text, systemImage: "exclamationmark.circle")
      .font(.system(size: 14))
      .foregroundStyle(Theme.red)
      .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// A quieter, full-width button on a soft surface (red text for a destructive choice).
struct SecondaryButtonStyle: ButtonStyle {
  var danger = false
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 15, weight: .medium))
      .frame(maxWidth: .infinity, minHeight: 46)
      .foregroundStyle(danger ? Theme.red : Theme.ink)
      .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 12))
      .opacity(configuration.isPressed ? 0.8 : 1)
  }
}
