# @remote-acp/browser-helper

Tiny, dependency-free, browser-only helpers for showing a Remote ACP Bridge pairing challenge.
It contains **no secrets** and never talks to the relay: your backend creates the pairing with
`@remote-acp/web-sdk` and returns only `{ url, code, expiresAt }` to the browser.

```ts
import { renderPairing, openPairingLink, formatCode } from "@remote-acp/browser-helper";

const { url, code, expiresAt } = await (await fetch("/api/pairings", { method: "POST" })).json();
const handle = renderPairing(document.querySelector("#pair")!, { url, code, expiresAt }, {
  onExpire: () => showRetry(),
  onNotOpened: () => showInstallHint(),
});
// later: handle.destroy();
```

- `renderPairing(container, pairing, opts)` — "Open desktop app" link-button, the code with a copy
  button, and an expiry countdown. Text-only DOM (no `innerHTML`). Style via `rab-*` classes.
- `openPairingLink(url, {onNotOpened?})` — navigates to a `remoteacp://pair?...` link (any other
  scheme throws); optionally reports when the page kept focus (app probably not installed).
- `formatCode`, `isValidCode`, `isPairingUrl`, `secondsUntil`, `formatCountdown`.

QR codes are intentionally not included.

The built `dist/index.js` is a plain ES module and can be served to browsers directly
(the web demo does this).

```sh
pnpm --filter @remote-acp/browser-helper build
pnpm --filter @remote-acp/browser-helper test   # vitest + happy-dom
```
