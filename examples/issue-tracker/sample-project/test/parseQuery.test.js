import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery } from "../src/parseQuery.js";

test("parses simple pairs and decodes plus signs", () => {
  assert.deepEqual({ ...parseQuery("?q=red+shoes&page=2") }, { q: "red shoes", page: "2" });
});

test("collects repeated keys into arrays", () => {
  assert.deepEqual({ ...parseQuery("tag=sale&tag=new") }, { tag: ["sale", "new"] });
});

test("handles empty input", () => {
  assert.deepEqual({ ...parseQuery("") }, {});
});
