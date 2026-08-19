import assert from "node:assert/strict";
import test from "node:test";
import { guessField, parseCandidateData, parseCsv, toCsv } from "../app/local-review.ts";

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

test("recognizes full post text and permalink fields", () => {
  const headers = ["record_id", "full_caption", "permalink"];
  assert.equal(guessField(headers, ["caption", "post_text", "text"]), "full_caption");
  assert.equal(guessField(headers, ["post_url", "permalink", "post_link", "source_url", "url", "link"]), "permalink");
});
