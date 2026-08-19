import assert from "node:assert/strict";
import test from "node:test";
import { parseCandidateData, parseCsv, toCsv } from "../app/local-review.ts";

test("parses quoted CSV fields and embedded newlines", () => {
  const rows = parseCsv('id,image_path,caption\r\n1,a.jpg,"hello, world"\r\n2,b.jpg,"two\nlines"');
  assert.deepEqual(rows, [
    { id: "1", image_path: "a.jpg", caption: "hello, world" },
    { id: "2", image_path: "b.jpg", caption: "two\nlines" },
  ]);
});

test("accepts candidate JSON arrays and round-trips CSV", () => {
  const rows = parseCandidateData("items.json", JSON.stringify([{ id: 1, tags: ["a", "b"] }]));
  assert.deepEqual(rows, [{ id: "1", tags: '["a","b"]' }]);
  assert.match(toCsv(rows), /"\[""a"",""b""\]"/);
});
