import SwiftUI
import MercuryCore

/// The Bots screens in a fixed sample state, for the Snapshots tool: the roster, a bot working
/// with a failed step, a question waiting for you, a fleet's feed, the inbox and history.
@MainActor
public enum BotsGallery {
  static let t0: Double = 1_794_490_000_000

  static func sampleModel() -> BotsModel {
    let m = BotsModel(client: MercuryClient(baseURL: URL(string: "http://localhost")!))
    m.loaded = true
    m.now = t0 + 200_000
    m.unread = 3
    m.bots = [
      BotStatus(id: "opersourcefyi-manger", name: "Launch Manager", state: "running", fleetRole: "lead", unread: 2),
      BotStatus(id: "content-bot", name: "Content Bot", state: "running", fleetRole: "crew", parent: "opersourcefyi-manger"),
      BotStatus(id: "deployment-bot", name: "Deployment Bot", state: "running", needsYou: true, fleetRole: "crew", parent: "opersourcefyi-manger"),
      BotStatus(id: "analytics-bot", name: "Analytics Bot", fleetRole: "crew", parent: "opersourcefyi-manger", description: "Weekly traffic and signups"),
      BotStatus(id: "inbox-triage", name: "Inbox Triage", state: "idle", unread: 1, description: "Sorts mail every morning at 8"),
      BotStatus(id: "price-watch", name: "Price Watch", state: "running"),
      BotStatus(id: "article-writer", name: "Article Writer", enabled: false, state: "disabled"),
    ]
    m.activity = ["price-watch": "web_fetch amazon.com", "content-bot": "write_file posts/launch.md"]
    m.approvals = [BotApproval(id: "q1", botId: "deployment-bot", botName: "Deployment Bot", runId: "j3",
                               prompt: "Run command: npx wrangler pages deploy ./dist --project-name opersource", at: t0 + 150_000, expiresAt: t0 + 200_000 + 540_000)]
    func e(_ bot: String, _ name: String, _ job: String, _ kind: String, _ label: String, _ dt: Double, status: String? = nil,
           detail: String? = nil, step: Int? = nil, text: String? = nil, trigger: String? = nil, prompt: String? = nil, from: String? = nil) -> BotActivityEvent {
      BotActivityEvent(botId: bot, jobId: job, kind: kind, label: label, detail: detail, stepIndex: step, status: status, textTail: text,
                       at: t0 + dt, botName: name, trigger: trigger, prompt: prompt, fromBot: from)
    }
    m.live = [
      // Price Watch: a schedule's run that finished.
      e("price-watch", "Price Watch", "j0", "turn-start", "x", 0, trigger: "cron", prompt: "Check the three tracked prices and tell me if any dropped below my limit."),
      e("price-watch", "Price Watch", "j0", "tool", "web_fetch amazon.com/dp/B0C…", 2_000, status: "done"),
      e("price-watch", "Price Watch", "j0", "thinking", "thinking", 9_000, text: "The Kindle dropped to $89 (your limit is $95). The other two are unchanged."),
      e("price-watch", "Price Watch", "j0", "turn-end", "completed", 10_000, status: "done"),
      // Launch Manager: your message, delegated.
      e("opersourcefyi-manger", "Launch Manager", "j1", "turn-start", "x", 60_000, trigger: "api", prompt: "Ship the launch post and deploy the site tonight."),
      e("opersourcefyi-manger", "Launch Manager", "j1", "step", "step 2", 61_000, step: 2),
      e("opersourcefyi-manger", "Launch Manager", "j1", "tool", "bot_message content-bot", 62_000, status: "done"),
      e("opersourcefyi-manger", "Launch Manager", "j1", "tool", "bot_message deployment-bot", 63_000, status: "done"),
      e("opersourcefyi-manger", "Launch Manager", "j1", "turn-end", "completed", 64_000, status: "done"),
      // Content Bot: from the lead, working, one failed step.
      e("content-bot", "Content Bot", "j2", "turn-start", "x", 70_000, trigger: "mailbox", prompt: "Write the launch post: 600 words, friendly, link the dataset.", from: "opersourcefyi-manger"),
      e("content-bot", "Content Bot", "j2", "step", "step 4", 71_000, step: 4),
      e("content-bot", "Content Bot", "j2", "tool", "read_file data/projects.json", 72_000, status: "done"),
      e("content-bot", "Content Bot", "j2", "tool", "web_fetch opersource.fyi/api", 74_000, status: "error", detail: "fetch failed: 503 Service Unavailable"),
      e("content-bot", "Content Bot", "j2", "tool", "write_file posts/launch.md", 80_000, status: "running"),
      e("content-bot", "Content Bot", "j2", "thinking", "thinking", 81_000, text: "100 open-source projects, sorted by what they help you build. Start with the web frameworks…"),
      // Deployment Bot: waiting for you.
      e("deployment-bot", "Deployment Bot", "j3", "turn-start", "x", 140_000, trigger: "mailbox", prompt: "Deploy dist/ to Cloudflare Pages.", from: "opersourcefyi-manger"),
      e("deployment-bot", "Deployment Bot", "j3", "tool", "run_command npm run build", 142_000, status: "done"),
      e("deployment-bot", "Deployment Bot", "j3", "step", "Waiting for your approval", 150_000),
    ]
    return m
  }

