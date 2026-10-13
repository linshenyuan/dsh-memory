/**
 * 面板 HTTP 传输层测试（lib/ui/route.js）。
 *
 * 这一层为什么必须测：面板和磁盘之间的唯一通道就是它，而它出错的方式**全是
 * 静默或误导性的** —— 路由没挂上，浏览器只看到 `HTTP 405`；信封少一个字段，
 * 浏览器只看到 TypeError。所以这里不测「函数被调用了」，而是真的把一次
 * `client-request` 穿过去，逐个断言状态码与响应体形状。
 *
 * 线上格式对齐的是 dsh-client-connection 的 `rpcFetchHandler` / `bridge`：
 * 404（非 POST / 无 endpoint）、415（content-type）、400（非 JSON）、
 * 200 + gateway/bad-request（信封非法 / method 不匹配）、500（处理器抛穿）、
 * 200 + server-response（成功）。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { endpointFromPath, httpBridge, mountRpcRoute, rpcFetchHandler } from "../lib/ui/route.js";

const CHANNEL = "/dsh-memory";

/** 造一个 fetch 形状的请求。 */
function requestFor(endpoint, body, options = {}) {
  const { method = "POST", contentType = "application/json", headers = {} } = options;
  const init = { method, headers: { ...(contentType === null ? {} : { "content-type": contentType }), ...headers } };
  if (method === "POST") init.body = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`http://dsh.internal${CHANNEL}/${endpoint}`, init);
}

/** 造一条合法 client-request。 */
function clientRequest(endpoint, payload = {}) {
  return { type: "client-request", rpcId: "r1", method: endpoint, payload };
}

/**
 * 造一对最小的 node:http req/res。
 * @param {object} options - `{ url, method, headers, body }`。
 */
function httpExchange({ url = `${CHANNEL}/snapshot`, method = "POST", headers = {}, body = "" } = {}) {
  const chunks = body === "" ? [] : [Buffer.from(body, "utf8")];
  // `host: undefined` 用来模拟「客户端没发 Host」——值为 undefined 的头直接去掉。
  const merged = { host: "127.0.0.1:3080", ...headers };
  const req = {
    method,
    url,
    headers: Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)),
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index >= chunks.length) return { value: undefined, done: true };
          return { value: chunks[index++], done: false };
        },
      };
    },
  };
  const res = {
    status: 0,
    headers: {},
    chunks: [],
    writableEnded: false,
    writeHead(status, nextHeaders) {
      this.status = status;
      this.headers = nextHeaders;
    },
    write(chunk) {
      this.chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.chunks.push(Buffer.from(chunk));
      this.writableEnded = true;
    },
    on() {},
    once() {},
    off() {},
    text() {
      return Buffer.concat(this.chunks).toString("utf8");
    },
    json() {
      return JSON.parse(this.text());
    },
  };
  return { req, res };
}

test("endpointFromPath：只认 channel 下的合法段，段非法就整条拒掉", () => {
  assert.equal(endpointFromPath(CHANNEL, "/dsh-memory/snapshot"), "snapshot");
  assert.equal(endpointFromPath(CHANNEL, "/dsh-memory/a-b_c.d$e"), "a-b_c.d$e");
  // DSH 的实现按段校验，多段合法段是**允许**的（每一段单独过 pattern）。
  assert.equal(endpointFromPath(CHANNEL, "/dsh-memory/a/b"), "a/b");

  // 前缀不对 / 只给 channel 本身
  assert.equal(endpointFromPath(CHANNEL, "/other/snapshot"), undefined);
  assert.equal(endpointFromPath(CHANNEL, "/dsh-memory"), undefined);
  assert.equal(endpointFromPath(CHANNEL, "/dsh-memory-extra/snapshot"), undefined);

  // 段非法：空段、`.`、`..`、非法字符
  assert.equal(endpointFromPath(CHANNEL, "/dsh-memory/"), undefined);
  assert.equal(endpointFromPath(CHANNEL, "/dsh-memory/."), undefined);
  assert.equal(endpointFromPath(CHANNEL, "/dsh-memory/.."), undefined);
  assert.equal(endpointFromPath(CHANNEL, "/dsh-memory/a//b"), undefined);
  assert.equal(endpointFromPath(CHANNEL, "/dsh-memory/a/../b"), undefined);
  assert.equal(endpointFromPath(CHANNEL, "/dsh-memory/snap shot"), undefined);
  assert.equal(endpointFromPath(CHANNEL, "/dsh-memory/snap%20shot"), undefined);
});

test("rpcFetchHandler：非 POST 或路径不匹配一律 404", async () => {
  const handler = rpcFetchHandler(CHANNEL, async () => ({ ok: true, value: 1 }));

  const get = await handler.fetch(requestFor("snapshot", undefined, { method: "GET", contentType: null }));
  assert.equal(get.status, 404);

  const wrongPath = await handler.fetch(new Request("http://dsh.internal/other/snapshot", { method: "POST" }));
  assert.equal(wrongPath.status, 404);
});

