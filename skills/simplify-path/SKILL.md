---
name: simplify-path
description: Remove or merge code in one path without changing behavior - dead code, duplicates, parallel helpers, tangled branches. Runs a bundled audit script, proposes a numbered list, waits for approval, then commits one item at a time behind tests and the project's quality gates. Use for "simplify this path", cleanup passes and recurring consolidation runs.
license: MIT
compatibility: Needs git and node 22 or newer. Complexity, dead-code and duplication checks use oxlint, knip and jscpd when the project has them installed, and are skipped otherwise.
metadata:
  version: '1.0'
---

Simplify `[path]` (a file or directory; ask if missing). Goal: fewer production lines and fewer quality findings, behavior unchanged, tests green. Success is findings going down, not a line count: a lookup map that replaces a tangled branch may add lines and is still good.

## Project config

Read `.agents/simplify.json` at the repository root if it exists (schema in `references/config.md`). It supplies the project's source paths, test commands, quality gate commands, protected items and review paths. Without it, detect what you can (`package.json` scripts, the language toolchain, existing linter configs) and ask when unclear.

Thresholds and tool settings belong to the project's own quality gates. Never copy them into this skill's output and never loosen them.

## Do not touch

Skip these even when the audit flags them. List them as "skipped, protected" in the report.

- Durable-execution or replay identifiers: names and order of persisted workflow steps, job or event type names that in-flight work depends on.
- Persisted shapes: record schemas, key formats, stored field names, serialized artifacts.
- Public API contracts: HTTP routes and payloads, event payloads, exported helper signatures used by other packages, CLI flags.
- Authentication, authorization and credential handling code.
- Legacy code the project keeps readable on purpose.
- Test files and fixtures (they may be added to, never trimmed to pass).
- Every entry in the config's `protected` list.

Removals touching code that matches the config's `adversarialReview.paths`, or any persistence or authorization code when the config does not say, need an adversarial review. After the gatekeeper passes, ask an independent reviewer (a separate agent, or the configured `adversarialReview.reviewer`) to prove behavior changed and to find a caller that dynamic imports, reflection, infrastructure code or string lookups still reach. Merge only if it finds none.

## Phase 1: Safety

1. Find the tests that cover `[path]` (the config's `tests.hint`, else `package.json` scripts or the language's test runner). Run them. Use the config's `heavyRunner` prefix for heavy or container-backed suites.
2. Red tests: stop and report. Do not simplify on red.
3. Missing coverage for code you will change: write characterization tests that pin current behavior (including odd behavior), run them green, and commit them alone (`test: characterize <path>`). Coverage is judged per item in Phase 3, so only add what the approved items need.

## Phase 2: Audit

1. Run the audit from inside the repository: `node <skill-dir>/scripts/refactor-audit.mjs [path] --json "$TMPDIR/audit.json"`, or the config's `audit.command` when set (`<skill-dir>` is the folder holding this SKILL.md). It runs knip project-wide and filters to the path (knip on one folder alone calls nearly every export unused), plus oxlint complexity and size, jscpd clones touching the path, and parallel code (a function name declared here and elsewhere). Large paths can take a while: pass `--skip dead-code,duplication,reuse` for a quick look. The "Not measured" section names any analyzer that is not installed. When no analyzer ran, do a manual audit: search for parallel names and use the language's own linters.
2. Show the top hotspots, worst complexity first, then dead code, duplicates, parallel code.
3. Read the code behind each finding before proposing. Present a numbered list. Each item states: the kind (delete, merge duplicate, reuse existing helper, flatten), the exact files, the existing code it reuses or the finding it removes, the risk, and whether it is on the protected list. Prefer deletions and merges into the existing owner over new abstractions. Duplication is cheaper than the wrong abstraction: do not propose a shared helper for code that merely looks alike. Check dead-code deletions for dynamic imports, infrastructure references and string lookups first.
4. Stop and wait for confirmation of which items to run.
   - Interactive: ask the user and wait.
   - Unattended: send the numbered list through your harness's approval or question channel and wait for the answer. Never self-approve.

## Phase 3: Execution

Process approved items one at a time, in order. For each item:

- Use guard clauses, lookup maps, deleting dead code, and merging a duplicate into the existing owner of the behavior. Extract only when two real callers already exist.
- No flags or conditionals bent onto shared code to serve a new caller. No drive-by changes outside the item.
- Run the Phase 4 checks, then commit the item alone: `refactor(<area>): <what>`. One item, one commit.

## Phase 4: Gatekeeper (per item)

All must hold:

1. Tests for `[path]` and for every caller touched are green.
2. The project's quality gates pass (the config's `gates.check` commands, else its lint, type and quality scripts). If an item's findings dropped and the project keeps baselines that now read as stale, run `gates.update` and include the smaller baseline in the item's commit. Never raise a baseline.
3. The item's own findings are gone or lower: re-run the audit for the path and compare.

Report production-only net lines (`git diff --shortstat HEAD~1 -- . ':!**/test/**' ':!**/*.test.*'`) for information. They are not a gate.

On failure, roll back only that item: `git reset --hard HEAD~1` if it was committed, or `git restore` of that item's files if not. Never `git checkout .` or anything that discards earlier items. Retry the item at most 2 times with a narrower change, then skip it and report why. Move on to the next item.

End with a report: items done (commit, findings removed, production net lines), items skipped and why, protected items, baselines before and after, new deletion candidates found out of scope (listed as follow-ups, not done).

## Recurring consolidation

A recurring run (scheduled by your harness, cron or a person) uses this skill to reduce code, not to add features.

- **Inputs**: the project's quality baselines or the audit's largest hotspots per area, and deletion candidates that earlier runs or agents reported as follow-ups.
- **Scope per run**: one area from the config's `areas`, or the top 5 hotspots across them. Never the whole repo.
- **Approval**: Phase 2's numbered list goes to a human. Only approved items run.
- **Output**: one PR with one commit per item, net-negative production lines, behavior unchanged, tests and gates green, smaller baselines committed.
- **Tracking**: success is the finding counts shrinking run over run, plus the PR's production net lines. A run that finds nothing safe to remove reports that and opens no PR.
