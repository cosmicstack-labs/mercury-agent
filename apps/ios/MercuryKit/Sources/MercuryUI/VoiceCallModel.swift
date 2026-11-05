import SwiftUI
import MercuryCore

/// A voice call with Mercury from the phone. The phone hears you, Mercury (on your computer
/// or server) turns it into text and answers in the conversation, and the phone reads the
/// answer aloud, then listens again. The call is an ordinary chat thread, so it stays in Chats.
@MainActor @Observable
final class VoiceCallModel {
  enum Phase: Equatable { case starting, listening, hearing, sending, working, speaking, ended }

  var phase: Phase = .starting
  var muted = false
  /// The last thing said: yours in quotes while Mercury works, then Mercury's answer.
  var caption: String?
  var level: Float = 0
  var startedAt: Date?
  var error: String?
  let conversation: ConversationModel
  let callId = UUID().uuidString.lowercased()
  var support: SpeechSupport?
  var audio: CallAudio?
  /// Started from Chats, with no conversation screen under it.
  var ownsConversation = false
  /// Bumped whenever the call moves on, so a listen or a reading that was overtaken stops quietly.
  var turn = 0

  init(conversation: ConversationModel) {
    self.conversation = conversation
  }

  var client: MercuryClient { conversation.client }

  /// One line under the orb: what's happening now.
  var status: String {
    if let error { return error }
    switch phase {
    case .starting: return "Connecting…"
    case .listening: return muted ? "Muted" : "Listening"
    case .hearing: return "Listening…"
    case .sending: return "Got it"
    case .working:
      if !conversation.prompts.isEmpty { return "Needs your OK" }
      if conversation.queued != nil { return "Waiting for another chat to finish…" }
      if let s = conversation.steps.last(where: { !$0.done }) { return "\(s.label)…" }
      return "Thinking…"
    case .speaking: return "Speaking"
    case .ended: return "Call ended"
    }
  }

  func start() async {
    do {
      let s = try await client.speechSupport()
      support = s
      guard s.listen else {
        error = "Calls need a speech service on your Mercury. Add one in Mercury Desktop: Settings → Voice."
        phase = .ended
        return
      }
    } catch {
      self.error = error.localizedDescription
      phase = .ended
      return
    }
    guard await CallAudio.permission() else {
      error = "Mercury can't hear you. Allow the microphone in Settings → Mercury."
      phase = .ended
      return
    }
    let a = CallAudio()
    a.onLevel = { [weak self] in self?.level = $0 }
    a.onSpeech = { [weak self] in if self?.phase == .listening { self?.phase = .hearing } }
    do { try a.activate() } catch {
      self.error = "Couldn't open the microphone."
      phase = .ended
      return
    }
    audio = a
    conversation.callId = callId
    conversation.onTurnEnd = { [weak self] reply in Task { await self?.answered(reply) } }
    if conversation.threadId != nil && !conversation.loaded { await conversation.load() }
    startedAt = .now
    listenNext()
  }

  /// Hears the next thing said and sends it.
  func listenNext() {
    guard phase != .ended, let audio else { return }
    turn += 1
    let mine = turn
    phase = .listening
    guard !muted else { return }
    Task {
      do {
        guard let recording = try await audio.listen(), mine == turn else { return }
        phase = .sending
        let heard = try await client.transcribe(recording, mime: "audio/wav").trimmingCharacters(in: .whitespacesAndNewlines)
        guard mine == turn, phase != .ended else { return }
        guard !heard.isEmpty else { listenNext(); return }
        error = nil
        caption = "“\(heard)”"
        conversation.draft = heard
        await conversation.send()
        guard mine == turn, phase != .ended else { return }
        if let e = conversation.error {
          error = e
          conversation.draft = ""
          listenNext()
        } else if phase == .sending {
          phase = .working
        }
      } catch {
        guard mine == turn, phase != .ended else { return }
        self.error = error.localizedDescription
        try? await Task.sleep(for: .seconds(1.5))
        if mine == turn { listenNext() }
      }
    }
  }

  /// Mercury finished a turn: read the answer aloud, then listen again.
  func answered(_ reply: ChatMessage?) async {
    guard phase != .ended, let audio else { return }
    turn += 1
    let mine = turn
    audio.stopListening()
    let text = reply.map { Spoken.text($0.content) } ?? ""
    if !text.isEmpty { caption = text }
    if !text.isEmpty, support?.speak == true {
      phase = .speaking
      // Short first part so the voice starts quickly; the next part is made while one plays.
      let parts = Spoken.parts(text, max: min(support?.maxChars ?? 4000, 600))
      var next: Task<Data?, Never>? = Task { [client] in try? await client.speak(parts[0]) }
      for i in parts.indices {
        let data = await next?.value
        next = i + 1 < parts.count ? Task { [client] in try? await client.speak(parts[i + 1]) } : nil
        guard mine == turn, phase == .speaking else { next?.cancel(); return }
        guard let data else { continue }
        if !(await audio.play(data)) { break }
      }
      next?.cancel()
    }
    if mine == turn { listenNext() }
  }

  func toggleMute() {
    muted.toggle()
    if muted {
      audio?.stopListening()
      if phase == .listening || phase == .hearing { turn += 1; phase = .listening }
    } else if phase == .listening {
      listenNext()
    }
  }

  /// Cuts Mercury off: stops its voice, or stops the work it's doing, and listens.
  func interrupt() async {
    switch phase {
    case .speaking:
      turn += 1
      audio?.stopPlaying()
      listenNext()
    case .working, .sending:
      await conversation.stop()
    default:
      break
    }
  }

  var canInterrupt: Bool { phase == .speaking || phase == .working }

  /// Hangs up. Work Mercury already started keeps going and lands in the chat.
  func end() {
    guard phase != .ended else { return }
    turn += 1
    phase = .ended
    conversation.callId = nil
    conversation.onTurnEnd = { _ in }
    audio?.deactivate()
    audio = nil
    level = 0
    if ownsConversation { conversation.listener?.cancel() }
    conversation.onChange()
  }
}
