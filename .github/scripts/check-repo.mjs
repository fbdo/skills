#!/usr/bin/env node
// Repo checks: portable frontmatter, manifest sync, private-detail denylist.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SPEC_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const DENYLIST = [
  /ai-sdlc/i,
  /rw-run/i,
  /firstmate/i,
  /treehouse/i,
  /\/home\/[a-z]/i,
  /\b\d{12}\b/, // AWS account ids
  /arn:aws:/i,
  /\b[\w-]+\.(?:internal|corp|local|lan)\b/i, // internal hostnames
  /\bv2-orchestrator\b/i,
  /\bctx\.step\b/,
  /\b(?:DynamoDB|Neptune)\b/,
  /\bOpenSpec\b/i,
];
const SELF = '.github/scripts/check-repo.mjs';
const errors = [];

const skillNames = readdirSync('skills', { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

for (const name of skillNames) {
  const file = join('skills', name, 'SKILL.md');
  if (!existsSync(file)) {
    errors.push(`${file}: missing`);
    continue;
  }
  const text = readFileSync(file, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) {
    errors.push(`${file}: no frontmatter`);
    continue;
  }
  const keys = match[1].split('\n').filter((l) => /^[A-Za-z]/.test(l)).map((l) => l.split(':')[0]);
  for (const key of keys) if (!SPEC_FIELDS.has(key)) errors.push(`${file}: non-spec frontmatter key "${key}"`);
  const description = /^description:\s*(.*)$/m.exec(match[1])?.[1] ?? '';
  if (description.length > 1024) errors.push(`${file}: description over 1024 characters`);
  if (text.split('\n').length > 500) errors.push(`${file}: over 500 lines`);
}

const manifest = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8'));
const listed = manifest.plugins.flatMap((p) => p.skills ?? []).map((s) => s.replace(/^\.\/skills\//, '')).sort();
if (JSON.stringify(listed) !== JSON.stringify(skillNames))
  errors.push(`marketplace.json skills [${listed}] do not match skills/ [${skillNames}]`);
for (const plugin of manifest.plugins) if ('version' in plugin) errors.push(`plugin ${plugin.name}: remove "version"`);

const readme = readFileSync('README.md', 'utf8');
for (const name of skillNames) if (!readme.includes(`\`${name}\``)) errors.push(`README.md: skill ${name} missing from catalog`);

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
for (const file of tracked) {
  if (file === SELF) continue;
  const text = readFileSync(file, 'utf8');
  if (text.includes('\0')) continue;
  text.split('\n').forEach((line, i) => {
    for (const re of DENYLIST) if (re.test(line)) errors.push(`${file}:${i + 1}: private detail matches ${re}`);
  });
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`ok: ${skillNames.length} skill(s) checked`);
