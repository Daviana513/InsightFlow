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
  assert.match(html, /打开本地图片/);
  assert.match(html, /<nav>/);
  assert.match(html, /任务总览/);
  assert.match(html, /浏览器本地模式/);
  assert.match(html, /选择本地文件夹并开始/);
  assert.match(html, /导入审核 JSON/);
  assert.doesNotMatch(html, /启动 Local Agent/);
});
