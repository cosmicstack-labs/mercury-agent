package sh.mercuryagent.ui.connect

import android.content.Context
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

/**
 * Scan to connect: Google's code scanner (Play services shows the camera in its own UI, so this app
 * needs no camera permission). Exactly one of the callbacks runs, except when the person backs out.
 */
object QrScanner {
  const val UNAVAILABLE = "Scanning needs Google Play services, which this phone doesn't have. Enter the code instead."
  const val FAILED = "Couldn't open the scanner. Enter the code instead."

  fun scan(context: Context, onCode: (String) -> Unit, onUnavailable: (String) -> Unit) {
    val play = runCatching { GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) }.getOrNull()
    if (play != ConnectionResult.SUCCESS) return onUnavailable(UNAVAILABLE)
    val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
    try {
      GmsBarcodeScanning.getClient(context, options).startScan()
        .addOnSuccessListener { b -> b.rawValue?.let(onCode) ?: onUnavailable("That QR code is empty. Enter the code instead.") }
        .addOnFailureListener { onUnavailable(FAILED) }
    } catch (_: Exception) {
      onUnavailable(FAILED)
    }
  }
}