test("rpcFetchHandler：content-type 不对是 415，body 不是 JSON 是 400", async () => {
  const handler = rpcFetchHandler(CHANNEL, async () => ({ ok: true, value: 1 }));

  const wrongType = await handler.fetch(requestFor("snapshot", clientRequest("snapshot"), { contentType: "text/plain" }));
  assert.equal(wrongType.status, 415);

  // 带 ; charset 的也认（DSH 那边就是这么切的）
  const withCharset = await handler.fetch(
    requestFor("snapshot", clientRequest("snapshot"), { contentType: "application/json; charset=utf-8" }),
  );
  assert.equal(withCharset.status, 200);

  const notJson = await handler.fetch(requestFor("snapshot", "这不是 JSON"));
  assert.equal(notJson.status, 400);
  assert.equal(await notJson.text(), "body is not JSON");
});

test("rpcFetchHandler：信封非法时 200 + gateway/bad-request，并尽量沿用 rpcId", async () => {
  const handler = rpcFetchHandler(CHANNEL, async () => ({ ok: true, value: 1 }));

  // type 不对
  const badType = await handler.fetch(requestFor("snapshot", { type: "server-response", rpcId: "r9", method: "snapshot" }));
  assert.equal(badType.status, 200);
  const badTypeBody = await badType.json();
  assert.equal(badTypeBody.type, "server-response");
  assert.equal(badTypeBody.rpcId, "r9", "信封非法也要沿用能读到的 rpcId，否则浏览器只会看到 rpcId mismatch");
  assert.equal(badTypeBody.result.ok, false);
  assert.equal(badTypeBody.result.error.code, "gateway/bad-request");
  assert.deepEqual(badTypeBody.result.error.details, { issues: [] });

  // 连 rpcId 都读不到 → 兜底 id
  const noId = await handler.fetch(requestFor("snapshot", { type: "client-request", method: "snapshot" }));
  assert.equal((await noId.json()).rpcId, "invalid-request");
});

test("rpcFetchHandler：method 与 endpoint 不一致时如实报错，不糊弄过去", async () => {
  const handler = rpcFetchHandler(CHANNEL, async () => ({ ok: true, value: 1 }));
  const response = await handler.fetch(requestFor("snapshot", clientRequest("resolve")));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.rpcId, "r1");
  assert.equal(body.result.ok, false);
  assert.equal(body.result.error.code, "gateway/bad-request");
  assert.match(body.result.error.message, /does not match endpoint/);
});

test("rpcFetchHandler：成功时包成 server-response，rpcId 原样带回", async () => {
  const seen = [];
  const handler = rpcFetchHandler(CHANNEL, async (endpoint, payload) => {
    seen.push({ endpoint, payload });
    return { ok: true, value: { echo: payload } };
  });

  const response = await handler.fetch(requestFor("snapshot", clientRequest("snapshot", { a: 1 })));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type")?.split(";")[0], "application/json");

  const body = await response.json();
  assert.deepEqual(body, {
    type: "server-response",
    rpcId: "r1",
    result: { ok: true, value: { echo: { a: 1 } } },
  });
  assert.deepEqual(seen, [{ endpoint: "snapshot", payload: { a: 1 } }]);
});

test("rpcFetchHandler：处理器抛穿 → 500 纯文本（不是信封）", async () => {
  const handler = rpcFetchHandler(CHANNEL, async () => {
    throw new Error("boom");
  });
  const response = await handler.fetch(requestFor("snapshot", clientRequest("snapshot")));

  assert.equal(response.status, 500);
  assert.match(await response.text(), /handler failure: Error: boom/);
});

test("httpBridge：请求体超限一律 413 并销毁 socket", async () => {
  const fetchHandler = rpcFetchHandler(CHANNEL, async () => ({ ok: true, value: 1 }));

  // 声明长度就超了 → 连读都不读
  const declared = httpExchange({
    headers: { "content-type": "application/json", "content-length": "99999" },
    body: JSON.stringify(clientRequest("snapshot")),
  });
  await httpBridge(declared.req, declared.res, fetchHandler, 16);
  assert.equal(declared.res.status, 413);
  assert.equal(declared.req.destroyed, true);
  assert.equal(declared.res.headers.connection, "close");

  // 没声明长度、流式读超了 → 同样 413
  const streamed = httpExchange({
    headers: { "content-type": "application/json" },
    body: JSON.stringify(clientRequest("snapshot", { pad: "x".repeat(200) })),
  });
  await httpBridge(streamed.req, streamed.res, fetchHandler, 16);
  assert.equal(streamed.res.status, 413);
  assert.equal(streamed.req.destroyed, true);
});

