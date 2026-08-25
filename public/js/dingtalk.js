import { $, toast } from './dom.js';
import { post } from './http.js';
import { formatBytes } from './format.js';

const MAX_DIRECT_SHARE_BYTES = 100 * 1024 * 1024;

let fileShareInitialized = false;
let activeShareTarget = null;
let preparedShareFile = null;
let sharePrepareController = null;
let sharePrepareSequence = 0;
let sharingFile = false;

function rawFileUrl(target) {
  return `/api/artifacts/${encodeURIComponent(target.token)}/raw`;
}

function normalizedShareTarget(target) {
  if (!target?.token || target.isDirectory || target.available === false) return null;
  const size = Number(target.size);
  return {
    ...target,
    name: String(target.name || '文件'),
    size: Number.isFinite(size) && size >= 0 ? size : null,
  };
}

function setFileShareStatus(message, tone = 'neutral') {
  const status = $('#fileShareStatus');
  status.textContent = message;
  status.dataset.tone = tone;
}

function setSystemShareButton(label, disabled) {
  const button = $('#systemShareButton');
  button.textContent = label;
  button.disabled = disabled;
}

function stopSharePreparation() {
  sharePrepareController?.abort();
  sharePrepareController = null;
}

function resetFileShareState() {
  sharePrepareSequence += 1;
  stopSharePreparation();
  activeShareTarget = null;
  preparedShareFile = null;
  sharingFile = false;
}

async function shareResponseError(response) {
  const body = response.headers.get('content-type')?.includes('application/json')
    ? await response.json().catch(() => ({}))
    : null;
  return new Error(body?.message || `文件读取失败（${response.status}）`);
}

function showShareDownloadFallback(message, tone = 'warning') {
  preparedShareFile = null;
  setSystemShareButton('微信 / 其他应用', true);
  setFileShareStatus(message, tone);
}

async function prepareActiveShareFile(sequence) {
  const target = activeShareTarget;
  if (!target || sequence !== sharePrepareSequence) return;
  if (!window.isSecureContext || typeof navigator.share !== 'function'
    || typeof navigator.canShare !== 'function' || typeof File !== 'function') {
    showShareDownloadFallback('当前浏览器不能直接分享文件，请下载后从微信选择文件发送。');
    return;
  }
  if (target.size != null && target.size > MAX_DIRECT_SHARE_BYTES) {
    showShareDownloadFallback(`文件超过 ${formatBytes(MAX_DIRECT_SHARE_BYTES)}，为避免手机卡顿，请先下载后发送。`);
    return;
  }

  sharePrepareController = new AbortController();
  try {
    const response = await fetch(rawFileUrl(target), {
      credentials: 'same-origin',
      signal: sharePrepareController.signal,
    });
    if (!response.ok) throw await shareResponseError(response);
    const reportedSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(reportedSize) && reportedSize > MAX_DIRECT_SHARE_BYTES) {
      await response.body?.cancel();
      if (sequence === sharePrepareSequence) {
        showShareDownloadFallback(`文件超过 ${formatBytes(MAX_DIRECT_SHARE_BYTES)}，为避免手机卡顿，请先下载后发送。`);
      }
      return;
    }
    const blob = await response.blob();
    if (sequence !== sharePrepareSequence || target !== activeShareTarget) return;
    if (blob.size > MAX_DIRECT_SHARE_BYTES) {
      showShareDownloadFallback(`文件超过 ${formatBytes(MAX_DIRECT_SHARE_BYTES)}，为避免手机卡顿，请先下载后发送。`);
      return;
    }
    const mimeType = blob.type.split(';', 1)[0] || 'application/octet-stream';
    const file = new File([blob], target.name, {
      type: mimeType,
      lastModified: Number.isFinite(Date.parse(target.modifiedAt)) ? Date.parse(target.modifiedAt) : Date.now(),
    });
    if (!navigator.canShare({ files: [file] })) {
      showShareDownloadFallback('手机不支持直接分享这种文件格式，请下载后从微信选择文件发送。');
      return;
    }
    preparedShareFile = file;
    setFileShareStatus('文件已准备好，点击下面的按钮选择微信。', 'ready');
    setSystemShareButton('微信 / 其他应用', false);
  } catch (error) {
    if (error.name === 'AbortError' || sequence !== sharePrepareSequence) return;
    showShareDownloadFallback(error.message || '文件准备失败，请先下载后发送。', 'error');
  } finally {
    if (sequence === sharePrepareSequence) sharePrepareController = null;
  }
}

