#!/usr/bin/env node
// Refactor audit for the simplify-path skill.
//
// Usage: node refactor-audit.mjs <path> [--json <file>] [--top <n>] [--skip dead-code,duplication,reuse]
//
// Run it from inside the git repository you want to audit. It reports, for one
// file or directory, ranked worst first:
//   1. complexity and size findings (oxlint)
//   2. dead code (knip run project-wide, then filtered to the path)
//   3. duplicated code (jscpd clones touching the path)
//   4. parallel code (a function declared in the path that another production
//      file also declares: a candidate for reuse of an existing helper)
//
// Self-contained: Node >= 22, no npm dependencies. Analyzers are looked up in
// the project (node_modules/.bin, then PATH) and any analyzer that
// is not installed is skipped and named in the report. Settings come from, in
// order: .agents/simplify.json, the project's own tool config, the bundled
// defaults in ../assets. Markdown goes to stdout; --json also writes the report.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BUFFER = 1024 * 1024 * 1024;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const ALWAYS_EXCLUDED = /(^|\/)(node_modules|dist|build|\.build|coverage|vendor)\//;
const DEFAULT_TEST_GLOBS = ['**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*'];
const OXLINT_CONFIG_CANDIDATES = ['.oxlintrc.quality.json', '.oxlintrc.json', 'oxlint.json'];
const JSCPD_CONFIG_CANDIDATES = ['.jscpd.json'];
const FUNCTION_DECLARATION = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
/** Names too common to mean "the same helper". */
const GENERIC_NAMES = new Set(['handler', 'main', 'run', 'init', 'setup', 'default', 'App']);

/** Translate a glob (`**`, `*`, `?`, `{a,b}`) to an anchored RegExp over repo-relative paths. */
export function globToRegExp(glob) {
  let out = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      braces++;
      out += '(?:';
    } else if (c === '}' && braces > 0) {
      braces--;
      out += ')';
    } else if (c === ',' && braces > 0) out += '|';
    else out += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** True when `file` is `scope` or inside it (both repo-relative, no trailing slash). */
export function inScope(file, scope) {
  return scope === '.' || file === scope || file.startsWith(`${scope}/`);
}

/** Build the "is this a production source file" predicate from the project config. */
export function makeProductionFilter(config = {}) {
  const sourcePaths = config.sourcePaths?.length ? config.sourcePaths : ['.'];
  const testMatchers = (config.testGlobs ?? DEFAULT_TEST_GLOBS).map(globToRegExp);
  return (file) =>
    SOURCE_FILE.test(file) &&
    sourcePaths.some((dir) => inScope(file, dir.replace(/\/+$/, '') || '.')) &&
    !ALWAYS_EXCLUDED.test(file) &&
    !testMatchers.some((re) => re.test(file));
}

