import SwiftUI
import MercuryCore

// The pieces the new-bot form and a bot's Edit screen share (desktop BotForms.tsx): text boxes,
// the persona builder, schedules picked in words, permission levels in plain words, the model and
// the daily budget, and a crew. Plain stacks (no Form/List), so the Snapshots tool can draw them;
// `stillForm` swaps each text box for its text there.

extension EnvironmentValues {
  /// Text boxes and pickers drawn as their text, for the Snapshots tool (it can't draw platform controls).
  var stillForm: Bool {
    get { self[StillFormKey.self] }
    set { self[StillFormKey.self] = newValue }
  }
}

private struct StillFormKey: EnvironmentKey { static let defaultValue = false }

/// A titled block of the form.
struct FormBlock<Content: View>: View {
  var title: String
  var hint: String?
  @ViewBuilder var content: Content
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
        if let hint { Text(hint).font(.system(size: 13)).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true) }
      }
      content
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// A text box on a surface: one line, or growing between `lines`.
struct BotTextBox: View {
  @Binding var text: String
  var placeholder: String
  var lines: ClosedRange<Int>? = nil
  var mono = false
  var label: String
  @Environment(\.stillForm) private var still

  var body: some View {
    Group {
      if still {
        Text(text.isEmpty ? placeholder : text)
          .foregroundStyle(text.isEmpty ? Theme.ink4 : Theme.ink)
          .lineLimit(lines.map { $0.upperBound } ?? 1)
          .frame(maxWidth: .infinity, minHeight: lines == nil ? 24 : CGFloat(lines!.lowerBound) * 20, alignment: .topLeading)
      } else if let lines {
        TextField(placeholder, text: $text, axis: .vertical).lineLimit(lines)
      } else {
        TextField(placeholder, text: $text)
      }
    }
    .font(mono ? .system(size: 14, design: .monospaced) : .system(size: 16))
    .foregroundStyle(Theme.ink)
    .padding(.horizontal, 14).padding(.vertical, 12)
    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
    .accessibilityLabel(label)
  }
}

/// A small pill button: an outline, or filled when `on`.
struct ChipButton: View {
  var title: String
  var systemImage: String?
  var on = false
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      HStack(spacing: 5) {
        if let systemImage { Image(systemName: systemImage).font(.system(size: 12, weight: .semibold)) }
        Text(title).font(.system(size: 14, weight: .medium))
      }
      .foregroundStyle(on ? Theme.onAccent : Theme.ink)
      .padding(.horizontal, 12).frame(minHeight: 34)
      .background(on ? Theme.accent : Theme.surface2, in: Capsule())
    }
    .buttonStyle(Pressable())
  }
}

// MARK: - Instructions

/// The instructions box with the persona builder under it: it turns rough notes into structured
/// instructions without adding anything you didn't say. One tap undoes it.
struct PersonaEditor: View {
  @Binding var persona: String
  var before: String?
  var busy: Bool
  var structure: () -> Void
  var undo: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      BotTextBox(text: $persona, placeholder: "You… When you finish, close with bot_report; if there's nothing new, call bot_no_update.",
                 lines: 6...14, label: "Instructions")
      HStack(spacing: 10) {
        Button(action: structure) {
          HStack(spacing: 6) {
            if busy { Spinner(size: 12) } else { Image(systemName: "sparkles").font(.system(size: 12, weight: .semibold)) }
            Text(busy ? "Structuring… (10–60 s)" : "Structure with the persona builder").font(.system(size: 14, weight: .medium))
          }
          .foregroundStyle(Theme.ink)
          .padding(.horizontal, 12).frame(minHeight: 34)
          .overlay(Capsule().stroke(Theme.line, lineWidth: 1))
        }
        .buttonStyle(Pressable())
        .disabled(busy || persona.trimmingCharacters(in: .whitespacesAndNewlines).count < 10)
        if before != nil && !busy {
          Button("Undo", action: undo).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.ink2)
        }
      }
    }
  }
}

// MARK: - Schedules

