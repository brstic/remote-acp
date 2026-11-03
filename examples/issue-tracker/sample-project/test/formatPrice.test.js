import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPrice } from "../src/formatPrice.js";

test("formats US dollars from cents", () => {
  assert.equal(formatPrice(1999, "USD"), "$19.99");
});

test("formats currencies without minor units", () => {
  assert.equal(formatPrice(1500, "JPY", "en-US"), "¥1,500");
});

test("rejects non-numeric amounts", () => {
  assert.throws(() => formatPrice(Number.NaN, "USD"), TypeError);
});
