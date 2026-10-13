/**
 * 面板的 HTTP 传输层：把 lib/ui/rpc.js 的处理器挂成一条 Host 路由。
 *
 * ## 为什么不用 `ctx.connection.rpc.handle(channel, handler)`
 *
 * 它在这个 DSH 版本里**必然抛错**。核过 `dsh-client-connection` 的源码：
 *
 * ```js
 * get rpc() {
 *   const owner = this.ctx;                      // ← 连接服务自己的 context
 *   return { handle: (channel, handler) => this.register(owner, channel, handler), ... };
 * }
 * register(owner, channel, handler) {
 *   ...
 *   return owner.effect(() => owner.webServer.register(route), ...);   // ← 读 owner.webServer
 * }
 * ```
 *
 * 而那个服务的 `inject` 只有 `["credentials"]` —— 在 cordis 里读一个没 inject
 * 的服务会抛 `cannot get property without inject`。于是 `handle()` 一调用就炸，
 * 路由永远挂不上，浏览器 POST 落到 SPA 静态兜底 → **HTTP 405**。
 *
 * 对照：`/api` 那条路由是好的，因为它在 `ctx.inject(["webServer"], (webCtx) => …)`
 * 里用 `webCtx.webServer` 注册 —— 走的是自己的 webServer，不是服务内部的。
 *
 * 所以这里照抄那条路：**本插件自己 inject `webServer`，自己注册前缀路由**，
 * 并逐分支复刻 `rpcFetchHandler` 与 `bridge` 的语义（404 / 415 / 400 /
 * gateway-bad-request / 500 / 200），让线上格式与 `/api` 通道逐字节一致。
 * 同一个坑 `dsh-pocket` 也踩过，它的 `lib/web-rpc.js` 里有同样的注释与回退。
 *
 * 另有一条看起来更省事的路，但走不通：`connection.rpc.intercept("/api", …)`
 * 确实不碰 `owner.webServer`，可 `/api` 的拦截器槽位是**独占**的
 * （`already has an interceptor`），已经被 `dsh-api-gateway` 占了。
 *
 * ## 本文件不依赖 DSH 运行时
 *
 * 只用 Node 的 `http`/`fetch` 原语，注册动作由调用方传进来。所以传输语义
 * （状态码、信封形状、路径解析）可以脱离 DSH 独立单测。
 */

/** endpoint 段的合法字符，抄自 dsh-client-connection 的 `ENDPOINT_SEGMENT_PATTERN`。 */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

/** 信封非法时用的兜底 rpcId，与 dsh 内部的 `INVALID_REQUEST_RPC_ID` 对齐。 */
const INVALID_REQUEST_RPC_ID = "invalid-request";

/**
 * 面板单次请求体上限。
 *
 * 两个端点都是小 JSON（快照 + 一个裁决动作），1 MB 已经绰绰有余；定死上限是
 * 为了不给「无界缓冲」留口子。
 */
const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/** 允许的 Host（无 connection 栅栏时的兜底用）。 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * 从 `${channel}/<endpoint>` 路径里取出 endpoint，段非法时返回 undefined。
 * 与 dsh-client-connection 的 `endpointFromPath` 字段对字段一致 ——
 * 注意它按**段**校验，`a/b` 这种多段名字是合法的，别顺手改成「只认单段」。
 *
 * @param {string} channel - channel，如 `/dsh-memory`。
 * @param {string} pathname - 请求路径。
 * @returns {string|undefined} endpoint，非法则 undefined。
 */
export function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined;
  const endpoint = pathname.slice(channel.length + 1);
  if (
    endpoint
      .split("/")
      .some(
        (segment) =>
          segment === "" ||
          segment === "." ||
          segment === ".." ||
          !ENDPOINT_SEGMENT_PATTERN.test(segment),
      )
  ) {
    return undefined;
  }
  return endpoint;
}

/**
 * 校验 client-request 信封。
 *
 * 等价于 DSH 的 `clientRequestSchema`（zod），只是不引 zod：
 * `{type:"client-request", rpcId: string, method: string, payload: unknown}`。
 * 多出来的字段一律忽略（zod 默认也是剥掉）。
 *
 * @param {unknown} body - 请求体。
 * @returns {{rpcId: string, method: string, payload: unknown}|undefined} 合法则归一化。
 */
