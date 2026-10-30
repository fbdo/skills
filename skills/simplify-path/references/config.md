# `.agents/simplify.json`

Optional project config for `simplify-path`, read from the repository root. Every key is optional. A missing file means: detect from the project, use the bundled defaults and ask when unclear. A malformed file makes the audit script exit with an error.

## Schema

| Key | Type | Meaning | Default |
|---|---|---|---|
| `sourcePaths` | string[] | Repo-relative directories holding production code. Used by the audit's file filter, parallel-code search and jscpd fallback. | whole repo |
| `testGlobs` | string[] | Globs for test files, excluded from the audit. `**`, `*`, `?` and `{a,b}` are supported. | `**/test/**`, `**/tests/**`, `**/__tests__/**`, `**/*.test.*`, `**/*.spec.*` |
| `audit.command` | string | Command to run instead of the bundled script. | `node <skill-dir>/scripts/refactor-audit.mjs` |
| `tools.oxlint.config` | string | oxlint config path. | project `.oxlintrc.quality.json`, `.oxlintrc.json` or `oxlint.json`, else `assets/oxlintrc.complexity.json` |
| `tools.knip.config` | string | knip config path. | knip's own discovery |
| `tools.jscpd.config` | string | jscpd config path. | project `.jscpd.json`, else built-in flags (min 10 lines, 100 tokens, `sourcePaths`, `testGlobs` ignored) |
| `tests.hint` | string | How to run the tests that cover a path. Free text for the agent. | detect from `package.json` or the toolchain |
| `heavyRunner` | string | Command prefix for heavy suites (remote box, container runner). Machine specific: prefer a local, uncommitted override. | none |
| `gates.check` | string[] | Commands that must pass after each item. | project lint, type and quality scripts |
| `gates.update` | string | Command that rewrites baselines after findings drop. | none |
| `gates.baselines` | string | Glob of committed baseline files. | none |
| `protected` | string[] | Extra do-not-touch items, in plain words. Added to the skill's generic categories. | none |
| `adversarialReview.paths` | string[] | Globs whose removals need an independent review. | persistence and authorization code |
| `adversarialReview.reviewer` | string | Which reviewer to use (command or description). | a separate agent |
| `areas` | string[] | Units for recurring consolidation runs, one per run. | top-level source directories |

## Detection order

1. `.agents/simplify.json`
2. Analyzers installed in the project (`node_modules/.bin/<tool>`, then `PATH`) and the project's own tool configs
3. Bundled defaults in `assets/`

An analyzer that is not installed is skipped and listed under "Not measured" in the report. The script never installs anything. Only JavaScript and TypeScript analyzers are bundled so far. For other languages the report says no analyzer ran and the skill falls back to a manual audit.

## Example

```json
{
  "sourcePaths": ["src", "packages/api/src", "packages/web/src"],
  "testGlobs": ["**/test/**", "**/*.test.*", "**/*.spec.*", "**/e2e/**"],
  "tools": { "oxlint": { "config": "config/oxlint.json" } },
  "tests": { "hint": "npm test -- <path>; npm --prefix packages/web test" },
  "gates": {
    "check": ["npm run lint", "npm run typecheck", "npm run quality"],
    "update": "npm run quality:update",
    "baselines": "config/quality/*.json"
  },
  "protected": [
    "workflow step names and order in src/workflows (replay compatibility)",
    "database column names and stored JSON shapes",
    "the legacy v1 importer"
  ],
  "adversarialReview": {
    "paths": ["src/workflows/**", "src/auth/**"],
    "reviewer": "a separate agent"
  },
  "areas": ["packages/api/src", "packages/web/src", "src/workflows"]
}
```