/// Its schedules: each picked in words (every N minutes or hours, daily, weekdays, weekly, or a
/// cron), with what to do each time.
struct ScheduleListEditor: View {
  @Binding var schedules: [BotSchedule]

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if schedules.isEmpty {
        Text("No schedule: it runs when you message it or tap Run now.").font(.system(size: 14)).foregroundStyle(Theme.ink3)
      }
      ForEach(schedules.indices, id: \.self) { i in
        VStack(alignment: .leading, spacing: 10) {
          HStack(alignment: .top) {
            SchedulePicker(cron: Binding(get: { schedules[i].cron }, set: { schedules[i].cron = $0 }))
            Spacer(minLength: 4)
            Button { schedules.remove(at: i) } label: {
              Image(systemName: "trash").font(.system(size: 14)).foregroundStyle(Theme.ink3).frame(width: 34, height: 34)
            }
            .buttonStyle(Pressable())
            .accessibilityLabel("Remove this schedule")
          }
          BotTextBox(text: Binding(get: { schedules[i].prompt }, set: { schedules[i].prompt = $0 }),
                     placeholder: "What to do each time, and when to report nothing", lines: 2...5, label: "What to do each time")
        }
        .padding(12)
        .background(Theme.bgSoft, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line))
      }
      Button {
        schedules.append(BotSchedule(name: BotForms.nextRoutineName(schedules), cron: "0 9 * * *", prompt: ""))
      } label: {
        Label("Add a schedule", systemImage: "plus").font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.ink)
      }
      .buttonStyle(Pressable())
    }
  }
}

/// One schedule in words. Whatever the picker can't say stays an editable cron.
struct SchedulePicker: View {
  @Binding var cron: String
  @Environment(\.stillForm) private var still

  var body: some View {
    let rule = ScheduleRule.from(cron: cron)
    VStack(alignment: .leading, spacing: 8) {
      kindMenu(rule)
      switch rule {
      case .everyMinutes(let n):
        HStack(spacing: 6) {
          ForEach(ScheduleRule.minuteSteps, id: \.self) { s in
            ChipButton(title: "\(s) min", on: s == n) { cron = ScheduleRule.everyMinutes(s).cron }
          }
        }
      case .everyHours(let n):
        HStack(spacing: 6) {
          ForEach([1, 2, 4, 6, 12], id: \.self) { s in
            ChipButton(title: s == 1 ? "1 h" : "\(s) h", on: s == n) { cron = ScheduleRule.everyHours(s).cron }
          }
        }
      case .daily, .weekdays:
        timeRow(rule)
      case .weekly(let d, _, _):
        HStack(spacing: 4) {
          ForEach(0..<7, id: \.self) { i in
            let short = String(ScheduleRule.dayNames[(i + 1) % 7].prefix(1))
            Button { cron = ScheduleRule.weekly(day: (i + 1) % 7, hour: rule.hour, minute: rule.minute).cron } label: {
              Text(short).font(.system(size: 14, weight: .semibold))
                .foregroundStyle((i + 1) % 7 == d ? Theme.onAccent : Theme.ink)
                .frame(width: 34, height: 34)
                .background((i + 1) % 7 == d ? Theme.accent : Theme.surface2, in: Circle())
            }
            .buttonStyle(Pressable())
            .accessibilityLabel(ScheduleRule.dayNames[(i + 1) % 7])
          }
        }
        timeRow(rule)
      case .custom:
        BotTextBox(text: $cron, placeholder: "0 9 * * *", mono: true, label: "Cron expression")
        Text("Minute, hour, day of month, month, weekday.").font(.system(size: 12)).foregroundStyle(Theme.ink4)
      }
      if BotForms.tooFrequent(cron) {
        Text("Mercury runs a schedule at most every 15 minutes, so this runs every 15 minutes.")
          .font(.system(size: 13)).foregroundStyle(Theme.amber)
      }
    }
  }

