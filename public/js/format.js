export const escapeAttribute = typeof CSS !== 'undefined' && CSS.escape
  ? (value) => CSS.escape(String(value))
  : (value) => String(value).replace(/"/g, '\\"');

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

export function markdown(value) {
  let text = escapeHtml(value);
  const blocks = [];
  text = text.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_match, language, code) => {
    const index = blocks.push(`<pre><code data-language="${escapeHtml(language.trim())}">${code}</code></pre>`) - 1;
    return `\u0000BLOCK${index}\u0000`;
  });
  text = text
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^[-*] (.+)$/gm, '• $1')
    .split(/\n{2,}/)
    .map((part) => part.startsWith('\u0000BLOCK') || /^<h[1-3]>/.test(part) ? part : `<p>${part.replace(/\n/g, '<br>')}</p>`)
    .join('');
  return text.replace(/\u0000BLOCK(\d+)\u0000/g, (_match, index) => blocks[Number(index)]);
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

export function formatTurnTime(seconds) {
  if (!seconds) return '';
  const date = new Date(Number(seconds) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  return date.toDateString() === today.toDateString() ? time : `${date.getMonth() + 1}-${date.getDate()} ${time}`;
}
