---
name: simplify
description: Run the dry-refactor agent against uncommitted changed files. Removes dead code, redundant comments, DRY violations. Re-lints after.
---

# /simplify — dry-refactor pass on changed files

## Steps

### 1. Collect changed source files

```bash
# Uncommitted changes only (staged + unstaged, deduplicated)
{ git diff --name-only; git diff --cached --name-only; } | sort -u
```

Filter to source extensions: `.ts`, `.py`, `.html`, `.scss`, etc. Skip generated: `*.lock`, `dist/`, `lib/`, `node_modules/`.

### 2. Run dry-refactor agent

```
Agent(
  subagent_type: "dry-refactor",
  description: "Simplify changed files",
  prompt: "Clean up: <file list>. Remove dead code, redundant/useless comments, obvious DRY violations. Do NOT add features. Do NOT change behavior. Do NOT add docstrings or type annotations to code you didn't write."
)
```

### 3. Re-verify

Run the repo `/verify` command (if it exists) or the relevant test suite to confirm no behavior changes.
