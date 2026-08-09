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
  assert.match(html, /<title>InsightFlow · Local-first Image Screening<\/title>/i);
  assert.match(html, /InsightFlow/);
  assert.match(html, /把一次大规模筛选/);
  assert.match(html, /继续示例任务/);
  assert.match(html, /<nav aria-label="InsightFlow 主导航"/);
  assert.match(html, /任务总览/);
  assert.match(html, /Local Agent/);
  assert.match(html, /Public Preview/);
  assert.match(html, /OpenCLIP/);
  assert.match(html, /GPT-5\.5/);
  assert.match(html, /来源凭证/);
  assert.match(html, /外部风险检测/);
  assert.match(html, /Final Dataset/);
  assert.match(html, /人工待审队列/);
  assert.match(html, /异常与待处理/);
});
