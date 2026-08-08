export const $ = (selector) => document.querySelector(selector);
export const $$ = (selector) => [...document.querySelectorAll(selector)];

export function toast(message, type = '') {
  const region = document.querySelector('#toastRegion');
  if (!region) return;
  const item = document.createElement('div');
  item.className = `toast${type ? ` ${type}` : ''}`;
  item.textContent = message;
  region.append(item);
  setTimeout(() => item.remove(), 2600);
}
