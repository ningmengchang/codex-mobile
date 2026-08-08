import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { AppError } from './security.mjs';

const activeOfficeConversions = new Map();
const activePageRenders = new Map();
const pageCountCache = new Map();

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached });
    let output = '';
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      try {
        if (detached) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
      finish(() => reject(new AppError(options.timeoutMessage ?? '文档处理超时。', 504, options.timeoutCode ?? 'DOCUMENT_TIMEOUT')));
    }, options.timeoutMs ?? 90_000);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => finish(() => {
      if (code === 0) resolve(output);
      else reject(new AppError(
        `${options.failureMessage ?? '文档处理失败'}：${output.trim() || `退出码 ${code}`}`,
        500,
        options.failureCode ?? 'DOCUMENT_FAILED',
      ));
    }));
  });
}

function fileKey(filePath) {
  const stat = fs.statSync(filePath);
  return crypto.createHash('sha256').update(`${filePath}\0${stat.size}\0${stat.mtimeMs}`).digest('hex');
}

function promoteGeneratedPdf(outputDir, cachedPdf) {
  if (fs.existsSync(cachedPdf)) return cachedPdf;
  if (!fs.existsSync(outputDir)) return null;
  const generated = fs.readdirSync(outputDir)
    .map((name) => path.join(outputDir, name))
    .find((candidate) => candidate.toLowerCase().endsWith('.pdf') && fs.statSync(candidate).size > 0);
  if (!generated) return null;
  fs.renameSync(generated, cachedPdf);
  return cachedPdf;
}

export async function convertOfficeToPdf(filePath, cacheDir) {
  const key = fileKey(filePath);
  const outputDir = path.join(cacheDir, 'office', key);
  const cachedPdf = path.join(outputDir, 'preview.pdf');
  const reusablePdf = promoteGeneratedPdf(outputDir, cachedPdf);
  if (reusablePdf) return reusablePdf;
  if (activeOfficeConversions.has(key)) return activeOfficeConversions.get(key);
  const conversion = (async () => {
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    const profileDir = path.join(outputDir, 'profile');
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    try {
      await run('libreoffice', [
        '--headless', '--nologo', '--nodefault', '--nolockcheck',
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        '--convert-to', 'pdf', '--outdir', outputDir, filePath,
      ], {
        timeoutMs: 5 * 60_000,
        timeoutMessage: 'Office 文件转换超时。',
        timeoutCode: 'CONVERSION_TIMEOUT',
        failureMessage: 'Office 文件转换失败',
        failureCode: 'CONVERSION_FAILED',
      });
    } catch (error) {
      if (error.code === 'ENOENT') throw new AppError('系统未安装 LibreOffice。', 501, 'LIBREOFFICE_MISSING');
      throw error;
    }
    const generated = promoteGeneratedPdf(outputDir, cachedPdf);
    if (!generated) throw new AppError('LibreOffice 未生成 PDF。', 500, 'CONVERSION_EMPTY');
    return generated;
  })().finally(() => activeOfficeConversions.delete(key));
  activeOfficeConversions.set(key, conversion);
  return conversion;
}

export async function getPdfPageCount(filePath) {
  const key = fileKey(filePath);
  if (pageCountCache.has(key)) return pageCountCache.get(key);
  let output;
  try {
    output = await run('pdfinfo', [filePath], {
      timeoutMs: 30_000,
      timeoutMessage: '读取 PDF 页数超时。',
      timeoutCode: 'PDF_INFO_TIMEOUT',
      failureMessage: '读取 PDF 信息失败',
      failureCode: 'PDF_INFO_FAILED',
    });
  } catch (error) {
    if (error.code === 'ENOENT') throw new AppError('系统未安装 PDF 预览组件。', 501, 'PDF_TOOLS_MISSING');
    throw error;
  }
  const match = /^Pages:\s+(\d+)\s*$/mi.exec(output);
  const pages = match ? Number.parseInt(match[1], 10) : 0;
  if (!Number.isSafeInteger(pages) || pages < 1) {
    throw new AppError('无法读取 PDF 页数，文件可能已损坏或受密码保护。', 422, 'PDF_INFO_INVALID');
  }
  if (pageCountCache.size >= 1000) pageCountCache.clear();
  pageCountCache.set(key, pages);
  return pages;
}

export async function renderPdfPage(filePath, cacheDir, pageNumber) {
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
    throw new AppError('PDF 页码无效。', 400, 'INVALID_PAGE');
  }
  const key = fileKey(filePath);
  const outputDir = path.join(cacheDir, 'pdf-pages', key);
  const pageName = `page-${String(pageNumber).padStart(4, '0')}`;
  const outputPrefix = path.join(outputDir, pageName);
  const outputPath = `${outputPrefix}.jpg`;
  if (fs.existsSync(outputPath)) return outputPath;
  const renderKey = `${key}:${pageNumber}`;
  if (activePageRenders.has(renderKey)) return activePageRenders.get(renderKey);
  const rendering = (async () => {
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    try {
      await run('pdftoppm', [
        '-f', String(pageNumber), '-l', String(pageNumber), '-singlefile',
        '-cropbox', '-scale-to-x', '1600', '-scale-to-y', '-1',
        '-jpeg', '-jpegopt', 'quality=88,optimize=y,progressive=y',
        filePath, outputPrefix,
      ], {
        timeoutMs: 60_000,
        timeoutMessage: `渲染 PDF 第 ${pageNumber} 页超时。`,
        timeoutCode: 'PDF_RENDER_TIMEOUT',
        failureMessage: `渲染 PDF 第 ${pageNumber} 页失败`,
        failureCode: 'PDF_RENDER_FAILED',
      });
    } catch (error) {
      if (error.code === 'ENOENT') throw new AppError('系统未安装 PDF 预览组件。', 501, 'PDF_TOOLS_MISSING');
      throw error;
    }
    if (!fs.existsSync(outputPath)) {
      throw new AppError(`PDF 第 ${pageNumber} 页没有生成预览图。`, 500, 'PDF_RENDER_EMPTY');
    }
    return outputPath;
  })().finally(() => activePageRenders.delete(renderKey));
  activePageRenders.set(renderKey, rendering);
  return rendering;
}
