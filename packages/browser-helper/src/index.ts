/**
 * Browser-only helpers for displaying a Remote ACP Bridge pairing challenge.
 *
 * This package never sees service secrets. Your backend creates the pairing
 * with `@remote-acp/web-sdk` and hands the browser only `{url, code, expiresAt}`.
 */

export interface PairingDisplay {
  /** `remoteacp://pair?...` deep link returned by your backend. */
  url: string;
  /** Pairing code, e.g. `ABCDE-12345`. */
  code: string;
  /** ISO timestamp. */
  expiresAt: string;
}

const CODE_ALPHABET = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/**
 * Normalize user/relay input into the canonical `XXXXX-XXXXX` form
 * (Crockford base32: case-insensitive, O->0, I/L->1, separators ignored).
 * Returns the cleaned input unchanged if it is not a 10-character code.
 */
export function formatCode(input: string): string {
  const c = input
    .replace(/[^0-9a-z]/gi, "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return c.length === 10 ? `${c.slice(0, 5)}-${c.slice(5)}` : c;
}

/** True if `code` is a well-formed pairing code (after normalization). */
export function isValidCode(code: string): boolean {
  return CODE_ALPHABET.test(formatCode(code).replace("-", ""));
}

/** True for `remoteacp://pair?ticket=...` links. Rejects every other scheme. */
export function isPairingUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "remoteacp:" && (u.host === "pair" || u.pathname.replace(/^\/+/, "") === "pair") && !!u.searchParams.get("ticket");
  } catch {
    return false;
  }
}

export interface OpenPairingOptions {
  /** Window to navigate (defaults to the global `window`). */
  win?: Pick<Window, "location" | "addEventListener" | "removeEventListener" | "setTimeout" | "clearTimeout"> & {
    document?: Pick<Document, "visibilityState" | "hasFocus">;
  };
  /**
   * Called if the page still has focus after `fallbackMs` — usually meaning
   * the desktop app is not installed. Show the code / install instructions.
   */
  onNotOpened?: () => void;
  fallbackMs?: number;
}

/**
 * Open the desktop app via its deep link. Only `remoteacp://pair` links are
 * accepted so this can never be abused to navigate elsewhere.
 */
export function openPairingLink(url: string, opts: OpenPairingOptions = {}): void {
  if (!isPairingUrl(url)) throw new Error("Not a Remote ACP pairing link");
  const win = opts.win ?? window;
  if (opts.onNotOpened) {
    let blurred = false;
    const onBlur = () => {
      blurred = true;
    };
    win.addEventListener("blur", onBlur);
    win.setTimeout(() => {
      win.removeEventListener("blur", onBlur);
      const hidden = win.document?.visibilityState === "hidden";
      if (!blurred && !hidden) opts.onNotOpened?.();
    }, opts.fallbackMs ?? 1500);
  }
  win.location.href = url;
}

/** Seconds until `expiresAt` (never negative). */
export function secondsUntil(expiresAt: string, now: number = Date.now()): number {
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.ceil((t - now) / 1000));
}

/** `m:ss` countdown label. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export interface RenderPairingOptions {
  labels?: {
    button?: string;
    codeHint?: string;
    copy?: string;
    copied?: string;
    expiresIn?: string;
    expired?: string;
  };
  /** Called once when the countdown reaches zero. */
  onExpire?: () => void;
  /** Called when the user clicks the open button (after navigation starts). */
  onOpen?: () => void;
  /** Called if the app did not seem to open (see {@link openPairingLink}). */
  onNotOpened?: () => void;
}

export interface PairingHandle {
  /** Stop the countdown and remove the rendered elements. */
  destroy(): void;
  readonly root: HTMLElement;
}

/**
 * Render an accessible pairing widget into `container`:
 * an "Open desktop app" link-button, the code with a copy button, and an
 * expiry countdown. Uses only text nodes (no innerHTML) for untrusted values.
 * Style it via the `rab-*` class names.
 */
export function renderPairing(container: HTMLElement, pairing: PairingDisplay, opts: RenderPairingOptions = {}): PairingHandle {
  if (!isPairingUrl(pairing.url)) throw new Error("Not a Remote ACP pairing link");
  const doc = container.ownerDocument;
  const L = {
    button: "Open desktop app",
    codeHint: "Or enter this code in Remote ACP Bridge",
    copy: "Copy",
    copied: "Copied",
    expiresIn: "Expires in",
    expired: "This link has expired",
    ...opts.labels,
  };
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
    const e = doc.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const root = el("div", "rab-pairing");
  const link = el("a", "rab-open", L.button);
  link.href = pairing.url;
  link.setAttribute("role", "button");
  link.addEventListener("click", (ev) => {
    ev.preventDefault();
    if (root.dataset.expired === "true") return;
    openPairingLink(pairing.url, opts.onNotOpened ? { onNotOpened: opts.onNotOpened } : {});
    opts.onOpen?.();
  });

  const codeRow = el("div", "rab-code-row");
  const hint = el("div", "rab-code-hint", L.codeHint);
  const code = el("code", "rab-code", formatCode(pairing.code));
  code.setAttribute("aria-label", `Pairing code ${formatCode(pairing.code).split("").join(" ")}`);
  const copy = el("button", "rab-copy", L.copy);
  copy.type = "button";
  copy.addEventListener("click", () => {
    const clip = doc.defaultView?.navigator?.clipboard;
    if (!clip) return;
    void clip.writeText(formatCode(pairing.code)).then(() => {
      copy.textContent = L.copied;
      doc.defaultView?.setTimeout(() => (copy.textContent = L.copy), 1500);
    });
  });
  codeRow.append(code, copy);

  const countdown = el("div", "rab-countdown");
  countdown.setAttribute("aria-live", "polite");
  root.append(link, hint, codeRow, countdown);
  container.append(root);

  let expiredFired = false;
  const tick = () => {
    const left = secondsUntil(pairing.expiresAt);
    if (left <= 0) {
      countdown.textContent = L.expired;
      root.dataset.expired = "true";
      link.setAttribute("aria-disabled", "true");
      if (!expiredFired) {
        expiredFired = true;
        opts.onExpire?.();
      }
      return false;
    }
    countdown.textContent = `${L.expiresIn} ${formatCountdown(left)}`;
    return true;
  };
  const view = doc.defaultView;
  let timer: number | undefined;
  if (tick() && view) {
    timer = view.setInterval(() => {
      if (!tick() && timer !== undefined) view.clearInterval(timer);
    }, 1000);
  }

  return {
    root,
    destroy() {
      if (timer !== undefined) view?.clearInterval(timer);
      root.remove();
    },
  };
}
