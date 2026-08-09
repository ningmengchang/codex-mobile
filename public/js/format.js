import { marked } from '../vendor/marked.esm.js';
import DOMPurify from '../vendor/purify.js';

export const escapeAttribute = typeof CSS !== 'undefined' && CSS.escape
  ? (value) => CSS.escape(String(value))
  : (value) => String(value).replace(/"/g, '\\"');

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

const MERMAID_SOURCES = new Map();
let mermaidSequence = 0;

function mermaidPlaceholder(source) {
  const id = `mermaid-${++mermaidSequence}`;
  MERMAID_SOURCES.set(id, source.trim());
  return `<div class="mermaid-block" data-mermaid-id="${id}"><div class="mermaid-loading">正在渲染流程图…</div><pre class="mermaid-fallback" hidden>${escapeHtml(source.trim())}</pre></div>`;
}

export function getMermaidSource(id) {
  return MERMAID_SOURCES.get(id);
}

export function releaseMermaidSource(id) {
  MERMAID_SOURCES.delete(id);
}

export function markdown(value) {
  const raw = String(value ?? '');
  const source = raw.replace(/```mermaid[^\n]*\n([\s\S]*?)```/g, (_match, code) => mermaidPlaceholder(code));
  const html = marked.parse(source);
  const safe = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['data-mermaid-id'],
  });
  return safe.replace(/<table>([\s\S]*?)<\/table>/g, '<div class="markdown-table-wrap"><table class="markdown-table">$1</table></div>');
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

export function formatTime(seconds) {
  if (!seconds) return '';
  const date = new Date(seconds * 1000);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === today.toDateString()
    ? time
    : `${date.getMonth() + 1}-${date.getDate()} ${time}`;
}

export function formatTurnTime(seconds) {
  if (!seconds) return '';
  const date = new Date(Number(seconds) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  return date.toDateString() === today.toDateString() ? time : `${date.getMonth() + 1}-${date.getDate()} ${time}`;
}