test("httpBridge：正常请求把响应写回去", async () => {
  const fetchHandler = rpcFetchHandler(CHANNEL, async () => ({ ok: true, value: 7 }));
  const { req, res } = httpExchange({
    headers: { "content-type": "application/json" },
    body: JSON.stringify(clientRequest("snapshot")),
  });

  await httpBridge(req, res, fetchHandler, 1024 * 1024);
  assert.equal(res.status, 200);
  assert.equal(res.writableEnded, true);
  assert.deepEqual(res.json().result, { ok: true, value: 7 });
});

test("mountRpcRoute：注册一条 prefix 路由，返回幂等清理函数", () => {
  const registered = [];
  const webServer = {
    register(route) {
      registered.push(route);
      return () => registered.pop();
    },
  };

  const dispose = mountRpcRoute({
    webServer,
    connection: { requestRejection: () => undefined },
    channel: CHANNEL,
    handler: async () => ({ ok: true, value: 1 }),
  });

  assert.equal(registered.length, 1);
  assert.equal(registered[0].kind, "prefix");
  assert.equal(registered[0].path, CHANNEL);
  assert.equal(typeof registered[0].handler, "function");

  dispose();
  assert.equal(registered.length, 0);
});

test("mountRpcRoute：register 返回非 disposer 时也给出可调用的清理函数", () => {
  const dispose = mountRpcRoute({
    webServer: { register: () => undefined },
    connection: { requestRejection: () => undefined },
    channel: CHANNEL,
    handler: async () => ({ ok: true, value: 1 }),
  });

  assert.equal(typeof dispose, "function");
  assert.doesNotThrow(() => dispose());
});

test("mountRpcRoute：栅栏判定为 401/403 时直接结束，不碰处理器", async () => {
  for (const rejection of [401, 403]) {
    let called = false;
    let route;
    mountRpcRoute({
      webServer: {
        register(next) {
          route = next;
          return () => {};
        },
      },
      connection: { requestRejection: () => rejection },
      channel: CHANNEL,
      handler: async () => {
        called = true;
        return { ok: true, value: 1 };
      },
    });

    const { req, res } = httpExchange();
    await route.handler(req, res);
    assert.equal(res.status, rejection);
    assert.equal(res.text(), rejection === 401 ? "unauthorized" : "forbidden");
    assert.equal(called, false, "被拒的请求不能进处理器");
  }
});

test("mountRpcRoute：栅栏自己抛错时按 403 处理（宁严勿松）", async () => {
  const warnings = [];
  let route;
  mountRpcRoute({
    webServer: {
      register(next) {
        route = next;
        return () => {};
      },
    },
    connection: {
      requestRejection() {
        throw new Error("no browser auth");
      },
    },
    channel: CHANNEL,
    handler: async () => ({ ok: true, value: 1 }),
    logger: { warn: (message) => warnings.push(message) },
  });

  const { req, res } = httpExchange();
  await route.handler(req, res);
  assert.equal(res.status, 403);
  assert.equal(warnings.length, 1);
});

test("mountRpcRoute：没有 requestRejection 时退回 loopback 判定", async () => {
  const cases = [
    { headers: { host: "127.0.0.1:3080" }, expected: 200 },
    { headers: { host: "localhost:3080", origin: "http://localhost:3080" }, expected: 200 },
    { headers: { host: "192.168.1.5:3080" }, expected: 403, why: "非 loopback" },
    { headers: { host: "127.0.0.1:3080", "sec-fetch-site": "cross-site" }, expected: 403, why: "cross-site" },
    { headers: { host: "127.0.0.1:3080", origin: "http://evil.example" }, expected: 403, why: "Origin 不匹配" },
    { headers: { host: undefined }, expected: 403, why: "没有 Host" },
  ];

  for (const item of cases) {
    let route;
    mountRpcRoute({
      webServer: {
        register(next) {
          route = next;
          return () => {};
        },
      },
      channel: CHANNEL,
      handler: async () => ({ ok: true, value: 1 }),
    });

    const { req, res } = httpExchange({
      headers: { "content-type": "application/json", ...item.headers },
      body: JSON.stringify(clientRequest("snapshot")),
    });
    await route.handler(req, res);
    assert.equal(res.status, item.expected, item.why ?? item.headers.host);
  }
});

test("mountRpcRoute：桥接本身炸了也不会把异常抛穿 HTTP 层", async () => {
  const warnings = [];
  let route;
  mountRpcRoute({
    webServer: {
      register(next) {
        route = next;
        return () => {};
      },
    },
    connection: { requestRejection: () => undefined },
    channel: CHANNEL,
    handler: async () => ({ ok: true, value: 1 }),
    logger: { warn: (message) => warnings.push(message) },
  });

  // 请求对象缺 asyncIterator → httpBridge 在 for await 处抛
  const res = {
    status: 0,
    chunks: [],
    writableEnded: false,
    writeHead(status) {
      this.status = status;
    },
    write() {
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
      this.writableEnded = true;
    },
    on() {},
    once() {},
    off() {},
  };
  await route.handler({ method: "POST", url: `${CHANNEL}/snapshot`, headers: {} }, res);

  assert.equal(res.status, 500);
  assert.equal(warnings.length, 1);
});
