import fs from 'node:fs';
import path from 'node:path';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.log', '.csv', '.tsv', '.ini', '.conf', '.env', '.properties', '.sql',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.css', '.scss',
  '.less', '.html', '.htm', '.xml', '.svg', '.java', '.kt', '.kts', '.go', '.rs',
  '.py', '.rb', '.php', '.c', '.h', '.cpp', '.hpp', '.sh', '.bash', '.zsh', '.fish',
  '.gradle', '.gitignore', '.toml', '.yaml', '.yml', '.json', '.jsonl', '.diff', '.patch',
]);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.svg']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.m4v']);
const OFFICE_EXTENSIONS = new Set(['.doc', '.docx', '.odt', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp']);
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.bz2', '.xz']);

const MIME_TYPES = {
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.gif': 'image/gif', '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon', '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4', '.m4v': 'video/mp4', '.md': 'text/markdown; charset=utf-8',
  '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ts': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.wav': 'audio/wav',
  '.webm': 'video/webm', '.webp': 'image/webp', '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8', '.yml': 'text/yaml; charset=utf-8', '.zip': 'application/zip',
};

export const IGNORED_DIRECTORIES = new Set([
  '.git', 'node_modules', '.idea', '.cache', '.gradle', '.mvn', '__pycache__',
]);

export function classifyFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown';
  if (extension === '.html' || extension === '.htm') return 'html';
  if (extension === '.pdf') return 'pdf';
  if (OFFICE_EXTENSIONS.has(extension)) return 'office';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive';
  if (TEXT_EXTENSIONS.has(extension) || ['dockerfile', 'makefile', 'license'].includes(basename)) return 'text';
  return 'binary';
}

export function mimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export function fileMetadata(filePath, basePath) {
  const stat = fs.statSync(filePath);
  return {
    name: path.basename(filePath),
    relativePath: path.relative(basePath, filePath) || '.',
    fileKind: stat.isDirectory() ? 'directory' : classifyFile(filePath),
    isDirectory: stat.isDirectory(),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

export function findRecentFiles(rootPath, options = {}) {
  const limit = options.limit ?? 50;
  const maxDepth = options.maxDepth ?? 6;
  const maxVisited = options.maxVisited ?? 12_000;
  const collected = [];
  const queue = [{ directory: rootPath, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < maxVisited) {
    const { directory, depth } = queue.shift();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++visited > maxVisited) break;
      if (entry.isSymbolicLink() || IGNORED_DIRECTORIES.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) queue.push({ directory: fullPath, depth: depth + 1 });
      } else if (entry.isFile()) {
        try { collected.push({ path: fullPath, ...fileMetadata(fullPath, rootPath) }); } catch {}
      }
    }
  }
  return collected.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt)).slice(0, limit);
}
