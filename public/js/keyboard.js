const KEYBOARD_THRESHOLD = 80;
let frame = 0;
let lastInset = 0;
let focusCount = 0;

function applyInset(inset) {
  const rounded = Math.round(inset);
  if (rounded === lastInset) return;
  lastInset = rounded;
  document.documentElement.style.setProperty('--kb-inset', `${rounded}px`);
}

function update() {
  const viewport = window.visualViewport;
  const inset = viewport
    ? Math.max(0, window.innerHeight - (viewport.offsetTop + viewport.height))
    : 0;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => applyInset(inset));
}

function isMobile() {
  return window.innerWidth <= 780;
}

export function initKeyboardInsets() {
  update();
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', update);
    window.visualViewport.addEventListener('scroll', update);
  }
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  document.addEventListener('focusin', (event) => {
    if (!isMobile() || !event.target.matches('input, textarea, [contenteditable="true"]')) return;
    focusCount += 1;
    document.body.classList.add('keyboard-open');
  });
  document.addEventListener('focusout', (event) => {
    if (!isMobile() || !event.target.matches('input, textarea, [contenteditable="true"]')) return;
    setTimeout(() => {
      focusCount = Math.max(0, focusCount - 1);
      if (focusCount === 0) document.body.classList.remove('keyboard-open');
    }, 80);
  });
}
