import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const FORMAT = 'codex-mobile-handoff/v1';
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_RECENT_TURNS = 500;
const MIN_ITEM_BYTES = 12 * 1024;
const MAX_ITEM_BYTES = 256 * 1024;

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

function truncateUtf8(value, maxBytes, suffix = '\n\n[内容因长度限制已截断]') {
  const text = String(value ?? '');
  if (byteLength(text) <= maxBytes) return text;
  const suffixBytes = byteLength(suffix);
  const limit = Math.max(0, maxBytes - suffixBytes);
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(text.slice(0, middle)) <= limit) low = middle;
    else high = middle - 1;
  }
  return `${text.slice(0, low)}${suffix}`;
}

export function redactHandoffSecrets(value) {
  return String(value ?? '')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[已隐藏 API Key]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[已隐藏凭据]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|cookie)\s*[=:：]\s*)[^\s,;]+/gi, '$1[已隐藏凭据]')
    .replace(/((?:配对码|pair(?:ing)?\s*code)\s*[=:：]?\s*)\d{6,12}/gi, '$1[已隐藏]');
}

function cleanText(value, maxBytes = MIN_ITEM_BYTES) {
  const text = redactHandoffSecrets(String(value ?? ''))
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  return truncateUtf8(text, maxBytes);
}

function inline(value) {
  return cleanText(value, 1024).replace(/\s+/g, ' ').trim();
}

function contentText(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .map((part) => typeof part === 'string' ? part : part?.text ?? '')
    .filter(Boolean)
    .join('\n');
}

function structuredPlanText(item) {
  if (typeof item?.text === 'string') return item.text;
  if (typeof item?.plan === 'string') return item.plan;
  if (!Array.isArray(item?.plan)) return '';
  return item.plan.map((entry, index) => {
    if (typeof entry === 'string') return `${index + 1}. ${entry}`;
    const label = entry?.step ?? entry?.text ?? entry?.description ?? '';
    const status = entry?.status ? ` [${entry.status}]` : '';
    return label ? `${index + 1}. ${label}${status}` : '';
  }).filter(Boolean).join('\n');
}

function normalizedItem(item, maxItemBytes) {
  const type = String(item?.type ?? '').toLowerCase();
  if (type === 'usermessage') return { role: 'user', text: cleanText(contentText(item.content) || item.text, maxItemBytes) };
  if (type === 'agentmessage') return { role: 'agent', text: cleanText(item.text || contentText(item.content), maxItemBytes) };
  if (type === 'plan' || type === 'structuredplan') return { role: 'plan', text: cleanText(structuredPlanText(item), maxItemBytes) };
  return null;
}

function normalizedTurns(turns, maxItemBytes) {
  return (Array.isArray(turns) ? turns : []).map((turn) => ({
    id: String(turn?.id ?? ''),
    status: typeof turn?.status === 'string' ? turn.status : turn?.status?.type ?? '',
    startedAt: turn?.startedAt ?? null,
    items: (Array.isArray(turn?.items) ? turn.items : [])
      .map((item) => normalizedItem(item, maxItemBytes))
      .filter((item) => item?.text),
  })).filter((turn) => turn.items.length);
}

function firstItem(turns, role) {
  for (const turn of turns) {
    const item = turn.items.find((candidate) => candidate.role === role);
    if (item) return item;
  }
  return null;
}

function lastItem(turns, role) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const items = turns[index].items;
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      if (items[itemIndex].role === role) return items[itemIndex];
    }
  }
  return null;
}

function turnBlock(turn, sourceAgent) {
  const labels = { user: '用户', agent: sourceAgent, plan: `${sourceAgent} 方案` };
  const body = turn.items.map((item) => `### ${labels[item.role]}\n\n${item.text}`).join('\n\n');
  const status = inline(turn.status);
  return `${body}${status ? `\n\n_回合状态：${status}_` : ''}`;
}

function artifactSection(artifacts, maxBytes) {
  const seen = new Set();
  const rows = [];
  for (const item of Array.isArray(artifacts) ? artifacts : []) {
    if (item?.available === false || item?.status === 'deleted') continue;
    const filePath = inline(item?.relativePath ?? item?.path ?? item?.name);
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    const modified = inline(item?.modifiedAt ?? item?.capturedAt ?? '');
    rows.push(`- ${filePath}${modified ? `（${modified}）` : ''}`);
    if (rows.length >= 40) break;
  }
  return truncateUtf8(rows.length ? rows.join('\n') : '- 暂未记录可用产出物', maxBytes);
}

function workspaceSection(snapshot, maxBytes) {
  if (!snapshot?.available) return '- 当前目录不是 Git 仓库，或暂时无法读取 Git 状态';
  const rows = [];
  if (snapshot.branch) rows.push(`- 分支：${inline(snapshot.branch)}`);
  if (snapshot.head) rows.push(`- HEAD：${inline(snapshot.head)}`);
  if (snapshot.subject) rows.push(`- 最近提交：${inline(snapshot.subject)}`);
  if (snapshot.status) rows.push(`\n\`\`\`text\n${cleanText(snapshot.status, 8 * 1024)}\n\`\`\``);
  else rows.push('- 工作区没有未提交修改');
  return truncateUtf8(rows.join('\n'), maxBytes);
}

function activeStatus(value) {
  return ['running', 'planning', 'waiting', 'active', 'inprogress', 'in_progress']
    .includes(String(value ?? '').toLowerCase());
}

