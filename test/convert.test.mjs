import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { convertOfficeToPdf } from '../server/convert.mjs';

test('Office conversion reuses a PDF that completed after an earlier timeout', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-convert-'));
  const source = path.join(directory, 'slow.xlsx');
  const cache = path.join(directory, 'cache');
  fs.writeFileSync(source, 'fixture');
  const stat = fs.statSync(source);
  const key = crypto.createHash('sha256').update(`${source}\0${stat.size}\0${stat.mtimeMs}`).digest('hex');
  const output = path.join(cache, 'office', key);
  const latePdf = path.join(output, 'slow.pdf');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(latePdf, '%PDF-1.4 late result');
  try {
    const result = await convertOfficeToPdf(source, cache);
    assert.equal(result, path.join(output, 'preview.pdf'));
    assert.equal(fs.existsSync(result), true);
    assert.equal(fs.existsSync(latePdf), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
