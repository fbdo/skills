import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildReport,
  findParallelCode,
  globToRegExp,
  inScope,
  knipItems,
  locateTool,
  loadConfig,
  makeProductionFilter,
  normalizeScope,
  parseDiagnostic,
  renderMarkdown,
  resolveOxlintConfig,
} from './refactor-audit.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'refactor-audit.mjs');

const diag = (filename, code, message) => ({
  filename,
  code,
  message,
  labels: [{ span: { line: 7 } }],
});

const clone = (a, b, lines) => ({
  lines,
  fragment: `${a}${b}`,
  firstFile: { name: a, start: 1, end: lines },
  secondFile: { name: b, start: 5, end: 5 + lines },
});

function fixtureRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'audit-fixture-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['add', '-A'], { cwd: root });
  return root;
}

test('inScope matches the path itself and its children only', () => {
  assert.ok(inScope('src/a/x.js', 'src/a'));
  assert.ok(inScope('src/a/x.js', 'src/a/x.js'));
  assert.ok(!inScope('src/ab/x.js', 'src/a'));
  assert.ok(inScope('src/a/x.js', '.'));
});

test('globToRegExp handles **, *, ? and braces', () => {
  assert.ok(globToRegExp('**/test/**').test('src/test/a.js'));
  assert.ok(globToRegExp('**/test/**').test('test/a.js'));
  assert.ok(globToRegExp('**/*.test.*').test('src/a.test.ts'));
  assert.ok(!globToRegExp('**/*.test.*').test('src/a.ts'));
  assert.ok(globToRegExp('src/*.{js,ts}').test('src/a.ts'));
  assert.ok(!globToRegExp('src/*.js').test('src/deep/a.js'));
});

test('makeProductionFilter uses defaults, sourcePaths and testGlobs', () => {
  const byDefault = makeProductionFilter();
  assert.ok(byDefault('src/a.js'));
  assert.ok(!byDefault('src/a.test.js'));
  assert.ok(!byDefault('src/a.md'));
  assert.ok(!byDefault('node_modules/x/index.js'));
  const configured = makeProductionFilter({ sourcePaths: ['lib'], testGlobs: ['**/e2e/**'] });
  assert.ok(configured('lib/a.ts'));
  assert.ok(!configured('src/a.ts'));
  assert.ok(!configured('lib/e2e/a.ts'));
});

test('parseDiagnostic extracts the rule, value and limit', () => {
  const parsed = parseDiagnostic(
    diag(
      'src/x.js',
      'eslint(complexity)',
      'async function `f` has a complexity of 43. Maximum allowed is 15.',
    ),
  );
  assert.deepEqual(
    { rule: parsed.rule, value: parsed.value, limit: parsed.limit, line: parsed.line },
    { rule: 'complexity', value: 43, limit: 15, line: 7 },
  );
});

test('buildReport filters to the path, drops tests and ranks complexity first', () => {
  const report = buildReport({
    scope: 'src/a',
    diagnostics: [
      diag('src/a/big.js', 'eslint(max-lines-per-function)', 'The function has too many lines (900). Maximum allowed is 120.'),
      diag('src/a/x.js', 'eslint(complexity)', 'function has a complexity of 20. Maximum allowed is 15.'),
      diag('src/b/y.js', 'eslint(complexity)', 'function has a complexity of 99. Maximum allowed is 15.'),
      diag('src/a/test/t.js', 'eslint(complexity)', 'function has a complexity of 99. Maximum allowed is 15.'),
    ],
    deadCode: [
      { file: 'src/a/dead.js', kind: 'exports', name: 'unused' },
      { file: 'src/b/dead.js', kind: 'exports', name: 'other' },
    ],
    clones: [clone('src/a/p.js', 'src/b/q.js', 12), clone('src/c/p.js', 'src/b/q.js', 30)],
  });
  assert.deepEqual(report.hotspots.map((h) => h.file), ['src/a/x.js', 'src/a/big.js']);
  assert.deepEqual(report.deadCode.map((d) => d.file), ['src/a/dead.js']);
  assert.equal(report.duplicates.length, 1);
  assert.deepEqual(report.summary, { hotspots: 2, deadCode: 1, duplicates: 1, parallel: 0 });
});

