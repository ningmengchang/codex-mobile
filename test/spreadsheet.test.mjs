import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readWorkbook, readWorksheet } from '../server/spreadsheet.mjs';

test('XLSX preview exposes sheets, styled cells, and merged ranges', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-xlsx-'));
  const workbookPath = path.join(directory, 'fixture.xlsx');
  const fixture = [
    'from openpyxl import Workbook',
    'from openpyxl.styles import Font, PatternFill',
    'import sys',
    'workbook = Workbook()',
    'sheet = workbook.active',
    'sheet.title = "数据"',
    'sheet["A1"] = "标题"',
    'sheet["A1"].font = Font(bold=True, color="FFFFFF")',
    'sheet["A1"].fill = PatternFill("solid", fgColor="336699")',
    'sheet.merge_cells("A1:B1")',
    'sheet["A2"] = 42',
    'sheet["B2"] = 0.25',
    'sheet["B2"].number_format = "0%"',
    'workbook.create_sheet("第二页")',
    'workbook.save(sys.argv[1])',
  ].join('\n');
  try {
    const generated = spawnSync('python3', ['-c', fixture, workbookPath], {
      encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    assert.equal(generated.status, 0, generated.stderr);
    const workbook = await readWorkbook(workbookPath);
    assert.deepEqual(workbook.sheets.map((sheet) => sheet.name), ['数据', '第二页']);
    const sheet = await readWorksheet(workbookPath, 0);
    assert.equal(sheet.data[0][0][0], '标题');
    assert.equal(sheet.data[1][0][0], '42');
    assert.equal(sheet.data[1][1][0], '25%');
    assert.deepEqual(sheet.merges[0], { startRow: 1, startColumn: 1, endRow: 1, endColumn: 2 });
    assert.equal(sheet.styles[sheet.data[0][0][1]].bold, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
