import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.js";

test("joins words with dashes", () => {
  assert.equal(slugify("blue mug"), "blue-mug");
});

test("strips accents", () => {
  assert.equal(slugify("cafe creme"), "cafe-creme");
  assert.equal(slugify("crème brûlée"), "creme-brulee");
});

test("trims leading and trailing separators", () => {
  assert.equal(slugify("  tea pot  "), "tea-pot");
});
