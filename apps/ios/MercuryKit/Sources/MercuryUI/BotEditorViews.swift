import SwiftUI
import PhotosUI
import MercuryCore

// MARK: - New bot

/// New bot, as a sheet: say what it should do → Mercury drafts it → you review → Create.
struct NewBotSheet: View {
  @State var form: NewBotModel
  @State var gate: OwnerGate
  var onDone: (String?) -> Void
  @Environment(\.dismiss) private var dismiss

  init(client: MercuryClient, existingIds: [String], onDone: @escaping (String?) -> Void) {
    _form = State(initialValue: NewBotModel(client: client, existingIds: existingIds))
    _gate = State(initialValue: OwnerGate(client: client))
    self.onDone = onDone
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        NewBotContent(form: form).padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 24)
      }
      .scrollDismissesKeyboard(.interactively)
      .background(Theme.bg)
      .navigationTitle("New bot")
      #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(form.createdId == nil ? "Cancel" : "Close") { onDone(form.createdId); dismiss() }
        }
        if form.step == .form, form.createdId == nil {
          ToolbarItem(placement: .navigation) {
            Button { form.step = .describe } label: { Image(systemName: "chevron.left") }.accessibilityLabel("Back")
          }
        }
      }
      .floatingBar(.bottom) {
        NewBotActions(form: form) {
          Task {
            if let id = await form.create(gate: gate), form.error == nil { onDone(id); dismiss() }
          }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
      }
    }
    .ownerGate(gate)
    .task { await form.loadChoices() }
    .interactiveDismissDisabled(form.busy != nil)
  }
}

/// The two steps' content.
struct NewBotContent: View {
  var form: NewBotModel

  var body: some View {
    switch form.step {
    case .describe: NewBotDescribe(form: form)
    case .form: NewBotForm(form: form)
    }
  }
}

/// Step one: what should it do, in your own words.
struct NewBotDescribe: View {
  @Bindable var form: NewBotModel
  static let examples = [
    "Every morning at 8, brief me on AI news: five items with links.",
    "Watch Hacker News for posts about Rust and tell me about new ones.",
    "Every Friday, draft a newsletter from what I saved this week.",
  ]

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      VStack(alignment: .leading, spacing: 6) {
        Text("What should it do?").font(.system(size: 24, weight: .bold)).foregroundStyle(Theme.ink)
        Text("Say it in your own words: the job, when, and what a good result is. Mercury drafts the bot; you check every part before anything is made.")
          .font(.system(size: 15)).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
      }
      BotTextBox(text: $form.ask, placeholder: "e.g. Every weekday at 7:30, summarise my calendar and the weather.", lines: 5...10, label: "What the bot should do")
      VStack(alignment: .leading, spacing: 8) {
        Text("Or start from one of these").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink3)
        ForEach(Self.examples, id: \.self) { e in
          Button { form.ask = e } label: {
            Text(e).font(.system(size: 14)).foregroundStyle(Theme.ink).multilineTextAlignment(.leading)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(12).background(Theme.surface2, in: RoundedRectangle(cornerRadius: 12))
          }
          .buttonStyle(Pressable())
        }
      }
      if form.busy == .drafting {
        HStack(spacing: 8) {
          Spinner(size: 14)
          Text("Mercury is drafting it (10–60 s)…").font(.system(size: 14)).foregroundStyle(Theme.ink2)
        }
      }
    }
  }
}

/// Step two: the bot itself, every field reviewable.
struct NewBotForm: View {
  @Bindable var form: NewBotModel

