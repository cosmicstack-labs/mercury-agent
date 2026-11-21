# CAPTCHA Solver for Mercury

Solves CAPTCHAs Mercury runs into while doing your tasks. Cheapest first:

1. **Your own models** read image CAPTCHAs for free: any provider you set up
   in Mercury that can see images (OpenAI, Anthropic, Gemini, OpenRouter,
   Ollama, any OpenAI-compatible server). Two of them must read the same
   text, because one model alone misreads often enough to fail a login. Some
   models refuse to read CAPTCHAs (OpenAI's do); they're skipped.
2. **A solving service** with your own key: 2Captcha (default), CapSolver,
   Anti-Captcha or CapMonster Cloud. Handles image CAPTCHAs, reCAPTCHA v2/v3
   (and Enterprise), Cloudflare Turnstile and GeeTest; FunCaptcha on 2Captcha
   and Anti-Captcha.
3. **You.** The CAPTCHA arrives on your phone, chats and Mercury Desktop.
   Type what you see (reply `<code> <answer>`), or, for checkbox CAPTCHAs that
   can't be solved from a picture, open the page, finish it there, and reply
   `<code> done`. Bots never ask you; they stop after step 2.

It answers CAPTCHAs; it doesn't disguise browsers or get around bot-detection
systems. Use it for your own accounts and tasks, within the sites' terms.

## Set up

```sh
mercury plugins install captcha
```

Pick a service and paste its key, or choose **No service** to use only your
models and you. Change anything with `/plugins captcha`.

| Setting | Default | |
|---|---|---|
| Service | 2Captcha | or CapSolver, Anti-Captcha, CapMonster Cloud, none |
| Try my own models first | on | image CAPTCHAs only |
| Ask me when nothing else works | on | never in bot runs |
| Wait for me | 3 min | 1–4 |
| Paid solves per day | 50 | 0 turns the service off |

## Tools

- `captcha__detect`: finds CAPTCHAs in a page's HTML, with their site keys
  and the exact arguments to solve them.
- `captcha__solve`: returns the text or token, which method solved it, and
  the cost. Tokens come with an `inject` script for the page and expire in
  about two minutes.
- `captcha__balance`: the service balance and today's solves.

## Notes

- **hCaptcha:** 2Captcha, CapSolver and Anti-Captcha no longer solve it.
  CapMonster may. Otherwise it comes to you.
- **Token CAPTCHAs** (reCAPTCHA, Turnstile) are tied to the page that shows
  them. A token is only useful to automation that controls that page, such
  as a Playwright script.
- **What each service is sent:** the image, or the page address and site key.
