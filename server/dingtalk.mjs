import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_DWS_BIN = '/home/ningmengchang/.local/bin/dws';
const SELF_CACHE_TTL_MS = 10 * 60 * 1000;

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatTime(ms) {
  const date = new Date(Number(ms) || Date.now());
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseMedia(content) {
  const match = String(content ?? '').match(/^\[(图片|语音|视频|文件|链接)\]\s*(.*?)(?:\s+fileId:\s*(\S+))?(?:\s+url:\s*(\S+))?/i);
  if (!match) return null;
  const typeMap = { 图片: 'image', 语音: 'audio', 视频: 'video', 文件: 'file', 链接: 'link' };
  return {
    type: typeMap[match[1]] ?? 'file',
    title: (match[2] ?? '').trim(),
    fileId: match[3] ?? null,
    url: match[4] ?? null,
  };
}

export function createDingTalk(config, options = {}) {
  const bin = options.bin ?? process.env.CODEX_MOBILE_DWS_BIN ?? DEFAULT_DWS_BIN;
  const exec = options.exec ?? execFileAsync;
  const mediaCachePath = path.join(config.dataDir, 'dingtalk-media.json');
  const mediaCache = new Map();
  let selfCache = null;
  let selfCacheAt = 0;

  function loadMediaCache() {
    try {
      const parsed = JSON.parse(fs.readFileSync(mediaCachePath, 'utf8'));
      for (const [key, value] of Object.entries(parsed ?? {})) mediaCache.set(key, value);
    } catch {}
  }

  function saveMediaCache() {
    try {
      fs.writeFileSync(mediaCachePath, `${JSON.stringify(Object.fromEntries(mediaCache))}\n`, { mode: 0o600 });
    } catch {}
  }

  async function run(args) {
    try {
      const { stdout } = await exec(bin, args, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
      });
      return JSON.parse(stdout);
    } catch (error) {
      if (error.stdout) {
        try {
          const parsed = JSON.parse(error.stdout);
          if (parsed?.error?.message) throw new Error(parsed.error.message);
        } catch {}
      }
      throw new Error(error.stderr?.trim() || error.message || '钉钉命令执行失败');
    }
  }

  async function resolveSelf(force = false) {
    if (!force && selfCache && Date.now() - selfCacheAt < SELF_CACHE_TTL_MS) return selfCache;
    const profiles = await run(['profile', 'list', '--format', 'json']);
    const current = profiles.profiles?.find((entry) => entry.isCurrent) ?? profiles.profiles?.[0];
    if (!current?.userId) throw new Error('无法获取当前钉钉账号，请先登录 DWS');
    const conversations = await run(['chat', '+conversation-list', '--limit', '100', '--format', 'json']);
    const selfConversation = (conversations.conversations ?? []).find((entry) => (
      (current.userName && entry.conversationName === current.userName)
      || /文件传输助手|我的设备|我的电脑/.test(entry.conversationName ?? '')
    ));
    let selfOpenDingTalkId = current.openDingTalkId ?? null;
    if (!selfOpenDingTalkId && current.userName) {
      try {
        const contacts = await run(['contact', 'user', 'search', '--query', current.userName, '--format', 'json']);
        const found = (contacts.result ?? []).find((entry) => (
          entry.userId === current.userId || entry.name === current.userName
        ));
        selfOpenDingTalkId = found?.openDingTalkId ?? null;
      } catch {}
    }
    selfCache = {
      userId: current.userId,
      userName: current.userName ?? '',
      openDingTalkId: selfOpenDingTalkId,
      openConversationId: selfConversation?.openConversationId ?? null,
    };
    selfCacheAt = Date.now();
    return selfCache;
  }

  function normalizeMessage(message) {
    const content = String(message.content ?? '');
    const media = parseMedia(content);
    return {
      id: message.openMessageId,
      type: media?.type ?? 'text',
      content,
      text: media ? (media.title || content) : content,
      title: media?.title ?? content,
      fileName: media?.title ?? null,
      fileId: media?.fileId ?? null,
      url: media?.url ?? null,
      createdAt: message.createTime ?? '',
      openConversationId: message.openConversationId ?? '',
      sender: message.sender ?? '',
    };
  }

  async function listMessages(options = {}) {
    const self = await resolveSelf();
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 100);
    const before = Number(options.before) || Date.now();
    const result = await run([
      'chat', 'message', 'list-direct',
      '--user', self.userId,
      '--time', formatTime(before),
      '--direction', 'older',
      '--limit', String(limit),
      '--format', 'json',
    ]);
    if (result.success === false && result.error) throw new Error(result.error.message || '钉钉消息拉取失败');
    const messages = result.result?.messages ?? [];
    const items = messages.map(normalizeMessage);
    for (const item of items) {
      if (item.fileId) {
        mediaCache.set(item.id, {
          messageId: item.id,
          fileId: item.fileId,
          fileName: item.fileName,
          openConversationId: item.openConversationId,
        });
      }
    }
    saveMediaCache();
    return {
      data: items,
      hasMore: Boolean(result.result?.hasMore),
      nextCursor: result.result?.nextCursor ?? null,
    };
  }

  async function downloadMedia(messageId) {
    loadMediaCache();
    const meta = mediaCache.get(messageId);
    if (!meta?.fileId) throw new Error('该消息没有可下载的媒体');
    const outputDir = path.join(config.cacheDir, 'dingtalk-media', messageId);
    fs.mkdirSync(outputDir, { recursive: true });
    await run(['drive', 'download', '--node', meta.fileId, '--output', outputDir, '--format', 'json']);
    const entries = fs.readdirSync(outputDir).filter((entry) => !entry.startsWith('.'));
    if (!entries.length) throw new Error('媒体下载失败');
    return {
      filePath: path.join(outputDir, entries[0]),
      fileName: meta.fileName || entries[0],
    };
  }

  async function createTodo({ title, due }) {
    const args = ['todo', '+remind', '--task', title, '--format', 'json'];
    if (due) args.push('--at', due);
    const result = await run(args);
    if (result.success === false && result.error) throw new Error(result.error.message || '钉钉待办创建失败');
    return { success: true, result: result.result ?? result };
  }

  async function sendFileToSelf(filePath, fileName) {
    const self = await resolveSelf();
    if (!self.openDingTalkId) throw new Error('无法解析当前账号的 openDingTalkId');
    const result = await run([
      'chat', 'message', 'send',
      '--open-dingtalk-id', self.openDingTalkId,
      '--msg-type', 'file',
      '--file-path', filePath,
      '--title', fileName || path.basename(filePath),
      '--ai-tag=false',
      '--format', 'json',
    ]);
    if (result.success === false && result.error) throw new Error(result.error.message || '钉钉文件发送失败');
    return { success: true, result: result.result ?? result };
  }

  loadMediaCache();
  return { resolveSelf, listMessages, downloadMedia, createTodo, sendFileToSelf };
}