  var body: some View {
    VStack(alignment: .leading, spacing: 22) {
      if let plan = form.plan {
        FormNote(icon: form.asFleet ? "person.3" : "person",
                 title: form.asFleet ? "Mercury suggests a fleet of \(form.crew.count + 1)" : "Mercury suggests one bot",
                 text: plan.reason.isEmpty ? "Check the draft below, then create it." : plan.reason)
      }
      if let note = form.note { FormNote(icon: "info.circle", text: note, tint: Theme.amber) }

      FormBlock(title: "Name", hint: "Its id will be \(form.id).") {
        BotTextBox(text: $form.fields.name, placeholder: "e.g. Rust Watcher", label: "Name")
      }
      FormBlock(title: "What it's for", hint: "One line, shown in the bot list.") {
        BotTextBox(text: $form.fields.description, placeholder: "e.g. Watches Hacker News for Rust posts", label: "Description")
      }
      FormBlock(title: "How it works", hint: "Its instructions. Say what a good result is, and when there's nothing to report.") {
        PersonaEditor(persona: $form.fields.persona, before: form.personaBefore, busy: form.busy == .structuring,
                      structure: { Task { await form.structure() } }, undo: form.undoStructure)
      }
      FormBlock(title: form.asFleet ? "The crew" : "Alone or a team",
                hint: form.asFleet ? "\(form.fields.name.isEmpty ? "This bot" : form.fields.name) leads them: it hands them parts of the job and combines what they send back. They get its permission level." : "One bot is cheapest: every hand-off in a fleet is an extra run.") {
        if form.asFleet {
          CrewEditorView(crew: $form.crew, max: form.maxCrew)
          Button("Make it one bot instead") { form.asFleet = false; form.crew = [] }
            .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.ink2)
        } else {
          HStack(spacing: 8) {
            ChipButton(title: form.busy == .planning ? "Mercury is planning…" : "Let Mercury design a team", systemImage: "wand.and.stars") {
              Task { await form.askForTeam() }
            }
            .disabled(form.busy != nil)
            ChipButton(title: "Write the crew", systemImage: "person.badge.plus") { form.asFleet = true; form.crew = [CrewSpec()] }
          }
        }
      }
      FormBlock(title: "When it runs", hint: "Between two runs of one schedule there are always at least 15 minutes.") {
        ScheduleListEditor(schedules: $form.fields.schedules)
      }
      FormBlock(title: "What it may do", hint: form.asFleet ? "Its crew get the same level." : nil) {
        TierPickerView(value: $form.fields.tier, tiers: form.tiers)
      }
      FormBlock(title: "Model and budget") {
        ModelBudgetEditor(model: $form.fields.model, budget: $form.fields.budget, catalog: form.catalog, budgetPlaceholder: "1000000")
      }
    }
  }
}

/// The bottom bar: Draft it / Create, with the reason it can't go yet.
struct NewBotActions: View {
  var form: NewBotModel
  var create: () -> Void

  var body: some View {
    VStack(spacing: 8) {
      if let e = form.error { ErrorText(text: e) }
      switch form.step {
      case .describe:
        Button { Task { await form.draft() } } label: {
          HStack(spacing: 8) {
            if form.busy == .drafting { ProgressView().tint(Theme.onAccent) }
            Text(form.busy == .drafting ? "Drafting…" : "Draft it")
          }
        }
        .buttonStyle(PrimaryButtonStyle())
        .disabled(form.busy != nil || form.ask.trimmingCharacters(in: .whitespacesAndNewlines).count < 10)
        Button("Fill it in myself") { form.manual() }
          .font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.ink2).frame(minHeight: 36)
      case .form:
        if form.createdId == nil {
          Button(action: create) {
            HStack(spacing: 8) {
              if form.busy == .creating { ProgressView().tint(Theme.onAccent) }
              Text(form.asFleet ? "Create the fleet (\(form.crew.filter { !$0.name.trimmed.isEmpty }.count + 1) bots)" : "Create bot")
            }
          }
          .buttonStyle(PrimaryButtonStyle())
          .disabled(form.busy != nil)
        }
      }
    }
    .padding(10)
    .glassSurface(in: RoundedRectangle(cornerRadius: 22))
  }
}


// MARK: - Edit a bot

/// A bot's Edit screen: its face, name, instructions, schedules, permissions, model and budget.
struct BotEditSheet: View {
  @State var edit: EditBotModel
  @State var gate: OwnerGate
  var status: BotStatus?
  var onSaved: () -> Void
  @Environment(\.dismiss) private var dismiss

  init(client: MercuryClient, status: BotStatus, onSaved: @escaping () -> Void) {
    _edit = State(initialValue: EditBotModel(client: client, id: status.id, tier: status.tier))
    _gate = State(initialValue: OwnerGate(client: client))
    self.status = status
    self.onSaved = onSaved
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        if edit.loaded && edit.bot == nil {
          ErrorText(text: edit.error ?? "Couldn't load this bot.").padding(16)
        } else {
          BotEditContent(edit: edit, status: status, onAvatarChanged: onSaved).padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 32)
        }
      }
      .scrollDismissesKeyboard(.interactively)
      .overlay { if !edit.loaded { ProgressView() } }
      .background(Theme.bg)
      .navigationTitle("Edit \(status?.name ?? "bot")")
      #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          if edit.busy { ProgressView() } else {
            Button("Save") {
              Task { if await edit.save(gate: gate) { onSaved(); dismiss() } }
            }
            .fontWeight(.semibold)
            .disabled(!edit.loaded || !edit.dirty)
          }
        }
      }
    }
    .ownerGate(gate)
    .task { await edit.load() }
    .interactiveDismissDisabled(edit.dirty || edit.busy)
  }
}

