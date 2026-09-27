// Agent：两阶段作答（先快再准）+ 异步起名 + 后续追问。
//   阶段A 读题并给初答（vision，实测首字 1.8s）
//   阶段B 联网核实（web_search / web 工具循环，判 OK / FIX）
//   起名在阶段A 结束后立刻异步发起，绝不阻塞答案生成。
import { streamChat, AbortedError } from './llm.js';
import { TOOLS, dispatch } from './tools.js';
import * as store from './store.js';

const SYSTEM = `你是「孢子」，一个看截图答题的助手。规则：
- 直接给答案：先结论，再依据，绝不复述题目，绝不客套。
- 中文作答；题目是英文则用英文。数学式子用 LaTeX（行内 $...$）。
- 拿不准就明说拿不准，绝不编造。`;

const PHASE_A = `这是一道题目截图。**直接给结论，不要写推理过程**。严格只输出下面五行，不要输出任何其它文字、序号或 markdown：
NO: <题号，直接写数字；图上没有题号就写 无>
TITLE: <题目大意，≤12 个字，浓缩这道题在问什么；不要带题号、选项字母和答案本体>
ANS: <答案本体。选择题必须写成「A（-1）」这种「选项字母 +（结果）」的形式；填空/解答直接给结论，≤40 字>
WHY: <一句话解析，≤60 字>
CERT: <你对本答案的把握：纯计算/教材常识、一步就能确认的，写 <<ok>>；需要核对事实、年份、数据、术语或你没把握的，写 <<check>>>`;

const PHASE_B = `你刚才已给出初答，现在只需核实它（只输出结果，不要写推理草稿）。
- 纯计算题、教材常识、且你确信无误：可直接给 VERDICT: OK，不必用工具。
- 涉及事实、年份、人物、术语、数据、政策、代码 API 或你没把握的点：先用 web_search 检索（最多 $R$ 轮），必要时用 web 抓正文核对，再下结论。
- 只核对与答案相关的关键点，不要复述题目。
最后输出严格两行（NOTE 必填，不许留空）：
VERDICT: OK | FIX
NOTE: <一句话核实说明，必须点名你依据的来源（站点/标题/数值）；若 FIX，先给正确结论再给一句话解析；找不到可靠依据就写「未找到可靠来源，答案存疑」。≤90 字>`;

// ------------------------------------------------------------------ 解析

/** 初答里带 <<ok>> 就跳过联网核实（CERT 行或正文里出现都算） */
export function isSelfCertain(raw) {
  return /<<ok>>/i.test(String(raw || ''));
}

export function parsePhaseA(raw) {
  const grab = (key) => {
    const m = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(raw);
    return m ? m[1].trim() : '';
  };
  let no = grab('NO');
  let title = grab('TITLE');
  let ans = grab('ANS');
  let why = grab('WHY');
  if (!ans) {
    // 模型没写 ANS 行（或写成别的标签/空行）：剥掉已知字段行，剩下整段当答案
    const leftover = raw.replace(/^(NO|TITLE|ANS|WHY|CERT):.*$/gm, '').trim();
    if (leftover) ans = leftover;
    else if (!why && no) {
      ans = no;
      no = '';
    }
    // 只写了 WHY：正文即答案，不能让答案栏空着（wait/展示都靠它）
    if (!ans && why) {
      ans = why;
      why = '';
    }
  }
  const stripGuard = (t) => String(t || '').replace(/<<ok>>|<<check>>|^CERT:.*$/gim, '').trim();
  ans = stripGuard(ans);
  why = stripGuard(why);
  no = no.replace(/\s+/g, '');
  if (no === '无' || no === 'none' || no === '-') no = '';
  title = sanitizeTitle(title);
  if (title === '无' || title === 'none' || title === '-') title = '';
  return { no, title, ans: ans.trim(), why: why.trim() };
}

export function parsePhaseB(raw) {
  const verdict = /^VERDICT:\s*(FIX|OK)\b/im.exec(raw)?.[1]?.toUpperCase() || '';
  let note = /^NOTE:\s*([\s\S]*)$/im.exec(raw)?.[1]?.trim() || '';
  if (!note) {
    note = raw.replace(/^(VERDICT|NOTE):.*$/gm, '').trim();
  }
  if (!note) note = '（模型没给出核实说明，建议自己再看一眼来源）';
  if (!verdict) return { verdict: '', note: note.trim(), ran: true };
  return { verdict, note: note.trim(), ran: true };
}

