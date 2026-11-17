package sh.mercuryagent.ui.media

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import android.webkit.MimeTypeMap
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.core.content.FileProvider
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import sh.mercuryagent.core.MercuryClient
import sh.mercuryagent.core.cachedFile

/**
 * Loads Mercury's files (they need the device token, so no plain URL loading): downloaded once into
 * the app's cache folder, pictures decoded at a sensible size and kept in memory while it allows,
 * so the conversation, the viewer and the artifacts grid share one download (iOS: MediaLoader and
 * MediaImageCache). Opening and sharing go through a FileProvider.
 */
class MediaLoader(val client: MercuryClient, private val context: Context) {
  private val cacheDir: File get() = context.cacheDir
  private val locks = mutableMapOf<String, Mutex>()

  /** The file for [url], downloaded with the token when it's this Mercury's. */
  suspend fun file(url: String, name: String? = null): File {
    val lock = synchronized(locks) { locks.getOrPut(url) { Mutex() } }
    return lock.withLock { client.cachedFile(url, name, cacheDir) }
  }

  /** A picture at most [maxSide] px on its longest side; null when it can't be read. */
  suspend fun image(url: String, name: String? = null, maxSide: Int = 2048): ImageBitmap? {
    val key = "$url@$maxSide"
    images.get(key)?.let { return it }
    val f = runCatching { file(url, name) }.getOrNull() ?: return null
    val bmp = withContext(Dispatchers.IO) { decode(f, maxSide) } ?: return null
    val img = bmp.asImageBitmap()
    images.put(key, img)
    return img
  }

  fun cached(url: String, maxSide: Int = 2048): ImageBitmap? = images.get("$url@$maxSide")

  /** A content:// address other apps may read (FileProvider), for open and share. */
  fun shareUri(f: File) = FileProvider.getUriForFile(context, "${context.packageName}.files", f)

  /** Opens [f] in another app (a PDF reader, a player), or says why not. */
  fun open(context: Context, f: File, mime: String?): String? {
    val type = mime ?: mimeOf(f.name)
    val i = Intent(Intent.ACTION_VIEW).setDataAndType(shareUri(f), type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    return try {
      context.startActivity(Intent.createChooser(i, null).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
      null
    } catch (_: ActivityNotFoundException) {
      "No app on this phone opens ${f.extension.uppercase().ifEmpty { "this file" }} files."
    }
  }

  /** The system share sheet for [f]. */
  fun share(context: Context, f: File, mime: String?) {
    val i = Intent(Intent.ACTION_SEND).setType(mime ?: mimeOf(f.name))
      .putExtra(Intent.EXTRA_STREAM, shareUri(f)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    context.startActivity(Intent.createChooser(i, null))
  }

  companion object {
    /** Decoded pictures, by URL and size, about 48 MB of them. */
    private val images = object : LruCache<String, ImageBitmap>(48 * 1024 * 1024) {
      override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
    }

    fun mimeOf(name: String): String =
      MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"

    /** Decodes with a power-of-two sample size so a 4K picture never takes 64 MB. */
    fun decode(f: File, maxSide: Int): Bitmap? {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(f.path, bounds)
      if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
      var sample = 1
      while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
      return BitmapFactory.decodeFile(f.path, BitmapFactory.Options().apply { inSampleSize = sample })
    }
  }
}

/** The loader for the Mercury on screen (set once per connection in MercuryRoot). */
val LocalMediaLoader = staticCompositionLocalOf<MediaLoader?> { null }