struct BotEditContent: View {
  @Bindable var edit: EditBotModel
  var status: BotStatus?
  var onAvatarChanged: () -> Void = {}
  @State private var photo: PhotosPickerItem?
  @State private var hasAvatar: Bool?
  @Environment(\.stillForm) private var still

  var body: some View {
    VStack(alignment: .leading, spacing: 22) {
      if let e = edit.error { ErrorText(text: e) }
      FormBlock(title: "Face", hint: "A photo, or the face Mercury draws from its id.") {
        HStack(spacing: 14) {
          BotAvatar(id: edit.id, name: edit.fields.name, hasAvatar: hasAvatar ?? (status?.hasAvatar == true), size: 64,
                    client: still ? nil : edit.client)
            .id(hasAvatar.map { "\($0)" } ?? "")
          VStack(alignment: .leading, spacing: 8) {
            if still {
              ChipButton(title: "Choose a photo", systemImage: "photo") {}
            } else {
              PhotosPicker(selection: $photo, matching: .images) {
                HStack(spacing: 5) {
                  Image(systemName: "photo").font(.system(size: 12, weight: .semibold))
                  Text("Choose a photo").font(.system(size: 14, weight: .medium))
                }
                .foregroundStyle(Theme.ink).padding(.horizontal, 12).frame(minHeight: 34).background(Theme.surface2, in: Capsule())
              }
              .buttonStyle(Pressable())
            }
            if hasAvatar ?? (status?.hasAvatar == true) {
              Button("Use the drawn face") {
                Task { if await edit.removeAvatar() { hasAvatar = false; onAvatarChanged() } }
              }
              .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.ink2)
            }
            if edit.avatarBusy { Spinner(size: 14) }
          }
        }
      }
      .onChange(of: photo) { _, item in
        guard let item else { return }
        Task {
          if let data = try? await item.loadTransferable(type: Data.self), await edit.setAvatar(data) { hasAvatar = true; onAvatarChanged() }
          else if edit.error == nil { edit.error = "Couldn't load that photo." }
          photo = nil
        }
      }
      FormBlock(title: "Name") {
        BotTextBox(text: $edit.fields.name, placeholder: "Name", label: "Name")
        BotTextBox(text: $edit.fields.description, placeholder: "What it's for, in one line", label: "Description")
      }
      FormBlock(title: "How it works", hint: "Its instructions. Say what a good result is, and when there's nothing to report.") {
        PersonaEditor(persona: $edit.fields.persona, before: edit.personaBefore, busy: edit.structuring,
                      structure: { Task { await edit.structure() } }, undo: edit.undoStructure)
      }
      FormBlock(title: "When it runs", hint: "Changes apply right away. Between two runs of one schedule there are always at least 15 minutes.") {
        ScheduleListEditor(schedules: $edit.fields.schedules)
      }
      FormBlock(title: "What it may do", hint: status?.fleetRole == "lead" ? "Its crew keep their own level." : nil) {
        TierPickerView(value: $edit.fields.tier, tiers: edit.tiers)
      }
      FormBlock(title: "Model and budget") {
        ModelBudgetEditor(model: $edit.fields.model, budget: $edit.fields.budget, catalog: edit.catalog)
      }
    }
  }
}

// MARK: - Manage a bot

/// What you can do with a bot: run it, stop or start it, turn it off, edit it, grow a fleet, delete it.
struct BotManageSheet: View {
  var model: BotsModel
  var id: String
  var onEdit: () -> Void
  var onAddCrew: () -> Void
  var onDeleted: () -> Void
  @State var note: String?
  @State var working = false
  @State var confirmDelete = false
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        BotManageContent(model: model, id: id, note: note, working: working, act: act, onEdit: onEdit, onAddCrew: onAddCrew,
                         onDelete: { confirmDelete = true })
          .padding(16)
      }
      .background(Theme.bg)
      .navigationTitle("Manage")
      #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      .confirmationDialog(deleteTitle, isPresented: $confirmDelete, titleVisibility: .visible) {
        Button("Delete", role: .destructive) {
          Task {
            working = true
            if let e = await model.delete(id) { note = e; working = false } else { dismiss(); onDeleted() }
          }
        }
      } message: {
        Text("Its folder, history and schedules go too. Results it delivered stay in your files.")
      }
    }
    .presentationDetents([.medium, .large])
  }

  var crewCount: Int { model.bots.filter { $0.parent == id }.count }
  var deleteTitle: String {
    let name = model.bot(id)?.name ?? "this bot"
    return crewCount > 0 ? "Delete \(name) and its crew (\(crewCount + 1) bots)?" : "Delete \(name)?"
  }

  func act(_ c: BotsModel.Control) {
    Task {
      working = true
      note = await model.control(c, id)
      working = false
    }
  }
}

