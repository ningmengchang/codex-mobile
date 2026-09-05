import { $, toast } from './dom.js';

const MAX_IMAGES = 4;
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_EDGE = 3072;

function imageId() {
  return globalThis.crypto?.randomUUID?.() ?? `image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function outputName(name, mimeType) {
  const base = String(name || '图片').replace(/\.[^.]+$/, '') || '图片';
  const extension = mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.jpg';
  return `${base}${extension}`;
}

function canvasBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('图片处理失败')),
    mimeType,
    quality,
  ));
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
    } catch {}
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = 'async';
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('手机无法读取这种图片格式'));
      image.src = url;
    });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function targetSize(width, height, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function renderNormalized(decoded, width, height, mimeType, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: mimeType !== 'image/jpeg' });
  if (!context) throw new Error('浏览器无法处理图片');
  if (mimeType === 'image/jpeg') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(decoded.source, 0, 0, width, height);
  return canvasBlob(canvas, mimeType, quality);
}

async function normalizeImage(file) {
  if (!(file instanceof Blob) || !file.size) throw new Error('图片内容为空');
  if (file.size > MAX_SOURCE_BYTES) throw new Error('原始图片超过 40MB，无法在手机端处理');
  const decoded = await decodeImage(file);
  try {
    if (!decoded.width || !decoded.height) throw new Error('图片尺寸无效');
    const size = targetSize(decoded.width, decoded.height, MAX_EDGE);
    let mimeType = file.type === 'image/png'
      ? 'image/png'
      : file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
    let quality = mimeType === 'image/jpeg' ? 0.88 : 0.94;
    let blob = await renderNormalized(decoded, size.width, size.height, mimeType, quality);
    if (['image/jpeg', 'image/png', 'image/webp'].includes(blob.type)) mimeType = blob.type;
    if (blob.size > MAX_UPLOAD_BYTES) {
      const reduced = targetSize(decoded.width, decoded.height, 2048);
      mimeType = file.type === 'image/png' ? 'image/webp' : 'image/jpeg';
      quality = mimeType === 'image/jpeg' ? 0.84 : 0.9;
      blob = await renderNormalized(decoded, reduced.width, reduced.height, mimeType, quality);
      if (['image/jpeg', 'image/png', 'image/webp'].includes(blob.type)) mimeType = blob.type;
      size.width = reduced.width;
      size.height = reduced.height;
    }
    if (blob.size > MAX_UPLOAD_BYTES) throw new Error('图片优化后仍超过 8MB，请裁剪后重试');
    return {
      blob,
      mimeType,
      name: outputName(file.name, mimeType),
      width: size.width,
      height: size.height,
    };
  } finally {
    decoded.close();
  }
}

function uploadImage(item, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api/chat-images?name=${encodeURIComponent(item.name)}`);
    request.withCredentials = true;
    request.setRequestHeader('Content-Type', item.mimeType);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };
    request.onload = () => {
      let body;
      try { body = JSON.parse(request.responseText || '{}'); } catch { body = {}; }
      if (request.status >= 200 && request.status < 300 && body.image) {
        onProgress(100);
        resolve(body.image);
      } else {
        const error = new Error(body.message || `图片上传失败（${request.status}）`);
        error.code = body.error;
        reject(error);
      }
    };
    request.onerror = () => reject(new Error('图片上传失败，请检查连接后重试'));
    request.onabort = () => reject(new Error('图片上传已取消'));
    request.send(item.blob);
  });
}

export function modelSupportsImages(models, modelId) {
  const model = (models ?? []).find((item) => (item.id ?? item.model ?? item.slug) === modelId);
  const modalities = model?.inputModalities ?? model?.input_modalities;
  if (!Array.isArray(modalities)) return true;
  return modalities.some((item) => ['image', 'images', 'text_and_image'].includes(String(item).toLowerCase()));
}