async function sharePreparedFile() {
  if (!preparedShareFile || !activeShareTarget || sharingFile) return;
  const target = activeShareTarget;
  const file = preparedShareFile;
  sharingFile = true;
  setSystemShareButton('正在打开…', true);
  setFileShareStatus('请在系统面板中选择微信或其他应用。');
  try {
    const sharePromise = navigator.share({ title: target.name, files: [file] });
    await sharePromise;
    if (target !== activeShareTarget) return;
    $('#fileShareDialog').close();
    toast('文件已交给系统分享');
  } catch (error) {
    if (target !== activeShareTarget) return;
    if (error.name === 'AbortError') {
      setFileShareStatus('已取消，可以重新选择分享应用。');
    } else {
      setFileShareStatus(error.message || '系统分享失败，请重试或下载文件。', 'error');
    }
  } finally {
    if (target === activeShareTarget && $('#fileShareDialog').open) {
      sharingFile = false;
      setSystemShareButton('微信 / 其他应用', false);
    }
  }
}

async function sendActiveFileToDingtalk() {
  const target = activeShareTarget;
  if (!target) return;
  if (!window.confirm(`确认把「${target.name}」发送到钉钉给自己？`)) return;
  const button = $('#shareDingtalkButton');
  button.disabled = true;
  try {
    await post(`/api/artifacts/${encodeURIComponent(target.token)}/send-dingtalk`, {});
    if ($('#fileShareDialog').open) $('#fileShareDialog').close();
    toast(`已发送「${target.name}」到钉钉`);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

export function openFileShare(target) {
  const normalized = normalizedShareTarget(target);
  if (!normalized) {
    toast(target?.isDirectory ? '文件夹暂不支持直接分享。' : '这个文件当前不能分享。', 'error');
    return;
  }

  stopSharePreparation();
  sharePrepareSequence += 1;
  activeShareTarget = normalized;
  preparedShareFile = null;
  sharingFile = false;
  const sequence = sharePrepareSequence;
  $('#fileShareName').textContent = normalized.name;
  $('#fileShareMeta').textContent = [
    normalized.fileKind ? String(normalized.fileKind).toUpperCase() : '',
    normalized.size != null ? formatBytes(normalized.size) : '',
  ].filter(Boolean).join(' · ');
  const download = $('#shareDownloadButton');
  download.href = `${rawFileUrl(normalized)}?download=1`;
  download.download = normalized.name;
  setFileShareStatus('正在准备文件，请稍候…', 'loading');
  setSystemShareButton('准备文件…', true);
  const dialog = $('#fileShareDialog');
  if (!dialog.open) dialog.showModal();
  void prepareActiveShareFile(sequence);
}

export function initFileShare() {
  if (fileShareInitialized) return;
  fileShareInitialized = true;
  const dialog = $('#fileShareDialog');
  $('#closeFileShareButton').addEventListener('click', () => dialog.close());
  $('#systemShareButton').addEventListener('click', sharePreparedFile);
  $('#shareDingtalkButton').addEventListener('click', sendActiveFileToDingtalk);
  $('#shareDownloadButton').addEventListener('click', () => {
    const name = activeShareTarget?.name;
    setTimeout(() => {
      if (dialog.open) dialog.close();
      if (name) toast(`已开始下载「${name}」`);
    }, 0);
  });
  dialog.addEventListener('close', resetFileShareState);
}