  @ViewBuilder
  private func kindMenu(_ rule: ScheduleRule) -> some View {
    let label = HStack(spacing: 6) {
      Text(rule.words).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
      Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.ink3)
    }
    if still {
      label
    } else {
      Menu {
        ForEach(ScheduleRule.Kind.allCases, id: \.self) { k in
          Button { cron = rule.with(kind: k).cron } label: {
            if k == rule.kind { Label(k.rawValue, systemImage: "checkmark") } else { Text(k.rawValue) }
          }
        }
      } label: { label }
      .menuIndicator(.hidden)
      .fixedSize()
      .accessibilityLabel("When: \(rule.words)")
    }
  }

  @ViewBuilder
  private func timeRow(_ rule: ScheduleRule) -> some View {
    HStack(spacing: 8) {
      Text("At").font(.system(size: 14)).foregroundStyle(Theme.ink3)
      if still {
        Text(ScheduleRule.time(rule.hour, rule.minute)).font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.ink)
          .padding(.horizontal, 10).frame(minHeight: 32).background(Theme.surface2, in: RoundedRectangle(cornerRadius: 8))
      } else {
        DatePicker("Time", selection: Binding(get: { Self.date(rule.hour, rule.minute) }, set: { d in
          let c = Calendar.current.dateComponents([.hour, .minute], from: d)
          let (h, m) = (c.hour ?? 9, c.minute ?? 0)
          switch rule {
          case .daily: cron = ScheduleRule.daily(hour: h, minute: m).cron
          case .weekdays: cron = ScheduleRule.weekdays(hour: h, minute: m).cron
          case .weekly(let day, _, _): cron = ScheduleRule.weekly(day: day, hour: h, minute: m).cron
          default: break
          }
        }), displayedComponents: .hourAndMinute)
        .labelsHidden()
      }
    }
  }

  static func date(_ h: Int, _ m: Int) -> Date {
    Calendar.current.date(bySettingHour: h, minute: m, second: 0, of: Date(timeIntervalSince1970: 1_800_000_000)) ?? Date()
  }
}

// MARK: - Permissions

/// What it may do, in plain words (desktop TierPicker). Runs commands and Full access need the
/// owner's approval when chosen from a phone.
struct TierPickerView: View {
  @Binding var value: String
  var tiers: [String]

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if value == "custom" {
        Text("This bot's permissions were edited by hand (its permissions.yaml). Picking a level below replaces them.")
          .font(.system(size: 13)).foregroundStyle(Theme.ink2)
          .padding(10).frame(maxWidth: .infinity, alignment: .leading)
          .background(Theme.amber.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
      }
      ForEach(tiers, id: \.self) { id in
        let on = value == id
        let w = BotTiers.words(id)
        Button { value = id } label: {
          HStack(alignment: .top, spacing: 12) {
            Circle().strokeBorder(on ? Theme.accent : Theme.ink4, lineWidth: on ? 5 : 1.5).frame(width: 18, height: 18).padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
              HStack(spacing: 6) {
                Text(w?.title ?? id).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
                if id == "readonly" { Text("recommended").font(.system(size: 12)).foregroundStyle(Theme.ink4) }
                if BotTiers.needsOwner(id) { Image(systemName: "lock.shield").font(.system(size: 12)).foregroundStyle(Theme.amber) }
              }
              Text(w.map { "\($0.can) \($0.cant)" } ?? id).font(.system(size: 13)).foregroundStyle(Theme.ink3)
                .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
          }
          .padding(12)
          .background(on ? Theme.surface2 : Theme.surface, in: RoundedRectangle(cornerRadius: 12))
          .overlay(RoundedRectangle(cornerRadius: 12).stroke(on ? Theme.ink3 : Theme.line))
          .contentShape(Rectangle())
        }
        .buttonStyle(Pressable())
        .accessibilityAddTraits(on ? [.isSelected] : [])
      }
      if BotTiers.needsOwner(value) {
        Label("From your phone this needs your approval on the computer first.", systemImage: "lock.shield")
          .font(.system(size: 13)).foregroundStyle(Theme.amber)
      }
    }
  }
}

// MARK: - Model and budget

