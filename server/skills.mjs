import fs from 'node:fs';
import path from 'node:path';

function parseSkillMeta(skillFile, fallbackName) {
  let name = fallbackName;
  let description = '';
  try {
    const source = fs.readFileSync(skillFile, 'utf8');
    const match = source.match(/^---\n([\s\S]*?)\n---/);
    const meta = match ? match[1] : '';
    const nameMatch = meta.match(/^name:\s*(.+)$/m);
    if (nameMatch) name = nameMatch[1].trim();
    const descriptionMatch = meta.match(/^description:\s*(.+)$/m);
    if (descriptionMatch) description = descriptionMatch[1].trim();
    if (!description) {
      const body = source.replace(/^---[\s\S]*?---\n?/, '').trim();
      description = (body.split('\n').find((line) => line.trim()) ?? '').slice(0, 120);
    }
  } catch {}
  return { name, description };
}

export function listSkills(config) {
  const skills = [];
  const seen = new Set();
  for (const root of config.skillsRoots ?? []) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    const skillDirs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      skillDirs.push(entry.name);
      if (entry.name === '.system') {
        try {
          for (const sub of fs.readdirSync(path.join(root, entry.name), { withFileTypes: true })) {
            if (sub.isDirectory()) skillDirs.push(`.system/${sub.name}`);
          }
        } catch {}
      }
    }
    for (const dirName of skillDirs) {
      const skillFile = path.join(root, dirName, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const fallback = dirName.includes('/') ? dirName.split('/').pop() : dirName;
      const { name, description } = parseSkillMeta(skillFile, fallback);
      if (seen.has(name)) continue;
      seen.add(name);
      skills.push({ name, description });
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