/** 流式阶段展示用：把 NO:/ANS:/WHY: 的字段拍成人话 */
export function formatAnswerPreview(no, ans, why) {
  const head = no ? `第${no.replace(/[^\dA-Za-z]/g, '')}题` : '';
  const parts = [head, ans].filter(Boolean).join(' ');
  return [parts, why].filter(Boolean).join('\n');
}

function sanitizeTitle(text) {
  return (
    String(text || '')
      .replace(/["“”'‘’《》\[\]{}（）()<>：:；;，,。.!！？?、\s]+/g, ' ')
      .trim()
      .slice(0, 20) || ''
  );
}

// ------------------------------------------------------------------ 上下文

function historyMessages(sess, settings) {
  const msgs = [];
  // 只保留最近一张图：更早的截图换成占位文本，省 token 也够用
  let lastImageIdx = -1;
  sess.messages.forEach((m, i) => {
    if (m.role === 'user' && m.image) lastImageIdx = i;
  });
  for (const [i, m] of sess.messages.entries()) {
    if (m.role === 'user') {
      const text = m.text || (m.image ? '（题目截图）' : '');
      if (m.image && i === lastImageIdx) {
        msgs.push({
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: m.image } },
            { type: 'text', text },
          ],
        });
      } else {
        msgs.push({ role: 'user', content: text });
      }
    } else if (m.kind === 'answer') {
      msgs.push({
        role: 'assistant',
        content: `NO: ${m.no || '无'}\nANS: ${m.ans || ''}\nWHY: ${m.why || ''}${
          m.verify?.ran ? `\nVERDICT: ${m.verify.verdict || 'OK'}\nNOTE: ${m.verify.note || ''}` : ''
        }`,
      });
    } else if (m.text) {
      msgs.push({ role: 'assistant', content: m.text });
    }
  }
  const limit = Math.max(2, settings.historyLimit || 10);
  return msgs.slice(-limit);
}

// ------------------------------------------------------------------ 起名

/**
 * 标题 = 题号（加分项）+ 题目大意（阶段A 顺带吐的 TITLE 行）。
 * 模型失效（TITLE 缺失/没守格式）→ 回退答案前 14 个字；再不济「截图问答」。
 * 全程零额外模型调用。
 */
function namingTitle(answer) {
  const no = String(answer?.no || '').replace(/\s+/g, '');
  const head = no && no !== '无' ? `第${no.replace(/[^\dA-Za-z]/g, '')}题` : '';
  const gist = sanitizeTitle(answer?.title) || sanitizeTitle(answer?.ans) || sanitizeTitle(answer?.why) || '';
  const tail = (gist || '截图问答').slice(0, 14);
  return [head, tail].filter(Boolean).join(' ');
}

function renameLocal(sess, title, emit) {
  store.logEvent(`renameLocal → "${title}" (sid=${sess.id})`);
  store
    .renameSession(sess.id, title)
    .then((saved) => {
      store.logEvent(`renameLocal ok sid=${sess.id} saved="${saved}"`);
      emit({ type: 'title', sid: sess.id, title });
    })
    .catch((e) => store.logEvent(`rename failed ${sess.id}: ${e && e.message}`));
}

/**
 * 起名：纯本地、不阻塞答案、**零额外模型调用**。
 * 大意来自阶段A 顺带吐出的 TITLE 行，题号只是加分前缀；
 * 模型失效（TITLE 缺失）时 namingTitle 内部回退到答案前 14 字。
 */
export function kickNaming(sess, answer, emit) {
  store.logEvent(
    `kickNaming start sid=${sess.id} no=${JSON.stringify(answer?.no || '')} title=${JSON.stringify(
      answer?.title || '',
    )}`,
  );
  renameLocal(sess, namingTitle(answer), emit);
}

