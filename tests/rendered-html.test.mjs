import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the InsightFlow product shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>InsightFlow · Reproducible Data Screening<\/title>/i);
  assert.match(html, /InsightFlow/);
  assert.match(html, /上传与前期预处理/);
  assert.match(html, /type="file"/);
  assert.match(html, /新建 \/ 上传/);
  assert.match(html, /<nav class="pipeline"/);
  assert.match(html, /<button class="stage-step current"/);
  assert.match(html, /OpenCLIP/);
  assert.match(html, /GPT-5\.5/);
  assert.match(html, /C2PA/);
  assert.match(html, /腾讯云/);
  assert.match(html, /Final Dataset/);
  assert.match(html, /Local Demo/);
});
