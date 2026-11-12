# Optional isolated browser reader

Mercury can use an **already installed** Chrome, Chromium, or Edge to render public pages and inspect their text, links, and viewport screenshot. It is off by default. No browser engine or additional package is downloaded.

Add this optional block under `capabilities` in your Mercury `permissions.yaml`, then restart Mercury:

```yaml
capabilities:
  browser:
    enabled: true
    # Optional absolute executable path if automatic discovery fails:
    # executable: /usr/bin/google-chrome
    # executable: 'C:\Program Files\Google\Chrome\Application\chrome.exe'
```

An owner chat then has three tools:

| Tool | Behavior |
| --- | --- |
| `browser_navigate` | Ask the owner before opening a public HTTP(S) URL; return a bounded snapshot. |
| `browser_snapshot` | Inspect the page already opened in this chat. |
| `browser_close` | Close this chat’s browser and delete its temporary profile. |

Each chat owns a separate temporary profile and browser process. Mercury never attaches to an existing browser, debugging port, or personal profile. Two chats can have browsers open at once; idle browsers close after five minutes. Cancellation or a failed operation discards that browser session. A failed process termination retains the occupied slot and network guard until cleanup succeeds. Normal Mercury shutdown closes all its browsers.

This is a **read-only page renderer**, not interactive browser automation. Page JavaScript, frames, workers, form submission, login, downloads, cookies and click/type actions are disabled. Sites that need JavaScript or authentication may show incomplete or unavailable content. Text-only models receive text and links; image-capable models also receive a transient viewport image. Screenshots are not written into chat history or disk. Page content is untrusted, including any instructions it displays.

The reader is unavailable to members, bots, delegated workers, scheduled/internal turns and plan mode. Its identity is the canonical session supplied by Mercury, never a model-provided session ID. Navigation always asks for approval, even if a session previously allowed other tools.

## Network and resource boundary

Chromium uses an inherited CDP pipe, with its sandbox enabled and a fresh empty environment/profile. Native browser HTTP, CONNECT and WebSocket traffic goes to a loopback deny-all proxy; loopback proxy bypass, QUIC and non-proxied WebRTC UDP are disabled. Native DNS resolution is disabled. There is no browser debugging TCP listener.

The page’s supported requests are intercepted before loading. Mercury supplies responses using fresh Node HTTP(S) GET connections, pins each connection to its validated public DNS answer, rejects mixed/private/special-use DNS results, and rechecks every redirect. This path does not honor proxy environment variables or `MERCURY_ALLOW_PRIVATE_FETCH`. URL credentials, non-default ports and non-HTTP(S) URLs are refused. Only supported static response types are rendered; cookies, authentication and active response headers are not forwarded. An additional sandbox CSP disables scripts, forms, frames, workers, connections and plugins.

One navigation is limited to 20 seconds, 40 resource requests, 8 concurrent requests, 5 redirects, 2 MB per resource and 8 MB of response bodies overall. A shared streaming budget counts failed transfers too and cancels every active response when exhausted. These limits bound application body processing; the network stack can have additional data buffered when a connection is stopped. A snapshot includes at most 12,000 text characters, 40 links and a 1280×800 JPEG capped at 1.5 MB base64. Protocol messages and pending requests are bounded. Failed required CDP security commands prevent startup.

The isolation boundary protects ordinary web content; it is not a substitute for Chromium security updates or an OS container against a compromised browser executable. An abrupt machine/process crash can leave a temporary directory behind. Only newly created Mercury profiles are ever removed.

## Verification

The standard suite covers permission and ownership checks, missing/private/mixed DNS results, launch arguments, Windows executable paths, child/bot exclusion and transient image handling. The optional installed-browser suite uses public-origin URLs mapped to a local test server by a test-only transport dependency; production has no private-network bypass:

```sh
MERCURY_TEST_BROWSER=1 npm test -- src/capabilities/browser/reader.integration.test.ts --maxWorkers=1
```

It checks real Chromium rendering, hostile page scripts/frames/private resources, redirects, downloads, aggregate resource limits, concurrent chat isolation, capacity, cancellation and temporary-profile cleanup. CI runs this opt-in suite on Linux and Windows using their preinstalled browsers, then compiles and runs `scripts/smoke-isolated-browser.ts` with the same Bun runtime used for standalone Mercury. Native Windows results must come from that job; Node/Linux results alone do not establish Windows desktop process/pipe behavior. Older Bun versions have had Windows CDP-pipe bugs; use a current runtime/build, and treat a failed startup as unavailable instead of disabling the sandbox or switching to a debugging port.