/** 回合收尾/出错时的最后保险：只用会话里已有的信息立刻起名（同样零模型调用） */
export function ensureNamed(sess, emit) {
  store.logEvent(`ensureNamed sid=${sess ? sess.id : 'null'} title=${JSON.stringify(sess && sess.title)}`);
  if (!sess) return;
  const t = sess.title || '';
  const legacy = /^解析中/.test(t); // 老构建遗留占位：无论如何都要换掉
  if (!legacy && t !== '新会话') return; // 已有正经名字就不动
  const lastAnswer = sess.messages.filter((m) => m.kind === 'answer').pop();
  if (!legacy && !lastAnswer) return; // 还没答过题就保持「新会话」占位
  renameLocal(sess, namingTitle(lastAnswer), emit);
}

// ------------------------------------------------------------------ 阶段B（可单独触发）

/**
 * 阶段B：联网核实（工具循环）。
 * 单独抽出来，是因为「自动核实」可以关：关掉后由抽屉的「核实一下」按钮
 * 调 runVerifyOnly() 走**同一份实现**，行为与自动模式完全一致。
 */
async function verifyPhase({ sess, answer, idx, sid, emit, api, bump, settings, image, extra, signal }) {
  const maxRounds = Math.max(0, settings.maxToolRounds || 0);
  if (maxRounds <= 0) return;
  emit({ type: 'status', sid, status: 'verifying', text: '核实中…' });
  const msgs = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: image } },
        { type: 'text', text: `${PHASE_A}${extra}` },
      ],
    },
    { role: 'assistant', content: `NO: ${answer.no || '无'}\nANS: ${answer.ans}\nWHY: ${answer.why}` },
    { role: 'user', content: PHASE_B.replace('$R$', String(maxRounds)) },
  ];

  let verify = null;
  for (let round = 0; round <= maxRounds; round++) {
    if (signal?.aborted) throw new AbortedError();
    const res = await streamChat({
      ...api,
      noThink: false, // 核实阶段要思考，且思考内容会显示出来
      messages: msgs,
      tools: TOOLS,
      onDelta: (kind, chunk, acc) => {
        if (acc.reasoning !== (answer.verify?.think || '')) {
          (answer.verify ||= {}).think = acc.reasoning || '';
          bump();
          emit({ type: 'think-delta', sid, idx, kind: 'verify', think: acc.reasoning || '' });
        }
        if (kind !== 'text' || !chunk) return;
        bump();
        emit({ type: 'verify-delta', sid, idx, note: acc.content, verdict: '' });
      },
    });
    if (!res.toolCalls?.length) {
      verify = parsePhaseB(res.content || '');
      break;
    }
    emit({ type: 'status', sid, status: 'searching', text: '检索中…' });
    msgs.push({
      role: 'assistant',
      content: res.content || null,
      tool_calls: res.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args } })),
    });
    for (const tc of res.toolCalls) {
      let args = {};
      try {
        args = JSON.parse(tc.args || '{}');
      } catch {
        // 尾逗号等常见小毛病：去掉再试一次
        try {
          args = JSON.parse(String(tc.args || '{}').replace(/,\s*([}\]])/g, '$1'));
        } catch {
          args = {};
        }
      }
      const brief = String(args.query || args.url || '').slice(0, 80);
      const chip = tc.name === 'web' ? `读取 ${brief}` : `检索 ${brief}`;
      (answer.tools ||= []).push(chip);
      emit({ type: 'tool', sid, idx, name: tc.name, brief });
      const out = await dispatch(tc.name, args, signal);
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: out });
    }
  }

  if (!verify && !signal?.aborted) {
    // 检索轮次用光了也要给出结论：停手，强制输出两行
    const fin = await streamChat({
      ...api,
      noThink: false,
      messages: [
        ...msgs,
        {
          role: 'user',
          content: '检索到此为止。现在只输出严格两行：VERDICT: OK|FIX，NOTE: 一句话结论与依据（≤80字）。',
        },
      ],
      maxTokens: 300,
      onDelta: (kind, chunk, acc) => {
        if (kind === 'text' && chunk) {
          bump();
          emit({ type: 'verify-delta', sid, idx, note: acc.content, verdict: '' });
        }
      },
    });
    verify = parsePhaseB(fin.content || '');
  }
  if (!verify) {
    verify = { verdict: '', note: '核实失败（网络或模型异常），可点 ↻ 重试。', ran: true };
  }
  verify.think = answer.verify?.think || ''; // 核实过程的思考要留得住，重渲染时不丢
  answer.verify = verify;
  emit({ type: 'verify-delta', sid, idx, ...verify, done: true });
}

