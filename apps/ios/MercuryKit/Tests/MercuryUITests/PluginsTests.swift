import Testing
import Foundation
@testable import MercuryUI
@testable import MercuryCore

/// A small Mercury for plugin changes: install needs the owner's approval first, then Optimus is
/// installed and (after `startsAfter` looks) running.
final class PluginMercury: URLProtocol {
  nonisolated(unsafe) static var requests: [URLRequest] = []
  nonisolated(unsafe) static var installed = false
  nonisolated(unsafe) static var looks = 0
  nonisolated(unsafe) static var startsAfter = 0
  nonisolated(unsafe) static var approval = "allowed"
  nonisolated(unsafe) static var installError: String?

  static func reset() { requests = []; installed = false; looks = 0; startsAfter = 0; approval = "allowed"; installError = nil }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    Self.requests.append(request)
    let path = request.url!.path
    var status = 200
    var body: Any = ["ok": true]
    switch (request.httpMethod ?? "GET", path) {
    case ("POST", "/api/plugins/install"):
      if request.value(forHTTPHeaderField: "X-Mercury-Approval") == nil {
        status = 428
        body = ["error": "Waiting for the owner to approve: Change plugins (POST /install).", "approvalRequired": true, "approvalId": "ap1", "code": "ABC123", "where": "this computer"]
      } else if let e = Self.installError {
        status = 400; body = ["error": e]
      } else {
        Self.installed = true
        body = ["id": "optimus", "name": "Optimus", "version": "0.5.2"]
      }
    case ("GET", "/api/security/approvals/ap1/status"):
      body = ["status": Self.approval]
    case ("GET", "/api/plugins/optimus"):
      Self.looks += 1
      var p: [String: Any] = ["id": "optimus", "name": "Optimus", "enabled": Self.installed, "running": Self.installed && Self.looks > Self.startsAfter,
                              "status": Self.installed ? "enabled" : "available", "kind": "out-of-process", "tools": [String]()]
      if Self.installed { p["installedVersion"] = "0.5.2"; p["permissions"] = ["desktop": true] }
      body = ["plugin": p]
    default:
      status = 404; body = ["error": "Not found"]
    }
    let data = try! JSONSerialization.data(withJSONObject: body)
    let res = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@MainActor @Suite(.serialized)
struct PluginsTests {
  func decode<T: Decodable>(_ t: T.Type, _ json: String) throws -> T { try JSONDecoder().decode(t, from: Data(json.utf8)) }

