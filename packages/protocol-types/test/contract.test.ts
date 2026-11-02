import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ENVELOPE_KINDS,
  isTaskEvent,
  isTaskStreamEvent,
  validateEnvelope,
  type Sender,
} from "../src/index.js";

const contractDir = join(dirname(fileURLToPath(import.meta.url)), "../../../tests/contract");

interface Fixture {
  sender: Sender;
  valid: boolean;
  envelope: Record<string, unknown>;
}

const fixtures = readdirSync(contractDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ file: f, fx: JSON.parse(readFileSync(join(contractDir, f), "utf8")) as Fixture }));

describe("contract fixtures (tests/contract/*.json)", () => {
  it("found the fixture directory", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(7);
    expect(fixtures.some((f) => f.fx.valid)).toBe(true);
    expect(fixtures.some((f) => !f.fx.valid)).toBe(true);
  });

  for (const { file, fx } of fixtures) {
    it(`${file}: valid=${fx.valid} from ${fx.sender}`, () => {
      const res = validateEnvelope(fx.envelope, fx.sender);
      expect(res.ok, JSON.stringify(res)).toBe(fx.valid);
    });
  }

  it("invalid fixtures are rejected by the kind allowlist (unknown kind or wrong sender)", () => {
    for (const { file, fx } of fixtures.filter((f) => !f.fx.valid)) {
      const res = validateEnvelope(fx.envelope, fx.sender);
      expect(res.ok, file).toBe(false);
      if (!res.ok) expect(res.error, file).toMatch(/unknown message kind|not permitted from this sender/);
    }
  });
});

describe("validateEnvelope details", () => {
  const base = {
    version: 1,
    id: "msg_1",
    connectionId: "conn_1",
    taskId: "task_1",
    sequence: 1,
    createdAt: "2026-11-02T19:00:00Z",
  };

  it("rejects unsupported versions and bad ids", () => {
    expect(validateEnvelope({ ...base, version: 2, kind: "heartbeat", payload: {} }, "desktop").ok).toBe(false);
    expect(validateEnvelope({ ...base, taskId: "../../etc", kind: "task.accepted", payload: {} }, "desktop").ok).toBe(false);
  });

  it("requires task scoping for task kinds", () => {
    const { taskId: _t, ...noTask } = base;
    expect(validateEnvelope({ ...noTask, kind: "task.accepted", payload: {} }, "desktop").ok).toBe(false);
    expect(validateEnvelope({ ...base, kind: "task.accepted", payload: {} }, "desktop").ok).toBe(true);
  });

  it("relay cannot send task events; desktop can", () => {
    const env = { ...base, kind: "task.event", payload: { type: "text_delta", text: "x" } };
    expect(validateEnvelope(env, "relay").ok).toBe(false);
    expect(validateEnvelope(env, "desktop").ok).toBe(true);
  });

  it("knows every Rust Body kind", () => {
    expect(ENVELOPE_KINDS).toHaveLength(13);
  });

  it("rejects unknown task event types and bad payloads", () => {
    expect(isTaskEvent({ type: "exec", cmd: "x" })).toBe(false);
    expect(isTaskEvent({ type: "permission_resolved", requestId: "p", outcome: "maybe" })).toBe(false);
    expect(isTaskEvent({ type: "tool_call_update", toolCallId: "t" })).toBe(true);
    expect(isTaskEvent({ type: "plan", entries: [{ content: "a", status: "pending" }] })).toBe(true);
  });

  it("guards relay SSE data objects", () => {
    expect(isTaskStreamEvent({ seq: 3, kind: "task.event", payload: { type: "text_delta", text: "hi" } })).toBe(true);
    expect(isTaskStreamEvent({ seq: 4, kind: "task.completed", payload: { stopReason: "end_turn" } })).toBe(true);
    expect(isTaskStreamEvent({ seq: 0, kind: "task.accepted", payload: {} })).toBe(false);
    expect(isTaskStreamEvent({ seq: 1, kind: "permission.response", payload: {} })).toBe(false);
  });
});