function recentConversation(turns, sourceAgent, limit, availableBytes) {
  const selected = [];
  let used = 0;
  let omitted = Math.max(0, turns.length - limit);
  const candidates = turns.slice(-limit);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    let block = turnBlock(candidates[index], sourceAgent);
    const blockBytes = byteLength(block) + 4;
    if (blockBytes > availableBytes - used) {
      if (!selected.length && availableBytes > 1024) {
        block = truncateUtf8(block, availableBytes - 128);
        selected.unshift(block);
        used += byteLength(block);
      }
      omitted += index + 1;
      break;
    }
    selected.unshift(block);
    used += blockBytes;
  }
  const omission = omitted > 0 ? `> 较早的 ${omitted} 个回合未包含，请在来源会话中查看。\n\n` : '';
  return `${omission}${selected.join('\n\n---\n\n') || '_没有可交接的可见对话内容_'}`;
}

export async function readGitSnapshot(cwd, options = {}) {
  const exec = options.execFile ?? execFileAsync;
  const run = async (args) => {
    const result = await exec('git', ['-C', cwd, ...args], {
      encoding: 'utf8', timeout: options.timeoutMs ?? 3000, maxBuffer: 128 * 1024,
    });
    return String(result?.stdout ?? result ?? '').trim();
  };
  try {
    if (await run(['rev-parse', '--is-inside-work-tree']) !== 'true') return { available: false };
    const [branch, head, subject, status] = await Promise.all([
      run(['branch', '--show-current']).catch(() => ''),
      run(['rev-parse', '--short=12', 'HEAD']).catch(() => ''),
      run(['log', '-1', '--format=%s']).catch(() => ''),
      run(['status', '--short', '--branch', '--untracked-files=normal']).catch(() => ''),
    ]);
    return { available: true, branch, head, subject, status };
  } catch {
    return { available: false };
  }
}

export function buildHandoffPackage(options) {
  const thread = options.thread ?? {};
  const sourceAgent = inline(options.sourceAgent || options.sourceAgentId || 'Codex');
  const sourceAgentId = inline(options.sourceAgentId || 'unknown');
  const maxBytes = Math.max(16 * 1024, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
  const recentTurnLimit = Math.max(1, Number(options.recentTurnLimit) || DEFAULT_RECENT_TURNS);
  const maxItemBytes = Math.max(MIN_ITEM_BYTES, Math.min(MAX_ITEM_BYTES, Math.floor(maxBytes / 20)));
  const turns = normalizedTurns(options.turns, maxItemBytes);
  const sectionMaxBytes = Math.max(1536, Math.min(256 * 1024, Math.floor(maxBytes / 8)));
  const generatedAt = options.generatedAt instanceof Date ? options.generatedAt : new Date(options.generatedAt ?? Date.now());
  const status = inline(options.activity?.status ?? thread?.status?.type ?? thread?.status ?? 'idle');
  const firstUser = firstItem(turns, 'user');
  const latestPlan = lastItem(turns, 'plan');
  const warning = activeStatus(status)
    ? '> 注意：来源任务仍在执行或等待确认，本交接包只包含生成时已经落盘的内容。\n\n'
    : '';
  const prefix = `# Codex Mobile 交接包

${warning}- 格式版本：${FORMAT}
- 来源 Agent：${sourceAgent}（${sourceAgentId}）
- 来源会话：${inline(thread.name || thread.preview || '未命名会话')}
- 来源会话 ID：${inline(thread.id || 'unknown')}
- 工作目录：${inline(thread.cwd || options.cwd || '未知')}
- 生成时间：${generatedAt.toLocaleString('zh-CN', { hour12: false })}
- 来源状态：${status || 'idle'}

## 使用说明

这是由 Codex Mobile 在本地生成的可移植上下文，不包含模型隐藏推理，也没有调用模型消耗额度。
请先对照目标工作目录和文件状态核验内容，再继续处理；如交接内容与实际文件冲突，以实际文件为准。

## 最初需求

${truncateUtf8(firstUser?.text ?? '_未能从本地历史中提取最初问题_', sectionMaxBytes)}

## 最近方案

${truncateUtf8(latestPlan?.text ?? '_来源会话没有可见的规划内容_', sectionMaxBytes)}

## 工作区状态

${workspaceSection(options.gitSnapshot, sectionMaxBytes)}

## 重要文件与产出物

${artifactSection(options.artifacts, sectionMaxBytes)}

## 最近对话

`;
  const suffix = `

## 给接力 Agent 的要求

1. 先核对当前工作目录、Git 状态和相关文件。
2. 延续用户已经确认的要求，不重复已完成并验证通过的工作。
3. 交接信息不足时，只询问会实质改变结果的关键问题。
`;
  const prefixBudget = Math.max(1024, maxBytes - byteLength(suffix) - 1024);
  const safePrefix = truncateUtf8(prefix, prefixBudget);
  const conversationBudget = Math.max(0, maxBytes - byteLength(safePrefix) - byteLength(suffix));
  const conversation = truncateUtf8(
    recentConversation(turns, sourceAgent, recentTurnLimit, conversationBudget),
    conversationBudget,
    '\n\n[较早内容因长度限制未包含]',
  );
  const full = redactHandoffSecrets(`${safePrefix}${conversation}${suffix}`);
  const content = byteLength(full) <= maxBytes ? full : truncateUtf8(full, maxBytes);
  return {
    format: FORMAT,
    content,
    bytes: byteLength(content),
    maxBytes,
    characters: content.length,
    truncated: content !== full || turns.length > recentTurnLimit,
    sourceAgent: sourceAgentId,
    sourceAgentLabel: sourceAgent,
    sourceThreadId: String(thread.id ?? ''),
    sourceStatus: status,
    turnCount: turns.length,
  };
}

export const HANDOFF_FORMAT = FORMAT;
