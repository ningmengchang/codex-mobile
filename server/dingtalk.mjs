import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_DWS_BIN = '/home/ningmengchang/.local/bin/dws';
const SELF_CACHE_TTL_MS = 10 * 60 * 1000;

export function createDingTalk(options = {}) {
  const bin = options.bin ?? process.env.CODEX_MOBILE_DWS_BIN ?? DEFAULT_DWS_BIN;
  const exec = options.exec ?? execFileAsync;
  let selfCache = null;
  let selfCacheAt = 0;

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

  return { sendFileToSelf };
}