/** The measured value and rule name of an oxlint diagnostic, e.g. complexity 43. */
export function parseDiagnostic(diagnostic) {
  const rule = diagnostic.code.replace(/^eslint\((.*)\)$/, '$1');
  const value = /(?:complexity of |\()(\d+)/.exec(diagnostic.message);
  const limit = /Maximum allowed is (\d+)/.exec(diagnostic.message);
  return {
    file: diagnostic.filename,
    line: diagnostic.labels?.[0]?.span?.line ?? 1,
    rule,
    value: value ? Number(value[1]) : null,
    limit: limit ? Number(limit[1]) : null,
    message: diagnostic.message,
  };
}

/** Stable short hash of the cloned text, so line shifts keep the identity. */
export function cloneHash(clone) {
  return createHash('sha1')
    .update(clone.fragment.replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 10);
}

/**
 * Pure assembly of the report from raw tool output, so it can be tested with
 * fixtures. Hotspots are ordered by how far past its limit a finding is.
 */
export function buildReport({
  scope,
  diagnostics,
  deadCode,
  clones,
  parallel = [],
  skipped = [],
  isProduction = makeProductionFilter(),
}) {
  const hotspots = diagnostics
    .map(parseDiagnostic)
    .filter((d) => inScope(d.file, scope) && isProduction(d.file))
    .toSorted(
      (a, b) =>
        isComplexity(b) - isComplexity(a) ||
        severity(b) - severity(a) ||
        a.file.localeCompare(b.file),
    );

  const dead = deadCode
    .filter((item) => inScope(item.file, scope))
    .toSorted((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));

  const duplicates = clones
    .filter(
      (clone) => inScope(clone.firstFile.name, scope) || inScope(clone.secondFile.name, scope),
    )
    .map((clone) => ({
      hash: cloneHash(clone),
      lines: clone.lines,
      first: location(clone.firstFile),
      second: location(clone.secondFile),
    }))
    .toSorted((a, b) => b.lines - a.lines);

  return {
    scope,
    summary: {
      hotspots: hotspots.length,
      deadCode: dead.length,
      duplicates: duplicates.length,
      parallel: parallel.length,
    },
    skipped,
    hotspots,
    deadCode: dead,
    duplicates,
    parallel,
  };
}

function isComplexity(d) {
  return d.rule === 'complexity' ? 1 : 0;
}

function severity(d) {
  return d.value && d.limit ? d.value / d.limit : 1;
}

function location(file) {
  return `${file.name}:${file.start}-${file.end}`;
}

/** Markdown summary: worst complexity first, then dead code, duplicates, parallel code. */
export function renderMarkdown(report, { top = 15 } = {}) {
  const { summary } = report;
  const skipped = report.skipped ?? [];
  const lines = [
    `# Refactor audit: \`${report.scope}\``,
    '',
    `${summary.hotspots} complexity/size hotspots, ${summary.deadCode} dead-code findings, ${summary.duplicates} duplicated clones, ${summary.parallel} parallel-code candidates.`,
    '',
    ...(skipped.length
      ? [
          '## Not measured',
          ...skipped.map((s) => `- ${s.check}: ${s.reason}`),
          ...(skipped.some((s) => s.check === 'all analyzers')
            ? ['- No supported analyzers ran: do a manual audit (search for parallel names, use the language linters).']
            : []),
          '',
        ]
      : []),
    `## Complexity and size (top ${Math.min(top, summary.hotspots)})`,
    ...listOrNone(
      report.hotspots
        .slice(0, top)
        .map(
          (d) => `- \`${d.file}:${d.line}\` ${d.rule}${d.value ? ` ${d.value}/${d.limit}` : ''}`,
        ),
    ),
    '',
    '## Dead code (knip, project-wide run filtered to the path)',
    ...listOrNone(report.deadCode.map((d) => `- \`${d.file}\` ${d.kind}: ${d.name}`)),
    '',
    '## Duplicated code (jscpd)',
    ...listOrNone(
      report.duplicates.map((d) => `- ${d.lines} lines: \`${d.first}\` and \`${d.second}\``),
    ),
    '',
    '## Parallel code (same function name declared elsewhere: check for an existing helper)',
    ...listOrNone(
      report.parallel.map(
        (p) =>
          `- \`${p.name}\` in \`${p.file}\` also declared in ${p.others.map((o) => `\`${o}\``).join(', ')}`,
      ),
    ),
    '',
  ];
  return lines.join('\n');
}

function listOrNone(items) {
  return items.length ? items : ['- none'];
}

/**
 * Function names declared in `files` that another production file also declares.
 * `findOthers(name)` returns the repo files declaring `name` (defaults to git grep).
 */
export function findParallelCode(files, readSource, findOthers) {
  const declared = new Map();
  for (const file of files) {
    for (const line of readSource(file).split('\n')) {
      const name = FUNCTION_DECLARATION.exec(line)?.[1];
      if (name && name.length > 4 && !GENERIC_NAMES.has(name)) declared.set(name, file);
    }
  }
  const result = [];
  for (const [name, file] of declared) {
    const others = findOthers(name).filter((other) => other !== file && !files.includes(other));
    if (others.length) result.push({ name, file, others: others.slice(0, 5) });
  }
  return result.toSorted((a, b) => a.name.localeCompare(b.name));
}

export function normalizeScope(input, root, cwd = process.cwd()) {
  const absolute = resolve(cwd, input);
  if (!existsSync(absolute)) throw new Error(`path not found: ${input}`);
  const scope = relative(root, absolute);
  if (scope.startsWith('..')) throw new Error(`path is outside the repository: ${input}`);
  return scope === '' ? '.' : scope;
}

/** Read `.agents/simplify.json` if present; a malformed file is an error, a missing one is not. */
export function loadConfig(root) {
  const file = join(root, '.agents', 'simplify.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`invalid ${file}: ${error.message}`);
  }
}

/** Pick the oxlint config: simplify.json, then the project's own, then the bundled default. */
export function resolveOxlintConfig(root, config) {
  const configured = config.tools?.oxlint?.config;
  if (configured) return resolve(root, configured);
  const own = OXLINT_CONFIG_CANDIDATES.find((name) => existsSync(join(root, name)));
  return own ? join(root, own) : join(SKILL_DIR, 'assets', 'oxlintrc.complexity.json');
}

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
}

/** How to invoke an installed tool (project node_modules/.bin, then PATH), or null. Never downloads. */
export function locateTool(root, name, pathEnv = process.env.PATH ?? '') {
  const candidates = [join(root, 'node_modules', '.bin'), ...pathEnv.split(delimiter).filter(Boolean)];
  for (const dir of candidates) {
    const file = join(dir, name);
    if (existsSync(file)) return { command: file, args: [] };
  }
  return null;
}

function oxlintDiagnostics(root, tool, files, config) {
  const args = [...tool.args, '-c', resolveOxlintConfig(root, config), '-f', 'json'];
  for (const ignore of config.testGlobs ?? DEFAULT_TEST_GLOBS) args.push('--ignore-pattern', ignore);
  args.push(...files);
  const { stdout, stderr } = run(tool.command, args, root);
  try {
    return JSON.parse(stdout).diagnostics;
  } catch {
    throw new Error(`oxlint did not produce JSON:\n${stdout}\n${stderr}`);
  }
}

const KNIP_KINDS = [
  'files',
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
  'unlisted',
  'binaries',
  'unresolved',
  'exports',
  'types',
  'enumMembers',
  'namespaceMembers',
  'duplicates',
];

/** Flatten a knip JSON report into `{ file, kind, name }` items. */
export function knipItems(report) {
  const items = [];
  for (const entry of report.issues) {
    for (const kind of KNIP_KINDS) {
      if (kind === 'files') {
        if (Array.isArray(entry.files) ? entry.files.length : entry.files)
          items.push({ file: entry.file, kind: 'files', name: '*' });
        continue;
      }
      for (const item of entry[kind] ?? []) {
        const name = Array.isArray(item) ? item.map((i) => i.name).join('|') : item.name;
        items.push({ file: entry.file, kind, name });
      }
    }
  }
  return items;
}

function deadCodeItems(root, tool, config) {
  const args = [...tool.args, '--reporter', 'json', '--no-exit-code', '--no-config-hints'];
  const knipConfig = config.tools?.knip?.config;
  if (knipConfig) args.push('--config', resolve(root, knipConfig));
  const { stdout, stderr } = run(tool.command, args, root);
  try {
    return knipItems(JSON.parse(stdout.slice(stdout.indexOf('{'))));
  } catch {
    throw new Error(`knip did not produce JSON:\n${stdout}\n${stderr}`);
  }
}

function jscpdClones(root, tool, config) {
  const out = mkdtempSync(join(tmpdir(), 'jscpd-'));
  try {
    const args = [...tool.args, '--silent', '--no-tips', '-r', 'json', '-o', out];
    const configured = config.tools?.jscpd?.config;
    const own = JSCPD_CONFIG_CANDIDATES.find((name) => existsSync(join(root, name)));
    if (configured) args.push('--config', resolve(root, configured));
    else if (!own) {
      args.push('--min-lines', '10', '--min-tokens', '100', '--format', 'javascript,typescript,tsx,jsx');
      const ignores = [...(config.testGlobs ?? DEFAULT_TEST_GLOBS), '**/node_modules/**'];
      args.push('--ignore', ignores.join(','));
      args.push(...(config.sourcePaths?.length ? config.sourcePaths : ['.']));
    }
    const { stderr, status } = run(tool.command, args, root);
    if (status !== 0 && status !== 1) throw new Error(`jscpd failed (${status}):\n${stderr}`);
    return JSON.parse(readFileSync(join(out, 'jscpd-report.json'), 'utf8')).duplicates;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function gitLines(root, args) {
  return run('git', args, root).stdout.split('\n').filter(Boolean);
}

function parseArgs(argv) {
  const options = { top: 15, skip: new Set() };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') options.json = argv[++i];
    else if (argv[i] === '--top') options.top = Number(argv[++i]);
    else if (argv[i] === '--skip') for (const s of argv[++i].split(',')) options.skip.add(s);
    else rest.push(argv[i]);
  }
  options.path = rest[0];
  return options;
}

function repoRoot() {
  const { stdout, status } = run('git', ['rev-parse', '--show-toplevel'], process.cwd());
  if (status !== 0) throw new Error('not inside a git repository');
  return stdout.trim();
}

/** Run one analyzer, or record why it was not measured. */
function measure({ check, tool, skipped, skip, fallback, work }) {
  if (skip) return fallback;
  if (!tool) {
    skipped.push({ check, reason: 'analyzer not installed in this project' });
    return fallback;
  }
  try {
    return work(tool);
  } catch (error) {
    skipped.push({ check, reason: error.message.replace(/\s+/g, ' ').slice(0, 200) });
    return fallback;
  }
}

function main(argv) {
  const options = parseArgs(argv);
  if (!options.path) {
    console.error(
      'usage: node refactor-audit.mjs <path> [--json <file>] [--top <n>] [--skip dead-code,duplication,reuse]',
    );
    return 2;
  }
  const root = repoRoot();
  const config = loadConfig(root);
  const scope = normalizeScope(options.path, root);
  const isProduction = makeProductionFilter(config);
  const files = gitLines(root, ['ls-files', '--', scope]).filter(isProduction);
  const skipped = [];
  const tools = {
    oxlint: locateTool(root, 'oxlint'),
    knip: options.skip.has('dead-code') ? null : locateTool(root, 'knip'),
    jscpd: options.skip.has('duplication') ? null : locateTool(root, 'jscpd'),
  };
  const diagnostics = measure({
    check: 'complexity (oxlint)',
    tool: tools.oxlint,
    skipped,
    skip: !files.length,
    fallback: [],
    work: (tool) => oxlintDiagnostics(root, tool, files, config),
  });
  const deadCode = measure({
    check: 'dead code (knip)',
    tool: tools.knip,
    skipped,
    skip: options.skip.has('dead-code'),
    fallback: [],
    work: (tool) => deadCodeItems(root, tool, config),
  });
  const clones = measure({
    check: 'duplication (jscpd)',
    tool: tools.jscpd,
    skipped,
    skip: options.skip.has('duplication'),
    fallback: [],
    work: (tool) => jscpdClones(root, tool, config),
  });
  if (!tools.oxlint && !tools.knip && !tools.jscpd && skipped.length >= 1)
    skipped.push({ check: 'all analyzers', reason: 'none installed' });
  const sourcePaths = config.sourcePaths?.length ? config.sourcePaths : ['.'];
  const parallel = options.skip.has('reuse')
    ? []
    : findParallelCode(
        files,
        (f) => readFileSync(resolve(root, f), 'utf8'),
        (name) =>
          gitLines(root, [
            'grep',
            '-lE',
            `^(export )?(async )?function \\*?\\s*${name}\\b`,
            '--',
            ...sourcePaths,
          ]).filter(isProduction),
      );
  const report = buildReport({ scope, diagnostics, deadCode, clones, parallel, skipped, isProduction });
  if (options.json) writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
  console.log(renderMarkdown(report, { top: options.top }));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
