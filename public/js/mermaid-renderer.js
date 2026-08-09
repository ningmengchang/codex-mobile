import { escapeHtml, getMermaidSource, releaseMermaidSource } from './format.js';

let mermaidPromise = null;
let mermaidApi = null;
let renderSequence = 0;

function loadMermaid() {
  if (mermaidApi) return Promise.resolve(mermaidApi);
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/mermaid.min.js';
    script.onload = () => {
      const api = window.mermaid;
      if (!api) {
        reject(new Error('Mermaid 加载失败'));
        return;
      }
      api.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'dark',
        useMaxWidth: true,
        fontFamily: 'Inter, ui-sans-serif, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      });
      mermaidApi = api;
      resolve(api);
    };
    script.onerror = () => reject(new Error('Mermaid 加载失败'));
    document.head.append(script);
  });
  return mermaidPromise;
}

export async function renderMermaid(root = document) {
  const blocks = [...root.querySelectorAll('[data-mermaid-id]')].filter((block) => {
    if (block.dataset.mermaidRendered || block.dataset.mermaidRendering) return false;
    if (block.closest('.status-running')) return false;
    return true;
  });
  if (!blocks.length) return;
  const api = await loadMermaid();
  await Promise.all(blocks.map(async (block) => {
    block.dataset.mermaidRendering = 'true';
    const id = block.dataset.mermaidId;
    const source = getMermaidSource(id);
    if (!source) {
      block.innerHTML = '<div class="mermaid-error">流程图内容不存在</div>';
      block.dataset.mermaidRendered = 'error';
      delete block.dataset.mermaidRendering;
      return;
    }
    try {
      const renderId = `codex-mermaid-${Date.now()}-${renderSequence += 1}`;
      const result = await api.render(renderId, source);
      block.innerHTML = result.svg;
      block.dataset.mermaidRendered = 'ok';
    } catch (error) {
      block.innerHTML = `<pre class="mermaid-fallback">${escapeHtml(source)}</pre>`;
      block.dataset.mermaidRendered = 'error';
    } finally {
      releaseMermaidSource(id);
      delete block.dataset.mermaidRendering;
    }
  }));
}
