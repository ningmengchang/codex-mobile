import { toast } from './dom.js';
import { state } from './state.js';

export { toast };

export async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers ?? {}) } : options.headers,
  });
  const body = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    if (response.status === 401 && !url.includes('/auth/')) showLogin();
    const error = new Error(body?.message || `请求失败（${response.status}）`);
    error.status = response.status;
    error.code = body?.error;
    throw error;
  }
  return body;
}

export function post(url, body = {}) {
  return api(url, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function showLogin() {
  state.events?.close?.();
  const login = document.querySelector('#loginScreen');
  const app = document.querySelector('#app');
  if (login) login.hidden = false;
  if (app) app.hidden = true;
}