function validClientRequest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  if (body.type !== "client-request") return undefined;
  if (typeof body.rpcId !== "string") return undefined;
  if (typeof body.method !== "string") return undefined;
  return { rpcId: body.rpcId, method: body.method, payload: body.payload };
}

/**
 * 构造 server-response 信封。
 *
 * 成功结果里的 `attachments` 字段 DSH 会剥掉（走 multipart 另一条路），
 * 面板的处理器不产出它，所以这里不需要那段分支。
 *
 * @param {string} rpcId - 请求带来的关联 id。
 * @param {object} result - `{ok:true, value}` 或 `{ok:false, error}`。
 * @returns {Response} 200 + JSON。
 */
function fullResponse(rpcId, result) {
  return Response.json({ type: "server-response", rpcId, result });
}

/**
 * 构造失败信封。
 * @param {string} rpcId - 关联 id。
 * @param {{code: string, message: string, details: object}} error - 错误体。
 * @returns {Response} 200 + JSON（传输成功、业务失败）。
 */
function errorResponse(rpcId, error) {
  return fullResponse(rpcId, { ok: false, error });
}

/**
 * 请求体读不出合法信封时的响应，与 DSH 的 `invalidEnvelopeResponse` 一致。
 * @param {unknown} body - 原始请求体。
 * @returns {Response} 200 + JSON。
 */
function invalidEnvelopeResponse(body) {
  const rawId = body !== null && typeof body === "object" ? body.rpcId : undefined;
  return errorResponse(typeof rawId === "string" ? rawId : INVALID_REQUEST_RPC_ID, {
    code: "gateway/bad-request",
    message: "invalid client-request message",
    details: { issues: [] },
  });
}

/**
 * 把处理器包装成 fetch 形状，逐分支复刻 `rpcFetchHandler`。
 *
 * 分支顺序与状态码都是契约的一部分：浏览器侧只看 `response.ok`，
 * 非 2xx 一律变成 `transport failure …: HTTP <status>`。
 *
 * @param {string} channel - channel。
 * @param {(endpoint: string, payload: unknown, signal: AbortSignal) => Promise<object>} handler
 *   端点处理器。
 * @returns {{requestBodyMode: () => string, fetch: (request: Request) => Promise<Response>}}
 *   fetch 形状的处理器。
 */
export function rpcFetchHandler(channel, handler) {
  return {
    requestBodyMode: () => "buffered",
    async fetch(request) {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname);
      if (request.method !== "POST" || endpoint === undefined) {
        return new Response("not found", { status: 404 });
      }
      if (
        request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/json"
      ) {
        return new Response("content type must be application/json", { status: 415 });
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return new Response("body is not JSON", { status: 400 });
      }

      const envelope = validClientRequest(body);
      if (envelope === undefined) return invalidEnvelopeResponse(body);
      if (envelope.method !== endpoint) {
        return errorResponse(envelope.rpcId, {
          code: "gateway/bad-request",
          message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        });
      }

      try {
        const result = await handler(endpoint, envelope.payload, request.signal);
        return fullResponse(envelope.rpcId, result);
      } catch (error) {
        // 与 DSH 一致：处理器自己抛穿 = 500 纯文本，不是信封。
        return new Response(`handler failure: ${String(error)}`, { status: 500 });
      }
    },
  };
}

/**
 * node:http 请求 → fetch 形状处理器 → node:http 响应的桥接。
 *
 * 与 dsh-client-connection 的 `bridge` 的 buffered 分支一致：声明长度或流式读取
 * 超限一律 413 并销毁 socket；响应体按背压回写，客户端断开就停。
 *
 * @param {import("node:http").IncomingMessage} req - 请求。
 * @param {import("node:http").ServerResponse} res - 响应。
 * @param {{fetch: (request: Request) => Promise<Response>}} fetchHandler - 处理器。
 * @param {number} maxRequestBodyBytes - 请求体上限。
 * @returns {Promise<void>}
 */