/**
 * 手动核实：对会话里最后一条回答跑一次阶段B（「核实一下」按钮的落地实现）。
 * 复用 runTurn 的整套收尾：状态、落盘、通知、镜像。
 */
export async function runVerifyOnly({ sid, emit, signal, settings }) {
  const sess = await store.getSession(sid);
  if (!sess) throw new Error(`session not found: ${sid}`);
  store.beginTurnSession(sess);
  const idx = sess.messages.length - 1;
  const answer = sess.messages[idx];
  if (!answer || answer.kind !== 'answer') throw new Error('没有可核实的回答');
  const lastUser = [...sess.messages].reverse().find((m) => m.role === 'user');
  const api = { endpoint: settings.endpoint, apiKey: settings.apiKey, model: settings.model, signal };
  const bump = () => store.scheduleSave(sess);
  const extra = lastUser?.text ? `\n\n用户补充：${lastUser.text}` : '';

  store.logEvent(`verifyNow ${sid} idx=${idx}`);
  answer.verify = { ran: false, think: '' }; // 重新赋值即摘掉 pending → 按钮消失
  sess.status = 'verifying';
  await store.patchIndex(sid, { status: 'verifying' });
  emit({ type: 'verify-delta', sid, idx, ran: false, note: '', pending: false });
  try {
    await verifyPhase({
      sess,
      answer,
      idx,
      sid,
      emit,
      api,
      bump,
      settings,
      image: lastUser?.image || null,
      extra,
      signal,
    });
    sess.status = 'done';
    await store.flushSave(sess);
    emit({ type: 'turn-end', sid, idx });
  } catch (e) {
    await failTurn(sess, emit, e, idx);
  }
}

// ------------------------------------------------------------------ 主循环

/**
 * 回答会话里的最后一条用户消息。
 * emit(event) 由调用方提供；signal 中止整个回合。
 */