  // A real GET /api/plugins shape: Optimus only in the catalog, WhatsApp installed.
  let listJSON = #"""
  {"items":[
    {"id":"whatsapp","name":"WhatsApp","description":"Chat on WhatsApp.","kind":"out-of-process","tier":"official","status":"update-available",
     "installedVersion":"0.1.1","latestVersion":"0.1.2","enabled":true,"running":true,"verified":true,"tools":[],"commands":[],
     "permissions":{"network":[],"secrets":[]}},
    {"id":"optimus","name":"Optimus","description":"Uses your computer.","kind":"out-of-process","tier":"official","status":"available",
     "latestVersion":"0.5.2","sizeBytes":1459305,"enabled":false,"running":false,"verified":false,"tools":[],"commands":[],
     "permissions":{"network":["api.openai.com"],"secrets":["GEMINI_API_KEY"]}}
  ],"stale":false,"safeMode":false}
  """#

  // MARK: Installed or only in the catalog

  @Test func catalogEntriesAreNotInstalled() throws {
    let list = try decode(PluginList.self, listJSON)
    #expect(Plugins.installed(list.items).map(\.id) == ["whatsapp"])
    #expect(Plugins.available(list.items).map(\.id) == ["optimus"])
    let optimus = list.items[1]
    #expect(!Plugins.isInstalled(optimus))
    #expect(!Plugins.isInstalled(nil))
    // The update badge only for an installed plugin with a newer catalog version.
    #expect(Plugins.updateAvailable(list.items[0]))
    #expect(!Plugins.updateAvailable(optimus))
  }

  @Test func onlyAMercuryWithRemoteApprovalsTakesChanges() {
    #expect(Plugins.canManage(["plugins", "security.remote", "voice"]))
    #expect(!Plugins.canManage(["plugins"]))
    #expect(!Plugins.canManage(nil))
  }

  @Test func voiceOffersOptimusOnlyWhenItIsntInstalled() throws {
    let catalogOnly = try decode(PluginDetail.self, #"{"id":"optimus","name":"Optimus","enabled":false,"running":false,"status":"available"}"#)
    let installedNoSettings = try decode(PluginDetail.self, #"{"id":"optimus","name":"Optimus","enabled":true,"running":true,"installedVersion":"0.5.2"}"#)
    #expect(VoiceScreen.offersInstall(.notInstalled, plugin: catalogOnly, canManage: true))
    #expect(VoiceScreen.offersInstall(.notInstalled, plugin: nil, canManage: true))
    #expect(!VoiceScreen.offersInstall(.notInstalled, plugin: catalogOnly, canManage: false))
    #expect(!VoiceScreen.offersInstall(.notInstalled, plugin: installedNoSettings, canManage: true))
    #expect(!VoiceScreen.offersInstall(.settings, plugin: catalogOnly, canManage: true))
  }

  // MARK: Which confirm sheet

  @Test func optimusGetsTheComputerControlSheet() throws {
    // From the catalog (which doesn't say `desktop`) and from an installed manifest that does.
    let catalog = try decode(PluginList.self, listJSON).items[1]
    let expected = Plugins.Consent.controlsComputer(
      title: "Install Optimus?",
      body: "Optimus lets Mercury see the screen and use the mouse and keyboard on Studio Mac. It asks before anything that submits, sends or deletes.")
    #expect(Plugins.consent(for: catalog, computer: "Studio Mac") == expected)
    let other = PluginDetail(id: "screen-pilot", name: "Pilot", permissions: PluginPermissions(desktop: true))
    guard case .controlsComputer(let title, _) = Plugins.consent(for: other, computer: "Studio Mac", enabling: true) else {
      Issue.record("a desktop plugin must get the computer-control sheet"); return
    }
    #expect(title == "Turn on Pilot?")
  }

  @Test func otherPluginsListWhatTheyReach() {
    let weather = PluginDetail(id: "weather", name: "Weather", kind: "in-process", tools: ["weather__forecast"],
                               permissions: PluginPermissions(network: ["api.open-meteo.com"], secrets: ["WEATHER_KEY"], providers: ["openai": .init(unlocks: "Spoken forecasts")]))
    guard case .access(let title, let lines) = Plugins.consent(for: weather, computer: "Studio Mac") else {
      Issue.record("expected the access sheet"); return
    }
    #expect(title == "Install Weather?")
    #expect(lines == [
      "Connects to api.open-meteo.com",
      "Can read the key it needs: WEATHER_KEY",
      "Uses your OpenAI key for spoken forecasts",
      "Gives Mercury 1 tool",
      "Runs inside Mercury on Studio Mac",
    ])
    let quiet = PluginDetail(id: "notes", name: "Notes", kind: "out-of-process")
    guard case .access(_, let q) = Plugins.consent(for: quiet, computer: "Studio Mac") else { Issue.record("access"); return }
    #expect(q.last == "Doesn't reach the internet or read any keys")
  }

  @Test func aComputerWithoutAScreenIsSaidPlainly() {
    let optimus = PluginDetail(id: "optimus", name: "Optimus")
    #expect(Plugins.friendlyError("Optimus can't be installed here: not available for android-arm64 (supports darwin-arm64).", plugin: optimus)
            == "Optimus needs a desktop computer (a Mac, Windows or Linux with a screen). This Mercury runs where there isn't one.")
    #expect(Plugins.friendlyError("Can't open display", plugin: optimus).hasPrefix("Optimus needs a desktop computer"))
    let other = PluginDetail(id: "weather", name: "Weather")
    #expect(Plugins.friendlyError("Weather can't be installed here: needs Mercury >=2", plugin: other) == "Weather can't be installed here: needs Mercury >=2")
  }

  // MARK: After installing

  @Test func stateAfterInstall() {
    var p = PluginDetail(id: "optimus", name: "Optimus", enabled: true, running: true, installedVersion: "0.5.2", kind: "out-of-process")
    #expect(Plugins.after(p) == .running)
    p.running = false
    #expect(Plugins.after(p) == .starting)
    p.missing = [try! JSONDecoder().decode(PluginDetail.Missing.self, from: Data(#"{"key":"openai","needs":"An OpenAI key","fix":"Add it"}"#.utf8))]
    #expect(Plugins.after(p) == .needsSetup)
    p.missing = nil; p.lastError = "Can't open display :0"
    #expect(Plugins.after(p) == .failed("Optimus needs a desktop computer (a Mac, Windows or Linux with a screen). This Mercury runs where there isn't one."))
    #expect(Plugins.after(PluginDetail(id: "optimus", name: "Optimus", status: "available")) == .missing)
  }

  // MARK: The owner's approval, then install, then running

  /// URLSession hands the body to a URLProtocol as a stream.
  nonisolated static func body(_ r: URLRequest) -> Data {
    if let d = r.httpBody { return d }
    guard let s = r.httpBodyStream else { return Data() }
    s.open(); defer { s.close() }
    var out = Data(); var buf = [UInt8](repeating: 0, count: 4096)
    while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; out.append(buf, count: n) }
    return out
  }

  func model() -> PluginActionModel {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [PluginMercury.self]
    let c = MercuryClient(baseURL: URL(string: "http://mercury.test")!, token: "t", session: URLSession(configuration: config))
    let m = PluginActionModel(client: c, plugin: PluginDetail(id: "optimus", name: "Optimus", status: "available"), kind: .install, computer: "Studio Mac")
    m.pollEvery = .milliseconds(10)
    return m
  }

  @Test func approvalThenInstallCarriesOnToRunning() async {
    PluginMercury.reset()
    PluginMercury.startsAfter = 2
    let m = model()
    #expect(m.stage == .confirm)
    await m.run()
    #expect(m.stage == .done(.running))
    #expect(Plugins.isInstalled(m.result))
    let installs = PluginMercury.requests.filter { $0.url!.path == "/api/plugins/install" }
    #expect(installs.count == 2)
    #expect(installs[0].value(forHTTPHeaderField: "X-Mercury-Approval") == nil)
    #expect(installs[1].value(forHTTPHeaderField: "X-Mercury-Approval") == "ap1")
    let body = try? JSONSerialization.jsonObject(with: Self.body(installs[1])) as? [String: Any]
    #expect(body?["source"] as? String == "optimus" && body?["enable"] as? Bool == true)
    #expect(m.gate.question == nil)
  }

  @Test func aRefusalIsShownAndNothingInstalls() async {
    PluginMercury.reset()
    PluginMercury.approval = "denied"
    let m = model()
    await m.run()
    #expect(m.stage == .failed("The owner said no."))
    #expect(!PluginMercury.installed)
  }

  @Test func anUnsupportedComputerIsExplained() async {
    PluginMercury.reset()
    PluginMercury.installError = "Optimus can't be installed here: not available for android-arm64 (supports darwin-arm64, linux-x64)."
    let m = model()
    await m.run()
    #expect(m.stage == .failed("Optimus needs a desktop computer (a Mac, Windows or Linux with a screen). This Mercury runs where there isn't one."))
  }
}
