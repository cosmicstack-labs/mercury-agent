import SwiftUI
import MercuryCore

/// Clean up, behind the ⋯ menu in Artifacts (Mercury Desktop's Cleanup dialog): the space what
/// Mercury made takes, counted the way the disk counts it, and ways to give it back: a kind at a
/// time, everything older than a while, or all of it. Files Mercury wrote into a project are
/// never deleted from here; only its copy goes.
struct ArtifactCleanupSheet: View {
  var model: ArtifactsModel
  @Environment(\.dismiss) var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        ArtifactCleanupContent(model: model).padding(16)
      }
      .background(Theme.bg)
      .navigationTitle("Clean up")
      #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
      }
      .task { await model.refreshUsage() }
    }
    .presentationDetents([.large])
  }
}

@MainActor @Observable
final class ArtifactCleanupState {
  var age = 30
  var busy = false
  var note: String?
  var error: String?
  var confirm: ArtifactCleanup?
}

struct ArtifactCleanupContent: View {
  var model: ArtifactsModel
  @State var state = ArtifactCleanupState()

  static let ages = [7, 30, 90]

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      if let u = model.usage {
        total(u)
        kinds(u)
        older(u)
        everything(u)
      } else if let e = state.error {
        ErrorText(text: e)
      } else {
        ProgressView().frame(maxWidth: .infinity).padding(.vertical, 40)
      }
      if state.busy {
        Text("Deleting…").font(.system(size: 13)).foregroundStyle(Theme.ink3)
      }
      if let note = state.note {
        Label(note, systemImage: "checkmark.circle.fill").font(.system(size: 13)).foregroundStyle(Theme.accent)
          .accessibilityAddTraits(.updatesFrequently)
      }
      if let e = state.error, model.usage != nil { ErrorText(text: e) }
    }
    .confirmationDialog(state.confirm.map { title($0) } ?? "", isPresented: Binding(get: { state.confirm != nil }, set: { if !$0 { state.confirm = nil } }),
                        titleVisibility: .visible, presenting: state.confirm) { scope in
      Button("Delete", role: .destructive) { Task { await run(scope) } }
    } message: { _ in
      Text(ArtifactFormat.outsideNote(model.usage?.outside ?? 0) + " This can't be undone.")
    }
  }

  // MARK: Sections

  func total(_ u: ArtifactUsage) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 12) {
        Image(systemName: "internaldrive").font(.system(size: 18)).foregroundStyle(Theme.ink2)
          .frame(width: 42, height: 42).background(Theme.surface2, in: RoundedRectangle(cornerRadius: 11))
        VStack(alignment: .leading, spacing: 2) {
          Text(ArtifactFormat.bytes(u.bytes)).font(.system(size: 24, weight: .semibold)).foregroundStyle(Theme.ink)
          Text("\(u.count) artifact\(u.count == 1 ? "" : "s")" + (u.freeable < u.bytes ? " · \(ArtifactFormat.bytes(u.freeable)) can be freed" : ""))
            .font(.system(size: 13)).foregroundStyle(Theme.ink3)
        }
      }
      if u.bytes > 0 {
        GeometryReader { geo in
          HStack(spacing: 0) {
            ForEach(u.kinds, id: \.kind) { row in
              Self.color(row.kind).frame(width: geo.size.width * CGFloat(row.usage.bytes) / CGFloat(max(u.bytes, 1)))
            }
            Spacer(minLength: 0)
          }
        }
        .frame(height: 8).background(Theme.surface2).clipShape(Capsule())
        .accessibilityHidden(true)
      }
    }
    .accessibilityElement(children: .combine)
  }

  func kinds(_ u: ArtifactUsage) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionTitle(text: "By kind")
      VStack(spacing: 0) {
        if u.kinds.isEmpty {
          Text("Nothing here yet.").font(.system(size: 14)).foregroundStyle(Theme.ink3)
            .frame(maxWidth: .infinity, alignment: .leading).padding(14)
        }
        ForEach(Array(u.kinds.enumerated()), id: \.element.kind) { i, row in
          if i > 0 { Divider().overlay(Theme.line).padding(.leading, 14) }
          HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
              HStack(spacing: 8) {
                Circle().fill(Self.color(row.kind)).frame(width: 9, height: 9)
                Text(ArtifactFormat.kindLabel(row.kind)).font(.system(size: 15)).foregroundStyle(Theme.ink)
                Text("\(row.usage.count)").font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.ink4)
                Spacer(minLength: 0)
                Text(ArtifactFormat.bytes(row.usage.bytes)).font(.system(size: 14).monospacedDigit()).foregroundStyle(Theme.ink2)
              }
              GeometryReader { geo in
                Capsule().fill(Self.color(row.kind)).frame(width: max(geo.size.width * row.share, 3))
              }
              .frame(height: 4)
            }
            Button { state.confirm = .kind(row.kind) } label: {
              Image(systemName: "trash").font(.system(size: 14)).foregroundStyle(Theme.red)
                .frame(width: 36, height: 36).background(Theme.red.opacity(0.08), in: Circle())
            }
            .buttonStyle(.plain).disabled(state.busy)
            .accessibilityLabel("Delete all \(ArtifactFormat.kindLabel(row.kind).lowercased())")
          }
          .padding(.horizontal, 14).padding(.vertical, 11)
        }
      }
      .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
      .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line))
    }
  }

  func older(_ u: ArtifactUsage) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionTitle(text: "Older than")
      HStack(spacing: 8) {
        HStack(spacing: 2) {
          ForEach(Self.ages, id: \.self) { d in
            let on = state.age == d
            Button { state.age = d } label: {
              Text("\(d) days").font(.system(size: 14, weight: on ? .semibold : .regular))
                .foregroundStyle(on ? Theme.ink : Theme.ink3)
                .frame(maxWidth: .infinity, minHeight: 34)
                .background(on ? Theme.surface : .clear, in: RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(on ? .isSelected : [])
          }
        }
        .padding(2).background(Theme.surface2, in: RoundedRectangle(cornerRadius: 10))
        Button { state.confirm = .olderThan(days: state.age) } label: {
          Text("Delete older").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink)
            .padding(.horizontal, 14).frame(minHeight: 38)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line))
        }
        .buttonStyle(.plain).disabled(state.busy || u.count == 0)
      }
    }
  }

  func everything(_ u: ArtifactUsage) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(ArtifactFormat.outsideNote(u.outside)).font(.system(size: 13)).foregroundStyle(Theme.ink3)
      Button { state.confirm = .all } label: {
        Label("Delete all", systemImage: "trash").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.red)
          .frame(maxWidth: .infinity, minHeight: 46)
          .background(Theme.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
      }
      .buttonStyle(.plain).disabled(state.busy || u.count == 0)
    }
    .padding(.top, 4)
  }

  // MARK: Actions

  func title(_ scope: ArtifactCleanup) -> String {
    let u = model.usage
    switch scope {
    case .kind(let k): return "Delete \(u?.byKind[k]?.count ?? 0) \(ArtifactFormat.kindLabel(k).lowercased())?"
    case .olderThan(let d): return "Delete everything older than \(d) days?"
    case .all: return "Delete all \(u?.count ?? 0)?"
    case .ids(let ids): return "Delete \(ids.count)?"
    }
  }

  func run(_ scope: ArtifactCleanup) async {
    state.busy = true; state.note = nil; state.error = nil
    defer { state.busy = false }
    do {
      let r = try await model.client.deleteArtifacts(scope)
      state.note = r.summary
      model.note = r.summary
      await model.load()
    } catch { state.error = error.localizedDescription }
  }

  /// Desktop's kind colours.
  static func color(_ kind: String) -> Color {
    switch kind {
    case "image": Theme.cyan
    case "video": Theme.accent
    case "audio": Theme.amber
    case "pdf": Theme.red
    case "document": Theme.ink3
    default: Theme.ink4
    }
  }
}

private struct SectionTitle: View {
  var text: String
  var body: some View {
    Text(text.uppercased()).font(.system(size: 12, weight: .semibold)).tracking(0.4).foregroundStyle(Theme.ink3)
  }
}