export function initImageInput(options = {}) {
  const state = options.state;
  const onLayoutChange = options.onLayoutChange ?? (() => {});
  const tray = $('#imageTray');
  const sourcePopover = $('#imageSourcePopover');
  const imageButton = $('#imageButton');
  const galleryInput = $('#imageGalleryInput');
  const cameraInput = $('#imageCameraInput');
  const previewDialog = $('#chatImagePreviewDialog');
  const previewImage = $('#chatImagePreview');
  const previewTitle = $('#chatImagePreviewTitle');
  let supported = true;
  let busy = false;
  let processingQueue = Promise.resolve();

  function selected() {
    return state.selectedImages ?? (state.selectedImages = []);
  }

  function render() {
    tray.replaceChildren();
    tray.hidden = selected().length === 0;
    for (const item of selected()) {
      const card = document.createElement('div');
      card.className = 'image-draft';
      card.dataset.imageId = item.id;
      const preview = document.createElement('button');
      preview.type = 'button';
      preview.className = 'image-draft-preview';
      preview.setAttribute('aria-label', `预览 ${item.name}`);
      const image = document.createElement('img');
      image.src = item.previewUrl;
      image.alt = item.name;
      preview.append(image);
      preview.addEventListener('click', () => openPreview(item.previewUrl, item.name));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'image-draft-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `移除 ${item.name}`);
      remove.disabled = busy || item.status === 'uploading';
      remove.addEventListener('click', () => removeImage(item.id));
      card.append(preview, remove);
      if (item.status === 'processing' || item.status === 'uploading') {
        const progress = document.createElement('span');
        progress.className = 'image-draft-progress';
        progress.textContent = item.status === 'processing' ? '处理中' : `${item.progress ?? 0}%`;
        card.append(progress);
      }
      if (item.error) {
        const failed = document.createElement('span');
        failed.className = 'image-draft-progress error';
        failed.textContent = '!';
        failed.title = item.error || '图片处理失败';
        card.append(failed);
      }
      tray.append(card);
    }
    onLayoutChange();
  }

  function openPreview(url, title = '图片预览') {
    if (!url) return;
    previewImage.src = url;
    previewImage.alt = title;
    previewTitle.textContent = title;
    if (!previewDialog.open) previewDialog.showModal();
  }

  function closePreview() {
    previewDialog.close();
    previewImage.removeAttribute('src');
  }

  function removeImage(id) {
    const index = selected().findIndex((item) => item.id === id);
    if (busy || index < 0 || selected()[index].status === 'uploading') return;
    const [removed] = selected().splice(index, 1);
    URL.revokeObjectURL(removed.previewUrl);
    render();
  }

  async function addFiles(files) {
    if (busy) return;
    sourcePopover.hidden = true;
    const candidates = [...(files ?? [])].filter(Boolean);
    const available = Math.max(0, MAX_IMAGES - selected().length);
    if (candidates.length > available) toast(`一次最多选择 ${MAX_IMAGES} 张图片`, 'error');
    for (const file of candidates.slice(0, available)) {
      const item = {
        id: imageId(),
        name: file.name || '图片',
        previewUrl: URL.createObjectURL(file),
        status: 'processing',
        progress: 0,
      };
      selected().push(item);
      render();
      item.processing = processingQueue.then(() => normalizeImage(file)).then((normalized) => {
        item.blob = normalized.blob;
        item.mimeType = normalized.mimeType;
        item.name = normalized.name;
        item.width = normalized.width;
        item.height = normalized.height;
        item.status = 'ready';
        return item;
      }).catch((error) => {
        item.status = 'invalid';
        item.error = error.message;
        toast(`${item.name}：${error.message}`, 'error');
        return null;
      }).finally(render);
      processingQueue = item.processing.then(() => undefined, () => undefined);
    }
    galleryInput.value = '';
    cameraInput.value = '';
  }

  async function uploadAll() {
    const items = [...selected()];
    await Promise.all(items.map((item) => item.processing).filter(Boolean));
    if (items.some((item) => item.status === 'invalid')) {
      throw new Error('请先移除处理失败的图片');
    }
    const usable = items.filter((item) => item.blob);
    if (!usable.length && items.length) throw new Error('没有可以发送的图片');
    for (const item of usable) {
      if (item.remote?.token) continue;
      item.status = 'uploading';
      item.progress = 0;
      item.error = '';
      render();
      try {
        item.remote = await uploadImage(item, (progress) => {
          item.progress = progress;
          render();
        });
        item.status = 'uploaded';
      } catch (error) {
        item.status = 'ready';
        item.error = error.message;
        render();
        throw error;
      }
      render();
    }
    return usable.map((item) => item.remote);
  }

  function localContent(uploaded) {
    return (uploaded ?? []).map((image) => ({
      type: 'local_image',
      imageId: image.id,
      previewUrl: image.previewUrl,
      name: image.name,
    }));
  }

  function clear() {
    for (const item of selected()) URL.revokeObjectURL(item.previewUrl);
    state.selectedImages = [];
    render();
  }

  function setSupported(value) {
    supported = value !== false;
    imageButton.classList.toggle('unsupported', !supported);
    imageButton.setAttribute('aria-disabled', String(!supported));
    imageButton.title = supported ? '添加图片' : '当前模型不支持图片输入';
  }

  function setBusy(value) {
    busy = Boolean(value);
    imageButton.disabled = busy;
    galleryInput.disabled = busy;
    cameraInput.disabled = busy;
    if (busy) sourcePopover.hidden = true;
    render();
  }

  imageButton.addEventListener('click', () => {
    if (busy) return;
    if (!supported) {
      toast('当前模型不支持图片输入，请先切换模型', 'error');
      return;
    }
    if (selected().length >= MAX_IMAGES) {
      toast(`一次最多选择 ${MAX_IMAGES} 张图片`, 'error');
      return;
    }
    sourcePopover.hidden = !sourcePopover.hidden;
  });
  $('#chooseGalleryImageButton').addEventListener('click', () => {
    try { globalThis.CodexNativeUi?.requestGalleryPicker?.(); } catch {}
    galleryInput.click();
  });
  $('#takePhotoButton').addEventListener('click', () => {
    try { globalThis.CodexNativeUi?.requestCameraCapture?.(); } catch {}
    cameraInput.click();
  });
  galleryInput.addEventListener('change', () => addFiles(galleryInput.files));
  cameraInput.addEventListener('change', () => addFiles(cameraInput.files));
  $('#closeChatImagePreview').addEventListener('click', closePreview);
  previewDialog.addEventListener('cancel', (event) => { event.preventDefault(); closePreview(); });
  previewDialog.addEventListener('click', (event) => {
    if (event.target === previewDialog) closePreview();
  });
  document.addEventListener('click', (event) => {
    if (sourcePopover.hidden || event.target.closest('#imageButton, #imageSourcePopover')) return;
    sourcePopover.hidden = true;
  });

  render();
  return {
    hasImages: () => selected().length > 0,
    uploadAll,
    localContent,
    clear,
    setSupported,
    setBusy,
    openPreview,
  };
}
