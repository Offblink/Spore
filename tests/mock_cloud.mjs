// 假 Spore-Cloud：照 `Spore-Cloud` 服务端源码逐条实现对客户端有约束的部分，
// 供 node 单测与 e2e 用（真机四进程 + MySQL 未起时也能验证同步语义）。
//
// 对齐的服务端事实（`spore-content/SyncService`、`SyncController`、`GatewayAuthFilter`）：
//   - 返回统一 `{code,message,data}`，code=0 成功；无 token / token 不对 → HTTP 401 + code 40101；
//   - LWW：客户端 `updated` **严格大于**服务端 `update_time` 才覆盖（相等 = 拒收）；
//   - 墓碑：`deleted=1` 的行照样进库、照样下发，pull 不过滤；
//   - 游标：`nextCursor` = 本批最大 `update_time`；任一类被 limit 截断时不越过该类本批最大值；
//   - 引用完整性：push 先落 categories；`categoryId:''` → NULL；悬空科目 → NULL 但仍 accepted；
//   - 附件：`push-attachment` **不校验文章存在**——文件先落盘、再 `bindAttachment`
//     （UPDATE ... WHERE id=? ，影响 0 行也不报错）；存在时才回写行并抬 update_time。
//     这正是「多图用合成 articleId 上推」能成立的服务端依据。
//
// 跑法：node tests/mock_cloud.mjs --token <t> [--port 0]  → 打印 MOCK_CLOUD_PORT=<port> 后保持运行
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const LIMIT_MAX = 500;

const now = () => Date.now();

function r(data, message = 'ok') {
  return { code: 0, message, data };
}

function fail(code, message) {
  return { code, message };
}

/** 从 multipart/form-data 里取出第一个文件部分（客户端只发一个 `file`） */
function parseMultipartFile(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const start = buf.indexOf(boundary);
  if (start < 0) return null;
  const bodyStart = start + boundary.length + 2; // 跳过 boundary 后的 CRLF
  const next = buf.indexOf(boundary, bodyStart);
  if (next < 0) return null;
  let part = buf.subarray(bodyStart, next);
  if (part.subarray(-2).toString() === '\r\n') part = part.subarray(0, part.length - 2);
  const headerEnd = part.indexOf('\r\n\r\n');
  if (headerEnd < 0) return null;
  const headers = part.subarray(0, headerEnd).toString('utf8');
  const name = /filename="([^"]*)"/i.exec(headers)?.[1] || '';
  return { name, bytes: part.subarray(headerEnd + 4) };
}

function extensionOf(filename) {
  const dot = (filename || '').lastIndexOf('.');
  return dot >= 0 && dot < filename.length - 1 ? filename.slice(dot) : '.img';
}

/**
 * 起一个内存版假 Cloud。
 * @param {{token?: string, userId?: number, nickname?: string, username?: string, apiBase?: string}} opts
 */
