# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Joshbond123/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Joshbond123/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an AI-written edit to a tree of text files. It reads the four formats models write — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — finds the lines each edit names at the first of three matching tiers, and changes every file or none, exactly as SPEC.md says.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a file, or `-` (the default) for standard input. `--format` is `unified`, `search-replace`, `v4a`, `json` or `auto`. `--check` reports what would change without writing. `--strict` matches lines exactly (tier 0 only).

The tool prints one line per changed path (`A`, `D`, `M`, `R`) and `ok: <n> files` on success; on failure it prints `error: <code> <path>` for each failed edit and `failed: <k> of <n> edits`, writing nothing. Usage, unreadable patches, undetectable formats and parse faults exit 2 with a single line. Standard error is never used.

Node 22 and its standard library alone: no install step, no dependencies.

---

<sub>Entered on [make.fun](https://make.fun/?ref=yv4af79c&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
