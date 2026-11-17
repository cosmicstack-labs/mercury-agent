import SwiftUI

// Liquid Glass for the chrome that floats over the chat, as Apple's own apps do on iOS 26: the
// round buttons, Ask | Code, the composer card and its buttons, the quick-action chips, jump to
// latest, and the side panel's round buttons and search. The content (messages, the list of chats)
// is never glass. Below iOS 26 (and when built with an SDK older than 26, as `swift build` with the
// command-line tools is), the same shapes are a thin material with a hairline.
//
// `#if compiler(>=6.2)` keeps the package building with Swift 6.1 / SDK 15 (no Glass type there);
// `#available` keeps the app running on iOS 17 to 18.

extension View {
  /// Glass in `shape` (interactive: it reacts to touch, for controls), or a thin material below 26.
  /// `tint` colours the glass (a prominent action); below 26 it's a solid fill instead.
  @ViewBuilder
  func glassSurface<S: InsettableShape>(in shape: S, interactive: Bool = false, tint: Color? = nil) -> some View {
    #if compiler(>=6.2)
    if #available(iOS 26.0, macOS 26.0, *) {
      glassEffect(interactive ? Glass.regular.tint(tint).interactive() : Glass.regular.tint(tint), in: shape)
    } else {
      materialSurface(in: shape, tint: tint)
    }
    #else
    materialSurface(in: shape, tint: tint)
    #endif
  }

  /// The look below iOS 26: a thin material with a hairline, or a solid tint.
  @ViewBuilder
  func materialSurface<S: InsettableShape>(in shape: S, tint: Color? = nil) -> some View {
    if let tint {
      background(tint, in: shape)
    } else {
      background(.ultraThinMaterial, in: shape).overlay(shape.strokeBorder(Theme.line))
    }
  }

  /// Gives the glass shape an identity inside a `GlassGroup`, so it morphs (iOS 26+; nothing below).
  @ViewBuilder
  func glassID<ID: Hashable & Sendable>(_ id: ID, in ns: Namespace.ID) -> some View {
    #if compiler(>=6.2)
    if #available(iOS 26.0, macOS 26.0, *) { glassEffectID(id, in: ns) } else { self }
    #else
    self
    #endif
  }

  /// A bar that floats over a scroll view at its top or bottom edge: the scroll view's content
  /// runs under it. iOS 26's `safeAreaBar` adds the soft edge effect under the bar (`edgeEffect`
  /// false hides it: the content stays sharp right up under the bar's own glass); below, a plain
  /// safe-area inset.
  @ViewBuilder
  func floatingBar<Bar: View>(_ edge: VerticalEdge, edgeEffect: Bool = true, @ViewBuilder _ bar: () -> Bar) -> some View {
    #if compiler(>=6.2)
    if #available(iOS 26.0, macOS 26.0, *) {
      safeAreaBar(edge: edge, spacing: 0, content: bar)
        .scrollEdgeEffectHidden(!edgeEffect, for: edge == .top ? .top : .bottom)
    } else {
      safeAreaInset(edge: edge, spacing: 0, content: bar)
    }
    #else
    safeAreaInset(edge: edge, spacing: 0, content: bar)
    #endif
  }
}

/// Glass shapes drawn together (they blend and morph into each other): `GlassEffectContainer` on
/// iOS 26+, the content as it is below.
struct GlassGroup<Content: View>: View {
  var spacing: CGFloat? = nil
  @ViewBuilder var content: () -> Content
  var body: some View {
    #if compiler(>=6.2)
    if #available(iOS 26.0, macOS 26.0, *) {
      GlassEffectContainer(spacing: spacing, content: content)
    } else {
      content()
    }
    #else
    content()
    #endif
  }
}

/// Whether this build draws Liquid Glass on this system (tests and the fallback's extra fade).
enum LiquidGlass {
  static var available: Bool {
    #if compiler(>=6.2)
    if #available(iOS 26.0, macOS 26.0, *) { return true }
    return false
    #else
    return false
    #endif
  }
}