export async function runTurn({ sid, emit, signal, settings }) {
  const sess = await store.getSession(sid);
  if (!sess) throw new Error(`session not found: ${sid}`);
  store.beginTurnSession(sess); // 回合期间它就是唯一事实源，任何写入方都拿到同一份
  const last = sess.messages[sess.messages.length - 1];
  if (!last || last.role !== 'user') throw new Error('no pending user message');

  const api = { endpoint: settings.endpoint, apiKey: settings.apiKey, model: settings.model, signal };
  // 任何进度变化都排一次节流落盘：SW 中途被回收时最多丢 1.2s，而不是整个回合
  const bump = () => store.scheduleSave(sess);

  // ------------------------------------------------ 追问（纯文本，最快）
  if (!last.image) {
    sess.status = 'answering';
    await store.patchIndex(sid, { status: 'answering' });
    const msg = { role: 'assistant', kind: 'chat', text: '', think: '', ts: Date.now() };
    sess.messages.push(msg);
    const idx = sess.messages.length - 1;
    emit({ type: 'chat-start', sid, idx });
    try {
      const res = await streamChat({
        ...api,
        messages: [{ role: 'system', content: SYSTEM }, ...historyMessages(sess, settings)],
        onDelta: (kind, chunk, acc) => {
          // 正文与思考分开收：思考进「思考」块（会显示），绝不混进正文
          if (kind === 'reasoning') {
            msg.think = acc.reasoning || '';
            bump();
            emit({ type: 'think-delta', sid, idx, kind: 'chat', think: msg.think });
            return;
          }
          if (kind !== 'text' || !chunk) return;
          msg.text += chunk;
          bump();
          emit({ type: 'chat-delta', sid, idx, text: chunk, total: msg.text });
        },
      });
      if (!msg.text && res.content) msg.text = res.content;
      sess.status = 'done';
      await store.flushSave(sess);
      emit({ type: 'turn-end', sid, idx });
    } catch (e) {
      await failTurn(sess, emit, e, idx);
    }
    return;
  }

  // ------------------------------------------------ 截图提问：两阶段
  sess.status = 'answering';
  await store.patchIndex(sid, { status: 'answering' });
  emit({ type: 'status', sid, status: 'answering', text: '读题中…' });

  const image = last.image;
  const extra = last.text ? `\n\n用户补充：${last.text}` : '';
  const answer = {
    role: 'assistant',
    kind: 'answer',
    no: '',
    title: '',
    ans: '',
    why: '',
    think: '',
    verify: { ran: false, skipped: false },
    ts: Date.now(),
  };
  sess.messages.push(answer);
  const idx = sess.messages.length - 1;
  emit({ type: 'answer-start', sid, idx });

  try {
    // ---- 阶段A：读题 + 初答（一次流式调用，noThink=直接给结论不写推理）
    const resA = await streamChat({
      ...api,
      noThink: settings.fastNoThink !== false, // 默认直接作答不写推理；设置页可关
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: image } },
            { type: 'text', text: `${PHASE_A}${extra}` },
          ],
        },
      ],
      onDelta: (kind, chunk, acc) => {
        const changed = acc.reasoning !== answer.think;
        if (changed) {
          answer.think = acc.reasoning || '';
          bump();
          emit({ type: 'think-delta', sid, idx, kind: 'answer', think: answer.think });
        }
        if (kind !== 'text' && kind !== 'tool') return;
        const p = parsePhaseA(acc.content || '');
        if (p.no !== answer.no || p.title !== answer.title || p.ans !== answer.ans || p.why !== answer.why) {
          answer.no = p.no;
          answer.title = p.title;
          answer.ans = p.ans;
          answer.why = p.why;
          bump();
          emit({ type: 'answer-delta', sid, idx, ...answer, preview: formatAnswerPreview(p.no, p.ans, p.why) });
        }
      },
    });
    const rawA = resA.content || '';
    const parsedA = parsePhaseA(rawA);
    answer.no = parsedA.no || answer.no;
    answer.title = parsedA.title || answer.title;
    answer.ans = parsedA.ans || answer.ans;
    answer.why = parsedA.why || answer.why;
    emit({ type: 'answer-delta', sid, idx, ...answer, preview: formatAnswerPreview(answer.no, answer.ans, answer.why) });

    // 起名立刻发出（纯本地、零额外调用），不等核实
    kickNaming(sess, answer, emit);

    // ---- 守卫：初答自评 <<ok>> → 跳过联网核实（省时间，但要在 UI 上说清楚跳过了）
    const certain = isSelfCertain(rawA);
    if (certain) {
      answer.verify = {
        ran: false,
        skipped: true,
        verdict: 'OK',
        note: '初答自评「确定」（<<ok>> 守卫），已跳过联网核实。',
      };
      emit({ type: 'verify-delta', sid, idx, ...answer.verify, done: true, skipped: true });
      sess.status = 'done';
      await store.flushSave(sess);
      emit({ type: 'turn-end', sid, idx });
      return;
    }

    // ---- 阶段B：联网核实（工具循环）。设置里关了「自动核实」就交给「核实一下」按钮
    if (settings.autoVerify === false) {
      answer.verify = { ran: false, pending: true, note: '已关闭自动核实 · 点下面「核实一下」开始核实' };
      bump();
      emit({ type: 'verify-delta', sid, idx, ...answer.verify, done: true, pending: true });
      store.logEvent(`verify deferred (autoVerify=false) ${sid}`);
    } else {
      await verifyPhase({ sess, answer, idx, sid, emit, api, bump, settings, image, extra, signal });
    }

    sess.status = 'done';
    store.logEvent(`turnDone ${sid} msgs=${sess.messages.length}`);
    await store.flushSave(sess);
    emit({ type: 'turn-end', sid, idx });
  } catch (e) {
    await failTurn(sess, emit, e, idx);
  }
}

async function failTurn(sess, emit, e, idx) {
  try {
    ensureNamed(sess, emit);
  } catch {
    /* 起名失败不能影响错误上报 */
  }
  const aborted = e.name === 'AbortedError';
  store.logEvent(`failTurn ${sess.id} idx=${idx} aborted=${aborted} err=${String(e && e.message).slice(0, 160)}`);
  sess.status = aborted ? 'aborted' : 'error';
  sess.errorMsg = String(e.message || e).slice(0, 200);
  try {
    await store.flushSave(sess);
  } catch {
    /* ignore */
  }
  if (aborted) {
    emit({ type: 'turn-end', sid: sess.id, idx, aborted: true });
  } else {
    emit({ type: 'error', sid: sess.id, idx, message: sess.errorMsg });
    emit({ type: 'turn-end', sid: sess.id, idx, error: true });
  }
}
