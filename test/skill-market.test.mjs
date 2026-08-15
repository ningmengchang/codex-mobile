import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSkillMarket } from '../server/skill-market.mjs';

function jsonResponse(payload, ok = true, status = 200) {
  return { ok, status, json: async () => payload };
}

test('community market falls back to GitHub Search and normalizes star order', async () => {
  const skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-skill-market-'));
  const calls = [];
  const market = createSkillMarket({
    codexHome: skillsRoot,
    home: skillsRoot,
    skillsRoots: [skillsRoot],
  }, {
    fetch: async (url) => {
      calls.push(String(url));
      if (String(url).includes('agentskillshub.top')) {
        throw new Error('upstream unavailable');
      }
      return jsonResponse({
        items: [
          {
            repo_full_name: 'team/low-star',
            repo_name: 'low-star',
            description: '低热度技能',
            stargazers_count: 2,
            score: 70,
            repo_url: 'https://github.com/team/low-star',
          },
          {
            repo_full_name: 'team/hot-skill',
            repo_name: 'hot-skill',
            description: '高热度技能',
            stargazers_count: 99,
            score: 88,
            repo_url: 'https://github.com/team/hot-skill',
          },
        ],
      });
    },
  });

  const items = await market.listCommunitySkills('codex');
  assert(calls[0].includes('agentskillshub.top'));
  assert(calls[1].includes('api.github.com/search/repositories'));
  assert.equal(items[0].name, 'hot-skill');
  assert.equal(items[0].stars, 99);
  assert.equal(items[1].name, 'low-star');
  assert.equal(items[1].installed, false);

  fs.rmSync(skillsRoot, { recursive: true, force: true });
});

test('community market keeps agent hub result when upstream is available', async () => {
  const skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-skill-market-'));
  const calls = [];
  const market = createSkillMarket({
    codexHome: skillsRoot,
    home: skillsRoot,
    skillsRoots: [skillsRoot],
  }, {
    fetch: async (url) => {
      calls.push(String(url));
      if (String(url).includes('agentskillshub.top')) {
        return jsonResponse({
          items: [
            {
              repo_full_name: 'demo/top-skill',
              repo_name: 'top-skill',
              description: '社区热门',
              stars: 123,
              score: 95,
            },
          ],
        });
      }
      throw new Error('github should not be called');
    },
  });

  const items = await market.listCommunitySkills('ppt');
  assert.equal(calls.length, 1);
  assert.equal(items[0].repo, 'demo/top-skill');
  assert.equal(items[0].score, 95);

  fs.rmSync(skillsRoot, { recursive: true, force: true });
});