export async function httpBridge(req, res, fetchHandler, maxRequestBodyBytes) {
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  const declaredLength = req.headers["content-length"];
  if (declaredLength !== undefined && Number(declaredLength) > maxRequestBodyBytes) {
    res.writeHead(413, { connection: "close" });
    res.end();
    req.destroy();
    return;
  }

  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.byteLength;
    if (received > maxRequestBodyBytes) {
      res.writeHead(413, { connection: "close" });
      res.end();
      req.destroy();
      return;
    }
    chunks.push(buffer);
  }

  const url = new URL(req.url ?? "/", "http://dsh.internal");
  const request = new Request(url, {
    method: req.method ?? "GET",
    // 数组形态的头（set-cookie 之类）丢掉，与 DSH 的 bridge 一致。
    headers: Object.fromEntries(
      Object.entries(req.headers).filter(([, value]) => typeof value === "string"),
    ),
    ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
    signal: abort.signal,
  });

  const response = await fetchHandler.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body === null) {
    res.end();
    return;
  }
  for await (const chunk of response.body) {
    if (!res.write(chunk)) {
      await new Promise((resolve) => {
        const done = () => {
          res.off("drain", done);
          res.off("close", done);
          resolve();
        };
        res.once("drain", done);
        res.once("close", done);
      });
    }
    if (res.writableEnded) break;
  }
  res.end();
}

/**
 * 无 connection 栅栏可用时的兜底信任判定：仅放行 loopback，拒 cross-site。
 *
 * 正常情况下用不到 —— 面板要求 `connection` 在场，走的是它那套
 * Host/Origin + 浏览器会话 cookie 的完整栅栏。这段只是「栅栏 API 没了」时的
 * 最后一道，宁严勿松。
 *
 * @param {import("node:http").IncomingMessage} req - 请求。
 * @returns {boolean} 是否可信。
 */
function isTrustedLoopbackRequest(req) {
  const host = req.headers?.host;
  if (typeof host !== "string") return false;
  if (!LOOPBACK_HOSTNAMES.has(host.split(":")[0])) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * 把 RPC 处理器挂到 webServer 上，返回清理函数。
 *
 * 栅栏按这个顺序选：
 *
 * 1. `connection.requestRejection(req)` —— 完整栅栏（Host/Origin + 浏览器 cookie），
 *    与 `/api` 路由同源。**必须以方法形式调用**（`connection.requestRejection(req)`），
 *    它内部读 `this.trustedHosts` / `this.browserAuth`，抽成裸函数再调会丢 `this`。
 * 2. 拿不到就退回 loopback 判定。
 * 3. 都不成立 → 403，不放行。
 *
 * @param {object} deps
 * @param {object} deps.webServer - `webServer` 服务。
 * @param {object} [deps.connection] - `connection` 服务（取栅栏）。
 * @param {string} deps.channel - channel，如 `/dsh-memory`。
 * @param {(endpoint: string, payload: unknown, signal: AbortSignal) => Promise<object>} deps.handler
 *   端点处理器。
 * @param {object|null} [deps.logger] - 可选 logger。
 * @param {number} [deps.maxRequestBodyBytes] - 请求体上限。
 * @returns {() => void} 清理函数（幂等）。
 */
export function mountRpcRoute({
  webServer,
  connection = undefined,
  channel,
  handler,
  logger = null,
  maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
}) {
  const fetchHandler = rpcFetchHandler(channel, handler);
  const route = {
    kind: "prefix",
    path: channel,
    handler: async (req, res) => {
      let rejection;
      if (typeof connection?.requestRejection === "function") {
        try {
          rejection = connection.requestRejection(req);
        } catch (error) {
          logger?.warn?.(`dsh-memory: 面板请求栅栏判定失败，按拒绝处理: ${String(error)}`);
          rejection = 403;
        }
      } else if (!isTrustedLoopbackRequest(req)) {
        rejection = 403;
      }
      if (rejection !== undefined) {
        res.writeHead(rejection, { "content-type": "text/plain; charset=utf-8" });
        res.end(rejection === 401 ? "unauthorized" : "forbidden");
        return;
      }

      try {
        await httpBridge(req, res, fetchHandler, maxRequestBodyBytes);
      } catch (error) {
        logger?.warn?.(`dsh-memory: 面板 RPC 桥接失败: ${String(error)}`);
        if (!res.writableEnded) {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end("bridge failure");
        }
      }
    },
  };

  const registered = webServer.register(route);
  // register 正常返回 disposer；返回别的形状时给个空函数，保证幂等。
  return typeof registered === "function" ? registered : () => {};
}
