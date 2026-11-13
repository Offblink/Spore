// Spore-Cloud REST 客户端（MV3 用）：只依赖 fetch / FormData / Blob，
// 因此同一份代码既能跑在 service worker 里，也能在 node --test 里直连假服务端。
//
// 契约来源：`Spore-Cloud` 的 GatewayAuthFilter（Bearer + 白名单）、R 包装（code=0）、
// SyncController / SyncService（pull/push/附件）。要点：
//   - `{api}` 一律是 `http://host:port/api`，用户只填 `host:port` 也能归一；
//   - 业务错误把服务端 `message` 原样抛上来（客户端只负责显示，不重试）；
//   - 附件下载是裸字节、404 = 没图（不是错误）。
export class CloudError extends Error {
  constructor(message, { code = 0, http = 0 } = {}) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
    this.http = http;
  }
}

/** 兼容几种写法：裸 host:port / 带 http(s):// / 末尾带不带斜杠与 /api。空串原样返回。 */
export function normalizeApi(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  s = s.replace(/\/+$/, '');
  if (!/\/api$/i.test(s)) s = `${s}/api`;
  return s;
}

/**
 * @param {{api: string, token: string, fetchImpl?: typeof fetch, timeout?: number}} opts
 */
export function createClient({ api, token, fetchImpl = fetch, timeout = 15000 }) {
  const base = normalizeApi(api);
  if (!base) throw new CloudError('服务器地址为空');
  const bearer = String(token ?? '').trim();
  if (!bearer) throw new CloudError('令牌为空');

  async function call(path, { method = 'GET', body, headers, raw = false, timeoutMs = timeout } = {}) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${bearer}`, ...(headers || {}) },
        body,
        // MV3 SW 里没有 XMLHttpRequest；AbortSignal.timeout 在 Chrome 116+ / Node 18+ 都有
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        throw new CloudError('连不上服务器（超时，检查地址与同一局域网）');
      }
      throw new CloudError('连不上服务器（检查地址与同一局域网）');
    }

    // 附件：裸字节，404 表示该图不在服务器上
    if (raw) {
      if (res.status === 404) return null;
      if (!res.ok) throw new CloudError(`下载图片失败（HTTP ${res.status}）`, { http: res.status });
      return new Uint8Array(await res.arrayBuffer());
    }

    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new CloudError(`服务器返回了非 JSON（HTTP ${res.status}）`, { http: res.status });
    }
    if (!payload || typeof payload !== 'object') {
      throw new CloudError(`服务器返回为空（HTTP ${res.status}）`, { http: res.status });
    }
    if (payload.code !== 0) {
      const msg = payload.message || (res.status === 401 ? '令牌无效或已过期' : '请求失败');
      throw new CloudError(msg, { code: payload.code ?? 0, http: res.status });
    }
    return payload.data;
  }

  return {
    api: base,

    /** `GET /users/me` → {id,username,nickname}；连接测试就是它 */
    me: () => call('/users/me'),

    /** `GET /sync/pull?cursor&limit` → {categories,articles,nextCursor}（limit 服务端上限 500） */
    pull: (cursor = 0, limit = 200) =>
      call(`/sync/pull?cursor=${Math.max(0, Math.floor(cursor))}&limit=${Math.max(1, Math.floor(limit))}`),

    /** `POST /sync/push` → [{id,accepted}] */
    async push({ categories = [], articles = [] } = {}) {
      const data = await call('/sync/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories, articles }),
        // 首配全量时一包可能几 MB，给足时间
        timeoutMs: 60000,
      });
      return data?.results || [];
    },

    /** `POST /sync/push-attachment?articleId=`（multipart 字段 file）→ 相对路径 */
    async pushAttachment(articleId, bytes, filename) {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'image/jpeg' }), filename);
      const data = await call(
        `/sync/push-attachment?articleId=${encodeURIComponent(articleId)}`,
        { method: 'POST', body: form, timeoutMs: 60000 },
      );
      return data?.path || '';
    },

    /** `GET /sync/pull-attachment?path=` → Uint8Array | null（404） */
    pullAttachment: (path) => call(`/sync/pull-attachment?path=${encodeURIComponent(path)}`, { raw: true }),
  };
}