test('renderMarkdown lists every section and says none when empty', () => {
  const md = renderMarkdown(buildReport({ scope: 'src/a', diagnostics: [], deadCode: [], clones: [] }));
  assert.match(md, /# Refactor audit: `src\/a`/);
  assert.equal(md.match(/- none/g).length, 4);
  assert.doesNotMatch(md, /Not measured/);
});

test('renderMarkdown names analyzers that were not measured', () => {
  const md = renderMarkdown(
    buildReport({
      scope: '.',
      diagnostics: [],
      deadCode: [],
      clones: [],
      skipped: [{ check: 'dead code (knip)', reason: 'analyzer not installed in this project' }],
    }),
  );
  assert.match(md, /## Not measured\n- dead code \(knip\): analyzer not installed/);
});

test('locateTool finds project and PATH binaries and never downloads', () => {
  const root = fixtureRepo({ 'node_modules/.bin/oxlint': '#!/bin/sh\n' });
  try {
    assert.equal(locateTool(root, 'oxlint', '').command, join(root, 'node_modules', '.bin', 'oxlint'));
    assert.equal(locateTool(root, 'knip', ''), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('knipItems flattens issues by kind', () => {
  const items = knipItems({
    issues: [{ file: 'src/a.js', files: [], exports: [{ name: 'foo' }], duplicates: [[{ name: 'a' }, { name: 'b' }]] }],
  });
  assert.deepEqual(items, [
    { file: 'src/a.js', kind: 'exports', name: 'foo' },
    { file: 'src/a.js', kind: 'duplicates', name: 'a|b' },
  ]);
});

test('findParallelCode flags a name that exists outside the audited files', () => {
  const source = { 'src/one.js': 'export function computeTotals(x) {}\nfunction go() {}\n' };
  const found = findParallelCode(
    Object.keys(source),
    (f) => source[f],
    (name) => (name === 'computeTotals' ? ['src/one.js', 'src/other.js'] : []),
  );
  assert.deepEqual(found, [{ name: 'computeTotals', file: 'src/one.js', others: ['src/other.js'] }]);
});

test('normalizeScope rejects missing and outside paths', () => {
  const root = fixtureRepo({ 'src/a.js': 'x' });
  try {
    assert.equal(normalizeScope('src', root, root), 'src');
    assert.equal(normalizeScope('.', root, root), '.');
    assert.throws(() => normalizeScope('nope-xyz', root, root), /not found/);
    assert.throws(() => normalizeScope('..', root, root), /outside/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadConfig returns {} without a file and rejects malformed JSON', () => {
  const root = fixtureRepo({ 'a.js': 'x' });
  try {
    assert.deepEqual(loadConfig(root), {});
    mkdirSync(join(root, '.agents'));
    writeFileSync(join(root, '.agents', 'simplify.json'), '{ nope');
    assert.throws(() => loadConfig(root), /invalid/);
    writeFileSync(join(root, '.agents', 'simplify.json'), '{"sourcePaths":["lib"]}');
    assert.deepEqual(loadConfig(root), { sourcePaths: ['lib'] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveOxlintConfig prefers config, then the project file, then the bundled default', () => {
  const root = fixtureRepo({ '.oxlintrc.json': '{}' });
  try {
    assert.equal(resolveOxlintConfig(root, { tools: { oxlint: { config: 'x.json' } } }), join(root, 'x.json'));
    assert.equal(resolveOxlintConfig(root, {}), join(root, '.oxlintrc.json'));
    rmSync(join(root, '.oxlintrc.json'));
    assert.match(resolveOxlintConfig(root, {}), /assets\/oxlintrc\.complexity\.json$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bundled oxlint defaults are valid JSON with complexity thresholds', () => {
  const file = join(dirname(SCRIPT), '..', 'assets', 'oxlintrc.complexity.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(parsed.rules.complexity, ['error', { max: 15 }]);
});

test('CLI works with no project config and no analyzers: parallel code still found', () => {
  const root = fixtureRepo({
    'src/a/totals.js': 'export function computeTotals(items) {\n  return items.length;\n}\n',
    'src/b/totals.js': 'export function computeTotals(items) {\n  return items.length;\n}\n',
    'src/b/totals.test.js': 'export function computeTotals() {}\n',
  });
  try {
    const json = join(root, 'out.json');
    const result = spawnSync(process.execPath, [SCRIPT, 'src/a', '--json', json], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: dirname(process.execPath) + ':/usr/bin:/bin' },
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(json, 'utf8'));
    assert.deepEqual(report.parallel.map((p) => [p.name, p.others]), [['computeTotals', ['src/b/totals.js']]]);
    assert.match(result.stdout, /# Refactor audit: `src\/a`/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI fails with usage when no path is given and outside a repo', () => {
  const noPath = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(noPath.status, 2);
  assert.match(noPath.stderr, /usage/);
  const dir = mkdtempSync(join(tmpdir(), 'audit-norepo-'));
  try {
    const result = spawnSync(process.execPath, [SCRIPT, '.'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not inside a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