struct ModelBudgetEditor: View {
  @Binding var model: BotModelRef?
  @Binding var budget: String
  var catalog: ModelCatalog?
  var budgetPlaceholder = "Fleet default"
  @Environment(\.stillForm) private var still

  var title: String {
    guard let model else { return "Mercury's default" + (catalog?.defaultChoice.map { " (\($0.title))" } ?? "") }
    let m = catalog?.models.first { $0.same(model.provider, model.model ?? "") }
    return m.map { "\($0.title) · \($0.name)" } ?? "\(model.model ?? "default") · \(model.provider)"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      let label = HStack {
        Image(systemName: "sparkles").font(.system(size: 13)).foregroundStyle(Theme.ink3)
        Text(title).font(.system(size: 15)).foregroundStyle(Theme.ink).lineLimit(1)
        Spacer(minLength: 4)
        Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.ink3)
      }
      .padding(.horizontal, 14).frame(minHeight: 48)
      .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
      .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
      if still {
        label
      } else {
        Menu {
          Button { model = nil } label: {
            if model == nil { Label("Mercury's default", systemImage: "checkmark") } else { Text("Mercury's default") }
          }
          ForEach(ModelMenu.groups((catalog?.models ?? []).filter(\.available)), id: \.self) { g in
            Section(g.title) {
              ForEach(g.models) { m in
                Button { model = BotModelRef(provider: m.name, model: m.model) } label: {
                  if model.map({ m.same($0.provider, $0.model ?? "") }) == true { Label(m.title, systemImage: "checkmark") } else { Text(m.title) }
                }
              }
            }
          }
        } label: { label }
        .menuIndicator(.hidden)
        .accessibilityLabel("Model: \(title)")
      }
      HStack(spacing: 10) {
        Text("Daily token budget").font(.system(size: 14)).foregroundStyle(Theme.ink2)
        BotTextBox(text: $budget, placeholder: budgetPlaceholder, mono: true, label: "Daily token budget")
          #if os(iOS)
          .keyboardType(.numberPad)
          #endif
      }
      Text("It pauses until tomorrow when it's spent.").font(.system(size: 12)).foregroundStyle(Theme.ink4)
    }
  }
}

// MARK: - Crew

/// A team you write (or edit after Mercury proposed it).
struct CrewEditorView: View {
  @Binding var crew: [CrewSpec]
  var max = 6

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(crew.indices, id: \.self) { i in
        VStack(alignment: .leading, spacing: 8) {
          HStack {
            BotTextBox(text: Binding(get: { crew[i].name }, set: { crew[i].name = $0 }), placeholder: "Name, e.g. Fact Checker", label: "Crew name")
            Button { crew.remove(at: i) } label: {
              Image(systemName: "trash").font(.system(size: 14)).foregroundStyle(Theme.ink3).frame(width: 34, height: 34)
            }
            .buttonStyle(Pressable())
            .accessibilityLabel("Remove crew member")
          }
          BotTextBox(text: Binding(get: { crew[i].description }, set: { crew[i].description = $0 }), placeholder: "What it does, in one line", label: "Crew description")
          BotTextBox(text: Binding(get: { crew[i].persona }, set: { crew[i].persona = $0 }), placeholder: "How it works and what it hands back to the lead.",
                     lines: 2...6, label: "Crew instructions")
        }
        .padding(12)
        .background(Theme.bgSoft, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line))
      }
      if crew.count < max {
        Button { crew.append(CrewSpec()) } label: {
          Label("Add a crew member", systemImage: "plus").font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.ink)
        }
        .buttonStyle(Pressable())
      }
    }
  }
}

/// A note in a soft box (what Mercury suggested, a fallback that happened).
struct FormNote: View {
  var icon: String
  var title: String?
  var text: String
  var tint: Color = Theme.ink2
  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: icon).font(.system(size: 15)).foregroundStyle(tint).padding(.top, 1)
      VStack(alignment: .leading, spacing: 3) {
        if let title { Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink) }
        Text(text).font(.system(size: 14)).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 14))
  }
}
