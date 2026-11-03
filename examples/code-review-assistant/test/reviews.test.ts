import { describe, expect, it } from "vitest";
import { MAX_FOCUS_CHARS, REVIEW_TYPES, buildPrompt, cleanFocus, reviewType } from "../src/reviews.js";

describe("review prompts", () => {
  it("builds a structured, read-only prompt per type", () => {
    for (const t of REVIEW_TYPES) {
      const p = buildPrompt(t, "");
      expect(p.startsWith(`Code review request: ${t.title}.`)).toBe(true);
      expect(p).toContain("do not create, modify or delete files");
      for (const s of t.sections) expect(p).toContain(`- ${s}`);
      expect(p).not.toContain("Focus notes");
    }
  });

  it("fences focus notes as data", () => {
    const p = buildPrompt(reviewType("bugs")!, "look at the cache");
    expect(p).toContain("## Focus notes from the user\n");
    expect(p).toContain("```text\nlook at the cache\n```");
  });

  it("cleans focus notes", () => {
    expect(cleanFocus("  a\u0000b\r\nc\u001b  ")).toBe("ab\nc");
    expect(cleanFocus("```js\nx\n```")).toBe("'''js\nx\n'''");
    expect(cleanFocus("x".repeat(5000))).toHaveLength(MAX_FOCUS_CHARS);
    expect(cleanFocus(42)).toBe("");
  });

  it("only accepts known review types", () => {
    expect(reviewType("security")?.title).toBe("Security review");
    expect(reviewType("__proto__")).toBeUndefined();
    expect(reviewType(undefined)).toBeUndefined();
  });

  it("templates avoid the test agent's scenario keywords (so the E2E echo is deterministic)", () => {
    for (const t of REVIEW_TYPES) {
      const p = buildPrompt(t, "").toLowerCase();
      for (const k of ["permission", "slow", "crash", "noise", "flood", "secret"]) expect(p, `${t.id}: ${k}`).not.toContain(k);
      expect(p.startsWith("read ") || p.startsWith("leak ")).toBe(false);
    }
  });
});
