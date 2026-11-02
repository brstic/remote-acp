import { describe, expect, it } from "vitest";
import { SseParser, parseSseStream } from "../src/sse.js";

function feedAll(chunks: string[]) {
  const p = new SseParser();
  return chunks.flatMap((c) => p.feed(c));
}

describe("SseParser", () => {
  it("parses id/event/data blocks like the relay sends", () => {
    const msgs = feedAll([`id: 1\nevent: task.accepted\ndata: {"seq":1,"kind":"task.accepted","payload":{}}\n\n`]);
    expect(msgs).toEqual([{ id: "1", event: "task.accepted", data: '{"seq":1,"kind":"task.accepted","payload":{}}' }]);
  });

  it("joins multi-line data with \\n", () => {
    const msgs = feedAll(["data: line one\ndata: line two\ndata:\ndata:  indented\n\n"]);
    expect(msgs[0]!.data).toBe("line one\nline two\n\n indented");
    expect(msgs[0]!.event).toBe("message");
  });

  it("ignores comments / keep-alives and blocks without data", () => {
    const msgs = feedAll([":\n\n: keep-alive\n\nevent: noop\n\nid: 7\n\ndata: x\n\n"]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ data: "x", id: "7", event: "message" });
  });

  it("handles CRLF and lone CR line endings, including CRLF split across chunks", () => {
    const crlf = feedAll(["id: 2\r\nevent: a\r\ndata: one\r", "\n\r", "\ndata: two\r\n\r\n"]);
    expect(crlf).toEqual([
      { id: "2", event: "a", data: "one" },
      { id: "2", event: "message", data: "two" },
    ]);
    const cr = feedAll(["data: x\r\rdata: y\r\r"]);
    expect(cr.map((m) => m.data)).toEqual(["x", "y"]);
  });

  it("handles fields split at arbitrary byte boundaries", () => {
    const text = `id: 12\nevent: task.event\ndata: {"seq":12}\n\n`;
    const chunks = text.split("");
    const msgs = feedAll(chunks);
    expect(msgs).toEqual([{ id: "12", event: "task.event", data: '{"seq":12}' }]);
  });

  it("strips a leading BOM, removes only one space after the colon, field without colon", () => {
    const msgs = feedAll(["﻿data:  two spaces\ndata\n\n"]);
    expect(msgs[0]!.data).toBe(" two spaces\n");
  });

  it("keeps last id across messages and parses retry", () => {
    const msgs = feedAll(["retry: 3000\nid: 5\ndata: a\n\ndata: b\n\nretry: nope\ndata: c\n\n"]);
    expect(msgs.map((m) => [m.id, m.retry])).toEqual([
      ["5", 3000],
      ["5", 3000],
      ["5", 3000],
    ]);
  });

  it("drops an incomplete trailing message", () => {
    expect(feedAll(["data: complete\n\ndata: partial"]).map((m) => m.data)).toEqual(["complete"]);
  });
});

describe("parseSseStream", () => {
  it("decodes UTF-8 split across chunks", async () => {
    const bytes = new TextEncoder().encode("data: héllo ✓\n\n");
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const b of bytes) c.enqueue(new Uint8Array([b]));
        c.close();
      },
    });
    const out = [];
    for await (const m of parseSseStream(stream)) out.push(m.data);
    expect(out).toEqual(["héllo ✓"]);
  });
});
