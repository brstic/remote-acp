import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatCode,
  formatCountdown,
  isPairingUrl,
  isValidCode,
  openPairingLink,
  renderPairing,
  secondsUntil,
} from "../src/index.js";

const URL_OK = "remoteacp://pair?ticket=abc123&relay=http%3A%2F%2F127.0.0.1%3A8787";

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("formatCode", () => {
  it("normalizes like the relay (case, separators, O/I/L)", () => {
    expect(formatCode("abcde12345")).toBe("ABCDE-12345");
    expect(formatCode(" abcd o-1234 l ")).toBe("ABCD0-12341");
    expect(formatCode("ABCDE-12345")).toBe("ABCDE-12345");
    expect(formatCode("short")).toBe("SH0RT");
    expect(isValidCode("ABCDE-12345")).toBe(true);
    expect(isValidCode("ABCDU-12345")).toBe(false); // U is not Crockford
  });
});

describe("pairing links", () => {
  it("accepts only remoteacp://pair links with a ticket", () => {
    expect(isPairingUrl(URL_OK)).toBe(true);
    expect(isPairingUrl("remoteacp://pair")).toBe(false);
    expect(isPairingUrl("https://evil.example/pair?ticket=x")).toBe(false);
    expect(isPairingUrl("javascript:alert(1)")).toBe(false);
  });

  it("openPairingLink navigates and reports when the app did not open", () => {
    vi.useFakeTimers();
    const listeners: Record<string, () => void> = {};
    const win = {
      location: { href: "" },
      addEventListener: (n: string, f: () => void) => (listeners[n] = f),
      removeEventListener: () => undefined,
      setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
      clearTimeout: (t: number) => clearTimeout(t),
      document: { visibilityState: "visible", hasFocus: () => true },
    };
    const onNotOpened = vi.fn();
    openPairingLink(URL_OK, { win: win as never, onNotOpened, fallbackMs: 1000 });
    expect(win.location.href).toBe(URL_OK);
    vi.advanceTimersByTime(1001);
    expect(onNotOpened).toHaveBeenCalledOnce();

    const opened = vi.fn();
    openPairingLink(URL_OK, { win: win as never, onNotOpened: opened, fallbackMs: 1000 });
    listeners.blur?.();
    vi.advanceTimersByTime(1001);
    expect(opened).not.toHaveBeenCalled();
    expect(() => openPairingLink("https://evil.example", { win: win as never })).toThrow();
  });
});

describe("countdown", () => {
  it("formats remaining time", () => {
    expect(secondsUntil(new Date(10_500).toISOString(), 0)).toBe(11);
    expect(secondsUntil("garbage")).toBe(0);
    expect(formatCountdown(125)).toBe("2:05");
    expect(formatCountdown(-3)).toBe("0:00");
  });
});

describe("renderPairing", () => {
  it("renders link, code and countdown, then expires", () => {
    vi.useFakeTimers({ now: 0 });
    const onExpire = vi.fn();
    const h = renderPairing(document.body, { url: URL_OK, code: "abcde12345", expiresAt: new Date(2_000).toISOString() }, { onExpire });
    const a = document.querySelector<HTMLAnchorElement>(".rab-open")!;
    expect(a.getAttribute("href")).toBe(URL_OK);
    expect(document.querySelector(".rab-code")!.textContent).toBe("ABCDE-12345");
    expect(document.querySelector(".rab-countdown")!.textContent).toBe("Expires in 0:02");
    vi.advanceTimersByTime(2_100);
    expect(document.querySelector(".rab-countdown")!.textContent).toBe("This link has expired");
    expect(h.root.dataset.expired).toBe("true");
    expect(onExpire).toHaveBeenCalledOnce();
    h.destroy();
    expect(document.querySelector(".rab-pairing")).toBeNull();
  });

  it("refuses non-pairing URLs and never injects HTML", () => {
    expect(() => renderPairing(document.body, { url: "https://x", code: "x", expiresAt: "" })).toThrow();
    renderPairing(document.body, { url: URL_OK, code: "<img src=x onerror=alert(1)>", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(document.querySelector("img")).toBeNull();
  });
});
