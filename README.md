# skills

Fabio Oliveira's personal collection of agent skills, in the open [Agent Skills](https://agentskills.io) format. Each skill is a plain folder under `skills/<name>/` with a `SKILL.md`, so any skill-compatible harness can use it.

## Catalog

| Skill | What it does | Requirements |
|---|---|---|
| [`simplify-path`](skills/simplify-path/SKILL.md) | Remove or merge code in one path without changing behavior: audit, numbered proposal, approval stop, one commit per item behind tests and quality gates. Optional per-project config in [`.agents/simplify.json`](skills/simplify-path/references/config.md). | git, node 22+. oxlint, knip and jscpd are used when the project has them. |

## Install

### Any harness (`npx skills`)

```sh
npx skills add fbdo/skills -g                      # all skills, every detected agent
npx skills add fbdo/skills -g --skill simplify-path
npx skills add fbdo/skills --skill simplify-path   # project scope, pinned in skills-lock.json
npx skills add fbdo/skills --list                  # list without installing
```

Global installs land in `~/.agents/skills`, with symlinks for agents that use their own folder. Update with `npx skills check` then `npx skills update`. Add `-a <agent>` (for example `claude-code`, `codex`, `kiro-cli`) to target one agent.

### Claude Code

```sh
claude plugin marketplace add fbdo/skills
claude plugin install fbdo-skills@fbdo-skills
```

Skills appear namespaced, for example `/fbdo-skills:simplify-path`. For the plain `/simplify-path` name use `npx skills add fbdo/skills -g -a claude-code`.

### Codex

```sh
npx skills add fbdo/skills -g -a codex
# or: codex plugin marketplace add fbdo/skills
```

### jcode

```sh
npx skills add fbdo/skills -g
```

jcode reads `~/.agents/skills`. It also picks up the Claude Code plugin install above.

### GitHub Copilot CLI

```sh
copilot plugin marketplace add fbdo/skills
copilot plugin install fbdo-skills@fbdo-skills
```

### Manual

Copy or symlink any `skills/<name>/` folder into your harness's skills directory (`~/.agents/skills`, `~/.claude/skills`, or a project's `.agents/skills`).

## Layout

```
.claude-plugin/marketplace.json   one plugin listing every skill
skills/<name>/SKILL.md            the skill (+ scripts/, references/, assets/)
.github/workflows/validate.yml    spec, manifest, tests and private-detail checks
```

## Adding a skill

1. Create `skills/<name>/SKILL.md` with only the spec fields (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`). The name is lowercase-hyphen, equals the folder, and avoids harness built-ins such as `simplify` or `review`.
2. Add `./skills/<name>` to the `skills` list in `.claude-plugin/marketplace.json` and a row to the catalog above.
3. Keep project-specific details out. Anything specific to one repository belongs in that repository's own config.

## License

[MIT](LICENSE)
