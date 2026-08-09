const DEBUG_KEY = 'codex-mobile-debug';

function isEnabled() {
  try {
    return new URLSearchParams(window.location.search).has('debug')
      || localStorage.getItem(DEBUG_KEY) === '1';
  } catch {
    return false;
  }
}

export const debug = {
  enabled: isEnabled(),
  log(area, message, detail) {
    if (!this.enabled) return;
    const line = [`[codex-mobile][${area}]`, message];
    if (detail !== undefined) line.push(detail);
    console.debug(...line);
  },
};
