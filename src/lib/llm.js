// OpenAI 兼容的 SSE 流式客户端（stdlib 语义，照抄 Fungi/fungi/llm.py）：
//  - tool_calls 按 index 装配（并行多路也正确）
//  - 只对瞬时错误重试（网络/429/5xx/流中断），且**只在尚未吐字时重试**，
//    避免把已渲染给用户的文本重放一遍
//  - abort signal 贯穿 fetch，中止即抛 AbortedError
export class AbortedError extends Error {
  constructor(message = 'aborted', partial = null) {
    super(message);
    this.name = 'AbortedError';
    this.partial = partial;
  }
}

const RETRY_LIMIT = 3;

const RETRYABLE_STATUS = /^HTTP (429|5\d\d)/;
const RETRYABLE_NET =
  /network|failed to fetch|connection (failed|closed|reset|refused)|terminated|stream interrupted|stream ended|timed? ?out|socket|idle/i;

/** provider 挂起不吐字的兜底时长：超了就当一次可重试的网络错误 */
const IDLE_TIMEOUT = 60000;

export function isRetryable(message) {
  return RETRYABLE_STATUS.test(message) || RETRYABLE_NET.test(message);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new AbortedError());
      },
      { once: true },
    );
  });
}

/**
 * 一次 read()，带空闲看门狗：provider 卡住不吐字 60s 就判失败（可重试），
 * 而不是让整个回合永远挂着。每块 chunk 都会重置计时器。
 */
function readWithIdle(reader, ms, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(arg);
    };
    const timer = setTimeout(() => {
      reader.cancel().catch(() => {});
      done(reject, new Error(`stream idle >${ms / 1000}s`));
    }, ms);
    const onAbort = () => done(reject, new AbortedError('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (r) => done(resolve, r),
      (e) => done(reject, e),
    );
  });
}

async function once({ endpoint, apiKey, model, messages, tools, maxTokens, temperature, noThink, signal, onDelta }) {
  const body = { model, messages, stream: true, stream_options: { include_usage: false } };
  // 「直接作答」模式：实测 deepseek 端点吃 reasoning_effort=none / thinking=disabled，
  // 两种都会把 reasoning_content 归零（基线是 ~130 字符的思考）。
  if (noThink) {
    body.reasoning_effort = 'none';
    body.thinking = { type: 'disabled' };
  }
  if (Number.isFinite(maxTokens)) body.max_tokens = maxTokens;
  if (Number.isFinite(temperature)) body.temperature = temperature;
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new AbortedError();
    throw new Error(`network: ${e.message || e}`);
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${detail.slice(0, 300)}`);
    if (res.status === 400 && noThink) err.noThinkRejected = true; // 换个 provider 不认这参数，降级重试
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  const slots = new Map(); // index -> {id, name, args}

  const emitToolDelta = () => {
    const calls = [...slots.values()]
      .sort((a, b) => a.index - b.index)
      .map((s) => ({ id: s.id, name: s.name, args: s.args }));
    onDelta?.('tool', '', { content, reasoning, toolCalls: calls });
  };

  while (true) {
    let done, value;
    try {
      ({ done, value } = await readWithIdle(reader, IDLE_TIMEOUT, signal));
    } catch (e) {
      if (e.name === 'AbortedError') throw e;
      if (e.name === 'AbortError') throw new AbortedError('aborted', { content, reasoning });
      if (String(e.message || e).startsWith('stream idle')) throw e;
      throw new Error(`stream interrupted: ${e.message || e}`);
    }
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = obj.choices?.[0]?.delta;
      if (!delta) continue;

      const r = delta.reasoning_content ?? delta.reasoning;
      if (r) {
        reasoning += r;
        onDelta?.('reasoning', r, { content, reasoning });
      }
      if (delta.content) {
        content += delta.content;
        onDelta?.('text', delta.content, { content, reasoning });
      }
      if (delta.tool_calls?.length) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const slot = slots.get(idx) ?? { index: idx, id: '', name: '', args: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          slots.set(idx, slot);
          emitToolDelta();
        }
      }
      // 兼容把 tool_calls 放在 message 上的 provider（少见）
      const whole = obj.choices?.[0]?.message?.tool_calls;
      if (whole?.length) {
        for (const tc of whole) {
          const idx = tc.index ?? slots.size;
          slots.set(idx, {
            index: idx,
            id: tc.id || `call_${idx}`,
            name: tc.function?.name || '',
            args: tc.function?.arguments || '',
          });
        }
        emitToolDelta();
      }
    }
  }

  const toolCalls = [...slots.values()]
    .sort((a, b) => a.index - b.index)
    .filter((s) => s.name)
    .map((s) => ({ id: s.id || `call_${s.index}`, name: s.name, args: s.args }));
  return { content, reasoning, toolCalls };
}

/** 一次完成（带重试）。onDelta(kind, chunk, acc)：kind ∈ text|reasoning|tool */
export async function streamChat(opts) {
  const { signal, onDelta } = opts;
  let attempt = 0;
  let lastError = null;
  let emitted = false;

  const counted = onDelta
    ? (kind, chunk, acc) => {
        if (kind === 'text' && chunk) emitted = true;
        onDelta(kind, chunk, acc);
      }
    : undefined;

  let noThink = opts.noThink;
  while (attempt < RETRY_LIMIT + 1) {
    attempt += 1;
    try {
      return await once({ ...opts, noThink, onDelta: counted });
    } catch (e) {
      if (e.name === 'AbortedError') throw e;
      lastError = e;
      // 已经吐过字就不再重试，否则用户会看到重复内容
      if (emitted) break;
      // 端点不认 noThink 参数 → 去掉它重来一次
      if (e.noThinkRejected && noThink) {
        noThink = false;
        continue;
      }
      if (!isRetryable(String(e.message || e)) || attempt >= RETRY_LIMIT) break;
      await sleep(400 * attempt, signal);
    }
  }
  const err = new Error(String(lastError?.message || lastError));
  err.partial = true;
  throw err;
}
