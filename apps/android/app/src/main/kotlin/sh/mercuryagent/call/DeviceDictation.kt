package sh.mercuryagent.call

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import app.mercury.voice.DictationEvent
import app.mercury.voice.DictationInterface

/**
 * Dictation with the phone's own speech recognition (iOS: DeviceDictation), for when Mercury has
 * no speech service (no voice key at all) or is too old to dictate. Android's [SpeechRecognizer],
 * on the device when it can (the on-device recogniser on Android 12+, else EXTRA_PREFER_OFFLINE),
 * with partial results, reporting the same [DictationEvent]s as the Rust engine so [DictationModel]
 * treats both alike. The recogniser opens the microphone itself, so no frames are pushed.
 *
 * Android's recogniser ends after each pause: that stretch's text becomes final and it listens
 * again, so dictation carries on until it's stopped. Main thread only.
 */
class DeviceDictation private constructor(
  private val context: Context,
  private val emit: (DictationEvent) -> Unit,
) : DictationInterface {
  private val main = Handler(Looper.getMainLooper())
  private var recognizer: SpeechRecognizer? = null
  private var text = ""
  private var stopping = false
  private var closed = false
  private val onDevice = Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)

  private val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
    putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
    putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
    // Dictation pauses: wait a little longer before a stretch ends.
    putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2_000L)
  }

  private val listener = object : RecognitionListener {
    override fun onReadyForSpeech(params: Bundle?) {}
    override fun onBeginningOfSpeech() {}
    override fun onRmsChanged(rmsdB: Float) {
      // Roughly -2 (quiet) to 10 dB (loud speech).
      if (!closed) emit(DictationEvent.Levels(((rmsdB + 2f) / 12f).coerceIn(0f, 1f)))
    }
    override fun onBufferReceived(buffer: ByteArray?) {}
    override fun onEndOfSpeech() {}
    override fun onPartialResults(partialResults: Bundle?) {
      val t = first(partialResults) ?: return
      if (closed || t.isEmpty()) return
      text = t
      emit(DictationEvent.Partial(t))
    }
    override fun onResults(results: Bundle?) {
      if (closed) return
      val t = first(results) ?: text
      text = ""
      if (t.isNotBlank()) emit(DictationEvent.Final(t))
      next()
    }
    override fun onError(error: Int) {
      if (closed) return
      val t = text
      text = ""
      if (t.isNotBlank()) emit(DictationEvent.Final(t))
      when {
        stopping -> next()
        // Nothing said in a while, or nothing understood: keep listening.
        error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> next()
        else -> close(reason(error))
      }
    }
    override fun onEvent(eventType: Int, params: Bundle?) {}
  }

  private fun first(b: Bundle?): String? = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim()

  /** A stretch ended: listen again, or finish when stopping. */
  private fun next() {
    if (stopping) { close("stopped"); return }
    recognizer?.startListening(intent)
  }

  private fun begin(): Boolean {
    val r = try {
      if (onDevice) SpeechRecognizer.createOnDeviceSpeechRecognizer(context) else SpeechRecognizer.createSpeechRecognizer(context)
    } catch (_: Throwable) { return false }
    r.setRecognitionListener(listener)
    recognizer = r
    r.startListening(intent)
    emit(DictationEvent.Connected)
    return true
  }

  private fun close(reason: String) {
    if (closed) return
    closed = true
    main.removeCallbacksAndMessages(null)
    recognizer?.let { runCatching { it.cancel() }; runCatching { it.destroy() } }
    recognizer = null
    emit(DictationEvent.Closed(reason))
  }

  /** The recogniser opens the microphone itself. */
  override fun pushAudio(pcm16: ByteArray) {}

  /** Stop listening: the last words are finalised, then `Closed("stopped")`. */
  override fun stop() {
    if (closed || stopping) return
    stopping = true
    recognizer?.stopListening()
    // The recogniser normally answers within a second; don't wait for ever.
    main.postDelayed({
      val t = text
      text = ""
      if (!closed && t.isNotBlank()) emit(DictationEvent.Final(t))
      close("stopped")
    }, 3_000)
  }

  /** Stop now, dropping what isn't final. */
  override fun cancel() = close("cancelled")

  companion object {
    /** This phone has a speech recogniser (the manifest's <queries> lets the app see it). */
    fun available(context: Context): Boolean = runCatching {
      SpeechRecognizer.isRecognitionAvailable(context) ||
        (Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context))
    }.getOrDefault(false)

    /** Starts listening (main thread, RECORD_AUDIO granted); null when the recogniser can't be made. */
    fun start(context: Context, listener: (DictationEvent) -> Unit): DeviceDictation? {
      val d = DeviceDictation(context, listener)
      return if (d.begin()) d else null
    }

    fun reason(error: Int): String = when (error) {
      SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Mercury isn't allowed to use the microphone"
      SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "this phone's speech recognition needs the internet for this language"
      SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "this phone's speech recognition is busy in another app"
      SpeechRecognizer.ERROR_AUDIO -> "the microphone couldn't be read"
      13 /* ERROR_LANGUAGE_NOT_SUPPORTED */, 12 /* ERROR_LANGUAGE_UNAVAILABLE */ -> "this phone can't recognise speech in its language offline"
      else -> "this phone's speech recognition stopped (error $error)"
    }
  }
}
