import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function safeSourceId(value) {
  const normalized = String(value ?? 'agent').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return normalized.replace(/^-+|-+$/g, '').slice(0, 24) || 'agent';
}

function handoffIdentity(sourceAgentId, threadId) {
  return crypto.createHash('sha256')
    .update(`${sourceAgentId}:${threadId}`)
    .digest('hex')
    .slice(0, 24);
}

export function handoffReadInstruction(filePath) {
  return `请读取本机交接包文件：\`${filePath}\`

读取完成后，请先核对其中记录的工作目录、Git 状态和实际文件，再从最新进度继续处理。不要让我重新粘贴整份交接包；如果交接内容与当前文件冲突，以当前文件为准。`;
}

export function createHandoffFileStore(config, options = {}) {
  const root = path.resolve(options.root ?? path.join(config.dataDir, 'handoffs'));

  async function ensureRoot() {
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(root, 0o700);
  }

  return {
    root,
    async write({ content, sourceAgentId, threadId }) {
      const body = String(content ?? '');
      if (!body) throw new Error('交接包内容为空。');
      const bytes = Buffer.byteLength(body, 'utf8');
      if (bytes > config.handoffMaxBytes) {
        throw new Error(`交接包超过 ${config.handoffMaxBytes} 字节上限。`);
      }

      await ensureRoot();
      const source = safeSourceId(sourceAgentId);
      const identity = handoffIdentity(source, String(threadId ?? 'unknown'));
      const fileName = `codex-handoff-${source}-${identity}.md`;
      const filePath = path.join(root, fileName);
      const temporaryPath = path.join(root, `.${fileName}.${crypto.randomBytes(8).toString('hex')}.tmp`);

      try {
        await fs.promises.writeFile(temporaryPath, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await fs.promises.rename(temporaryPath, filePath);
        await fs.promises.chmod(filePath, 0o600);
      } catch (error) {
        await fs.promises.unlink(temporaryPath).catch(() => {});
        throw error;
      }

      return {
        fileName,
        filePath,
        bytes,
        instruction: handoffReadInstruction(filePath),
      };
    },
  };
}