struct BotManageContent: View {
  var model: BotsModel
  var id: String
  var note: String?
  var working: Bool
  var act: (BotsModel.Control) -> Void
  var onEdit: () -> Void
  var onAddCrew: () -> Void
  var onDelete: () -> Void

  var body: some View {
    let b = model.bot(id)
    VStack(alignment: .leading, spacing: 16) {
      if let b {
        HStack(spacing: 12) {
          BotAvatar(id: b.id, name: b.name, hasAvatar: b.hasAvatar == true, size: 48, dimmed: b.isOff, client: model.client)
          VStack(alignment: .leading, spacing: 3) {
            Text(b.name).font(.system(size: 18, weight: .semibold)).foregroundStyle(Theme.ink)
            Text(BotsList.line(b, model.activity[b.id]) + (b.tier.map { " · " + BotTiers.title($0) } ?? "")).font(.system(size: 13)).foregroundStyle(Theme.ink3).lineLimit(1)
          }
          Spacer()
          if working { Spinner(size: 16) }
        }
        if let note { FormNote(icon: "info.circle", text: note) }
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
          if b.stopped == true || b.needsYou {
            ManageTile(title: "Start", icon: "play.fill") { act(.start) }
          } else if b.isRunning {
            ManageTile(title: "Stop", icon: "stop.fill") { act(.stop) }
          } else {
            ManageTile(title: "Run now", icon: "play.fill", disabled: !b.enabled) { act(.runNow) }
          }
          ManageTile(title: b.enabled ? "Turn off" : "Turn on", icon: b.enabled ? "power" : "power.circle.fill") { act(b.enabled ? .turnOff : .turnOn) }
          ManageTile(title: "Edit", icon: "slider.horizontal.3", action: onEdit)
          if b.fleetRole == "lead" {
            ManageTile(title: "Add crew", icon: "person.badge.plus", action: onAddCrew)
            ManageTile(title: "Suggest crew", icon: "wand.and.stars") { act(.suggestCrew) }
          } else if b.fleetRole != "crew" {
            ManageTile(title: "Make a fleet", icon: "person.3") { act(.makeFleet) }
          }
          ManageTile(title: "Delete", icon: "trash", danger: true, action: onDelete)
        }
        .disabled(working)
        Text("To message it, use the box on its Live tab.").font(.system(size: 13)).foregroundStyle(Theme.ink4)
      } else {
        BotsEmpty(title: "This bot is gone", text: "It was removed on your Mercury.")
      }
    }
  }
}

struct ManageTile: View {
  var title: String
  var icon: String
  var danger = false
  var disabled = false
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 10) {
        Image(systemName: icon).font(.system(size: 17, weight: .medium))
        Text(title).font(.system(size: 15, weight: .medium))
      }
      .foregroundStyle(danger ? Theme.red : Theme.ink)
      .frame(maxWidth: .infinity, minHeight: 76, alignment: .leading)
      .padding(.horizontal, 14)
      .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 16))
      .opacity(disabled ? 0.4 : 1)
    }
    .buttonStyle(Pressable())
    .disabled(disabled)
  }
}

/// A crew member written on the phone.
struct AddCrewSheet: View {
  var model: BotsModel
  var leadId: String
  @State var crew = [CrewSpec()]
  @State var error: String?
  @State var busy = false
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          Text("It gets \(model.bot(leadId)?.name ?? "the lead")'s permission level. The lead hands it work and combines what it sends back.")
            .font(.system(size: 14)).foregroundStyle(Theme.ink2)
          CrewEditorView(crew: $crew, max: 1)
          if let error { ErrorText(text: error) }
        }
        .padding(16)
      }
      .background(Theme.bg)
      .navigationTitle("New crew member")
      #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          if busy { ProgressView() } else {
            Button("Add") {
              Task {
                busy = true
                error = await model.addCrew(leadId, crew.first ?? CrewSpec())
                busy = false
                if error == nil { dismiss() }
              }
            }
            .fontWeight(.semibold)
            .disabled(crew.isEmpty)
          }
        }
      }
    }
  }
}
