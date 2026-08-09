import { $ } from './dom.js';
import { debug } from './debug.js';

export function showThreadLoading() {
  const overlay = $('#threadLoading');
  if (!overlay) return;
  overlay.hidden = false;
  document.body.classList.add('thread-loading-active');
  $('#threadLoadingProgress').textContent = '';
  $('#promptInput').readOnly = true;
  $('#sendButton').disabled = true;
  debug.log('loading', 'show', { readOnly: true, sendDisabled: true });
}

export function hideThreadLoading() {
  const overlay = $('#threadLoading');
  if (!overlay) return;
  overlay.hidden = true;
  document.body.classList.remove('thread-loading-active');
  $('#threadLoadingProgress').textContent = '';
  $('#promptInput').readOnly = false;
  $('#sendButton').disabled = false;
  debug.log('loading', 'hide', { readOnly: false, sendDisabled: false });
}

export function updateThreadLoadingProgress(rendered, total) {
  const overlay = $('#threadLoading');
  if (!overlay || overlay.hidden) return;
  $('#threadLoadingProgress').textContent = `${rendered}/${total} 回合`;
  debug.log('loading', 'progress', { rendered, total });
}