export async function createMockCloud(opts = {}) {
  const token = opts.token || 'test-token';
  const userId = opts.userId ?? 7;
  const nickname = opts.nickname ?? '测试账号';
  const username = opts.username ?? 'tester';

  /** @type {Map<string, object>} 文章（含墓碑行） */
  const articles = new Map();
  /** @type {Map<string, object>} 科目 */
  const categories = new Map();
  /** @type {Map<string, Buffer>} 附件：path(相对) → 字节 */
  const files = new Map();
  /** 请求流水，测试用来断言调用顺序/次数 */
  const calls = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://mock');
      const path = url.pathname;
      calls.push({ method: req.method, path, query: Object.fromEntries(url.searchParams) });

      const send = (status, payload, raw) => {
        if (raw) {
          res.writeHead(status, { 'Content-Type': raw.type });
          res.end(raw.bytes);
          return;
        }
        const text = JSON.stringify(payload);
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(text);
      };

      if (!path.startsWith('/api/')) return send(404, fail(40400, 'not found'));

      // 附件下载是**裸字节**，也要 Bearer（服务端 pullAttachment 第一行就 requireUserId）
      const auth = req.headers.authorization || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (path === '/api/sync/pull-attachment') {
        if (bearer !== token) return send(401, fail(40101, '未登录或 token 失效'));
        const rel = url.searchParams.get('path') || '';
        const bytes = files.get(rel);
        if (!bytes) return send(404, fail(40400, 'not found'));
        const type = rel.endsWith('.png')
          ? 'image/png'
          : rel.endsWith('.webp')
            ? 'image/webp'
            : 'image/jpeg';
        return send(200, null, { type, bytes });
      }

      if (bearer !== token) return send(401, fail(40101, '未登录或 token 失效'));

      let payload = null;
      if (body.length && (req.headers['content-type'] || '').includes('application/json')) {
        try {
          payload = JSON.parse(body.toString('utf8'));
        } catch {
          return send(400, fail(40001, '请求体不是合法 JSON'));
        }
      }

      switch (`${req.method} ${path}`) {
        case 'GET /api/users/me':
          return send(200, r({ id: userId, username, nickname }));

        case 'GET /api/sync/pull': {
          const cursor = Number(url.searchParams.get('cursor') || 0);
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 200), 1), LIMIT_MAX);
          const pick = (map) =>
            [...map.values()]
              .filter((row) => row.updated > cursor)
              .sort((a, b) => a.updated - b.updated)
              .slice(0, limit);
          const cats = pick(categories);
          const arts = pick(articles);
          const maxCat = cats.reduce((m, x) => Math.max(m, x.updated), 0);
          const maxArt = arts.reduce((m, x) => Math.max(m, x.updated), 0);
          const catsHit = cats.length >= limit;
          const artsHit = arts.length >= limit;
          let nextCursor;
          if (catsHit || artsHit) {
            const cap = Math.min(
              catsHit ? maxCat : Number.MAX_SAFE_INTEGER,
              artsHit ? maxArt : Number.MAX_SAFE_INTEGER,
            );
            nextCursor = Math.max(cursor, cap);
          } else {
            nextCursor = Math.max(cursor, maxCat, maxArt);
          }
          return send(200, r({ categories: cats, articles: arts, nextCursor }));
        }

        case 'POST /api/sync/push': {
          const results = [];
          const catItems = payload?.categories || [];
          const artItems = payload?.articles || [];
          for (const item of catItems) results.push(mergeCategory(item));
          for (const item of artItems) results.push(mergeArticle(item));
          return send(200, r({ results }));
        }

        case 'POST /api/sync/push-attachment': {
          if (!(req.headers['content-type'] || '').includes('multipart/form-data')) {
            return send(400, fail(40001, '需要 multipart/form-data'));
          }
          const articleId = url.searchParams.get('articleId') || '';
          const safeId = articleId.replace(/[^0-9A-Za-z\-_]/g, '');
          if (!safeId) return send(400, fail(40001, 'articleId 非法'));
          const file = parseMultipartFile(body, req.headers['content-type']);
          if (!file || !file.bytes.length) return send(400, fail(40001, '文件为空'));
          const rel = safeId + extensionOf(file.name);
          files.set(rel, Buffer.from(file.bytes));
          // 服务端行为：回写行 + 抬 update_time；行不存在时 UPDATE 影响 0 行，静默
          const row = articles.get(articleId);
          if (row) {
            row.attachmentPath = rel;
            row.updated = now();
          }
          return send(200, r({ path: rel }));
        }

        default:
          return send(404, fail(40400, `未知接口 ${req.method} ${path}`));
      }
    });
  });

  function mergeCategory(item) {
    if (!item || !item.id) return { id: '', accepted: false };
    const old = categories.get(item.id);
    const updated = Number(item.updated || 0);
    if (!old) {
      categories.set(item.id, {
        id: item.id,
        parentId: item.parentId ?? null,
        name: item.name ?? '',
        sortOrder: item.sortOrder ?? 0,
        status: item.status ?? 1,
        created: item.created ?? updated,
        updated,
        deleted: item.deleted ?? 0,
      });
      return { id: item.id, accepted: true };
    }
    if (!(updated > old.updated)) return { id: item.id, accepted: false };
    Object.assign(old, {
      parentId: item.parentId ?? old.parentId,
      name: item.name ?? old.name,
      sortOrder: item.sortOrder ?? old.sortOrder,
      status: item.status ?? old.status,
      updated,
      deleted: item.deleted ?? old.deleted,
    });
    return { id: item.id, accepted: true };
  }

  function categoryExists(id) {
    const key = (id ?? '').trim();
    if (!key) return null;
    return categories.has(key) ? key : null;
  }

  function mergeArticle(item) {
    if (!item || !item.id) return { id: '', accepted: false };
    const old = articles.get(item.id);
    const updated = Number(item.updated || 0);
    if (!old) {
      articles.set(item.id, {
        id: item.id,
        categoryId: categoryExists(item.categoryId),
        title: (item.title || '').trim() || '新会话',
        messages: item.messages ?? [],
        fav: item.fav ?? 0,
        status: item.status ?? 'done',
        auditStatus: item.auditStatus ?? 2,
        attachmentPath: item.attachmentPath ?? null,
        created: item.created ?? updated,
        updated,
        deleted: item.deleted ?? 0,
      });
      return { id: item.id, accepted: true };
    }
    if (!(updated > old.updated)) return { id: item.id, accepted: false };
    if (item.categoryId !== undefined) old.categoryId = categoryExists(item.categoryId);
    if (item.title) old.title = String(item.title).trim();
    if (item.messages !== undefined && item.messages !== null) old.messages = item.messages;
    if (item.fav !== undefined && item.fav !== null) old.fav = item.fav;
    if (item.status) old.status = item.status;
    if (item.auditStatus !== null && item.auditStatus !== undefined) old.auditStatus = item.auditStatus;
    if (item.attachmentPath !== undefined && item.attachmentPath !== null) {
      old.attachmentPath = item.attachmentPath;
    }
    old.updated = updated;
    old.deleted = item.deleted ?? old.deleted;
    return { id: item.id, accepted: true };
  }

  await new Promise((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = server.address().port;
  const api = `http://127.0.0.1:${port}/api`;

  return {
    api,
    port,
    token,
    userId,
    articles,
    categories,
    files,
    calls,
    /** 直接读附件字节（断言用） */
    fileAt: (rel) => files.get(rel) || null,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// CLI：给 e2e 用。打印端口后保持运行，SIGTERM 退出。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const get = (k, d) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : d;
  };
  const cloud = await createMockCloud({
    token: get('--token', 'test-token'),
    port: Number(get('--port', 0)),
  });
  console.log(`MOCK_CLOUD_PORT=${cloud.port}`);
  console.log(`MOCK_CLOUD_API=${cloud.api}`);
  process.on('SIGTERM', async () => {
    await cloud.close();
    process.exit(0);
  });
}