  static func feed(_ m: BotsModel, members ids: [String]) -> some View {
    let members = ids.compactMap(m.bot)
    return VStack(spacing: 0) {
      // The renderer can't draw a ScrollView: the feed's bottom is laid out directly.
      Color.clear.overlay(alignment: .bottom) { LiveFeedContent(model: m, members: members).padding(.horizontal, 16) }.clipped()
      BotsComposer(members: members, leadId: ids[0], target: .constant(ids[0]), draft: .constant(""), focus: FocusState<Bool>().projectedValue, still: true) {}
    }
  }

  static func header<V: View>(_ title: String, tabs: BotDetail.Tab? = nil, @ViewBuilder _ content: () -> V) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).font(.system(size: tabs == nil ? 32 : 17, weight: .bold)).foregroundStyle(Theme.ink)
        .frame(maxWidth: .infinity, alignment: tabs == nil ? .leading : .center).padding(.horizontal, 16)
      if let tabs { BotsTabs(selection: .constant(tabs)).padding(.horizontal, 16) }
      content()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).background(Theme.bg)
  }

  public static func screens() -> [(name: String, view: AnyView)] {
    let m = sampleModel()
    let entries = [
      BotInboxEntry(id: "i1", botId: "price-watch", botName: "Price Watch", kind: "result", title: "The Kindle dropped to $89",
                    summary: "Below your **$95** limit. The other two tracked prices are unchanged.", at: t0 + 10_000, read: false),
      BotInboxEntry(id: "i2", botId: "opersourcefyi-manger", botName: "Launch Manager", kind: "result", title: "Deployment package ready",
                    summary: "Verified the 100-project dataset, wrote the manifest and the landing page.",
                    files: ["/x/2026-11-10 Deployment Ready.md", "/x/100 Open Source Projects.json"], complete: true, at: t0 - 86_400_000, read: true),
      BotInboxEntry(id: "i3", botId: "content-bot", botName: "Content Bot", kind: "failed", title: "Couldn't reach opersource.fyi",
                    summary: "The site answered 503 three times. I'll try again on the next run.", at: t0 - 90_000_000, read: false),
    ]
    let history = [
      BotRunRecord(runId: "r1", botId: "content-bot", trigger: "mailbox", state: "completed", startedAt: t0 - 3_600_000, durationMs: 29_030,
                   summary: "Drafted the launch post and delivered it to the fleet folder.", outcome: "deliverable", complete: true),
      BotRunRecord(runId: "r2", botId: "opersourcefyi-manger", trigger: "api", state: "completed", startedAt: t0 - 7_200_000, durationMs: 8_131,
                   summary: "Nothing new to report.", outcome: "quiet"),
      BotRunRecord(runId: "r3", botId: "deployment-bot", trigger: "mailbox", state: "failed", startedAt: t0 - 9_000_000, durationMs: 61_000,
                   error: "provider_timeout: the model didn't answer in 60 s"),
    ]
    let fleet = ["opersourcefyi-manger", "content-bot", "deployment-bot", "analytics-bot"]
    return [
      ("08a-bots-list", AnyView(header("Bots") { BotsList(model: m).padding(.horizontal, 16) })),
      ("08b-bots-fleet-live", AnyView(header("Launch Manager", tabs: .live) { feed(m, members: fleet) })),
      ("08c-bots-bot-working", AnyView(header("Content Bot", tabs: .live) { feed(m, members: ["content-bot"]) })),
      ("08d-bots-waiting-for-you", AnyView(header("Deployment Bot", tabs: .live) { feed(m, members: ["deployment-bot"]) })),
      ("08e-bots-inbox", AnyView(header("Inbox") {
        BotsInboxContent(model: m, botIds: nil, entries: entries, unreadOnly: .constant(false)) { _ in }.padding(.horizontal, 16)
      })),
      ("08f-bots-history", AnyView(header("Launch Manager", tabs: .history) {
        VStack(alignment: .leading, spacing: 10) {
          BotsTabs(selection: .constant(BotsHistory.Filter.all)).frame(width: 220)
          ForEach(history) { r in HistoryRow(run: r, bot: m.bot(r.botId), fleet: true) }
        }
        .padding(.horizontal, 16)
      })),
      ("08g-bots-avatars", AnyView(header("Faces") {
        let ids = ["analytics-bot", "article-writer", "content-bot", "opersourcefyi-manger", "deployment-bot", "w", "writer", "inbox-triage",
                   "price-watch", "a", "b", "c", "researcher", "scout", "editor", "qa-bot"]
        LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 16) {
          ForEach(ids, id: \.self) { BotFace(id: $0).frame(width: 64, height: 64) }
        }
        .padding(16)
      })),
    ]
  }
}
