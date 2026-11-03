import { describe, expect, it } from "vitest";
import { connectionState } from "../src/app.js";
import { DOC_TYPES, buildDocPrompt, cleanNotes, docType } from "../src/docs.js";
import { friendlyError } from "../src/errors.js";

describe("friendly errors", () => {
  it("explains every documented error code", () => {
    for (const code of [
      "desktop_offline",
      "connection_revoked",
      "connection_paused",
      "connection_expired",
      "task_in_progress",
      "declined",
      "approval_timeout",
      "bridge_paused",
      "policy_blocked",
      "not_connected",
    ]) {
      const f = friendlyError(code);
      expect(f.title, code).not.toBe("Something went wrong");
      expect(f.message.length, code).toBeGreaterThan(20);
    }
    expect(friendlyError("declined").message).toContain("nothing was changed");
    expect(friendlyError("connection_paused").message).toContain("Resume");
    expect(friendlyError("connection_revoked").reconnect).toBe(true);
    expect(friendlyError("desktop_offline").reconnect).toBeUndefined();
  });

  it("falls back to the relay message for unknown codes", () => {
    expect(friendlyError("weird_code", "Relay said no")).toEqual({ title: "Something went wrong", message: "Relay said no" });
    expect(friendlyError("weird_code").message).toBe("Error: weird_code");
  });
});

describe("connection state", () => {
  const base = { connectionId: "conn_1", externalUserId: "u", provider: "Test agent", scopes: [], expiresAt: "", createdAt: "" };
  it("maps relay status + online to one state", () => {
    expect(connectionState(null)).toBe("none");
    expect(connectionState({ ...base, status: "active", online: true })).toBe("online");
    expect(connectionState({ ...base, status: "active", online: false })).toBe("offline");
    expect(connectionState({ ...base, status: "paused", online: true })).toBe("paused");
    expect(connectionState({ ...base, status: "revoked", online: true })).toBe("revoked");
    expect(connectionState({ ...base, status: "expired", online: false })).toBe("expired");
  });
});

describe("doc prompts", () => {
  it("asks to write exactly one file and to request permission", () => {
    for (const d of DOC_TYPES) {
      const p = buildDocPrompt(d, "");
      expect(p).toContain(`Write the complete file to \`${d.file}\``);
      expect(p).toContain("This is the only file you may create or change.");
      expect(p.toLowerCase()).toContain("permission");
      // No other test-agent scenario keyword, so the mock deterministically takes the permission path.
      for (const k of ["slow", "crash", "noise", "flood", "secret"]) expect(p.toLowerCase(), `${d.id}: ${k}`).not.toContain(k);
    }
  });

  it("fences and cleans notes; rejects unknown types", () => {
    const p = buildDocPrompt(docType("changelog")!, cleanNotes("Tone: friendly\u0007 ```x```"));
    expect(p).toContain("```text\nTone: friendly '''x'''\n```");
    expect(docType("license")).toBeUndefined();
  });
});
