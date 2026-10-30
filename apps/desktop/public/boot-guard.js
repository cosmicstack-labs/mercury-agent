/*
 * Never a blank window. If the app's code fails to load (a missing file,
 * a failed import, a crash before the first render), show what happened
 * and a way out, instead of an empty screen. main.tsx sets
 * window.__mercuryBooted once the app has started.
 */
(function () {
  // The voice capsule is a tiny see-through window: nothing to show there.
  if (/[?&]surface=notch\b/.test(location.search)) return;
  var problem = null;
  function show() {
    if (window.__mercuryBooted || document.getElementById("boot-failure")) return;
    var dark = !window.matchMedia || window.matchMedia("(prefers-color-scheme: dark)").matches;
    var box = document.createElement("div");
    box.id = "boot-failure";
    box.setAttribute("role", "alert");
    box.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      (dark ? "background:#0b0d0c;color:#e6e8e7" : "background:#fafafa;color:#1a1c1b");
    var card = document.createElement("div");
    card.style.cssText = "max-width:460px;text-align:center";
    var title = document.createElement("div");
    title.textContent = "Mercury couldn't start";
    title.style.cssText = "font-size:17px;font-weight:600;margin-bottom:8px";
    var detail = document.createElement("div");
    detail.textContent = problem || "The app took too long to load.";
    detail.style.cssText = "opacity:.7;margin-bottom:18px;word-break:break-word;font-family:ui-monospace,monospace;font-size:12px";
    var button = document.createElement("button");
    button.textContent = "Reload";
    button.style.cssText = "padding:8px 18px;border-radius:8px;border:0;background:#22C98B;color:#06110c;font-weight:600;cursor:pointer";
    button.onclick = function () { location.reload(); };
    card.appendChild(title);
    card.appendChild(detail);
    card.appendChild(button);
    box.appendChild(card);
    document.body.appendChild(box);
  }
  function fail(message) {
    if (window.__mercuryBooted) return;
    problem = problem || message;
    show();
  }
  // Capture also catches a script that couldn't be fetched.
  window.addEventListener("error", function (e) {
    var target = e.target;
    if (target && target !== window && target.tagName === "SCRIPT") fail("Couldn't load " + (target.src || "the app's code") + ".");
    else if (e.message) fail(e.message);
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    fail(r && r.message ? r.message : String(r));
  });
  setTimeout(show, 15000);
})();
