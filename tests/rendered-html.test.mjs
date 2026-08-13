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
  assert.match(html, /<title>InsightFlow · Human Review Agent<\/title>/i);
  assert.match(html, /InsightFlow/);
  assert.match(html, /把每一次人工判断/);
  assert.match(html, /继续上次审核/);
  assert.match(html, /<nav>/);
  assert.match(html, /任务总览/);
  assert.match(html, /Local Agent/);
  assert.match(html, /公开交互预览/);
  assert.match(html, /AI 关键词候选人工验证/);
  assert.match(html, /感知哈希重复组复核/);
  assert.match(html, /GPT 信息图判断纠错/);
  assert.match(html, /导出 CSV/);
});
