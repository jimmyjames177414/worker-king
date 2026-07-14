# Development Workflow

The worker-king dev loop. There is no external issue tracker or CI to coordinate with — the repo has
no git remote yet — so the loop is local: branch, build, implement, tidy, verify, commit.

## Steps

1. **Branch** — start feature work off `main`:
   ```bash
   git checkout -b <kebab-case-feature>
   ```
   (Plans, when written, live under `plans/` per `.claude/settings.json`.)

2. **Establish a green baseline** — before touching code, confirm the tree builds and typechecks so
   later failures are clearly yours:
   ```bash
   pnpm install       # if deps changed / fresh clone
   pnpm build
   pnpm typecheck
   ```

3. **Implement** — follow the architecture rules in `CLAUDE.md`. Change the WS protocol / schemas in
   `packages/shared` first, then let `pnpm typecheck` surface the fallout across `core`, `app`, and
   `voice-providers`. Keep the daemon free of Electron imports.

4. **Simplify** — run `/simplify` to make a dry-refactor pass over your uncommitted changes (dead
   code, redundant comments, DRY violations). It re-verifies afterward.

5. **Verify** — run `/verify`. It runs the ordered gate `pnpm build → pnpm typecheck →
   pnpm test:headless`, stopping on the first failure. For UI changes that need a real desktop,
   additionally launch `pnpm app` on Windows and sanity-check the overlay/chat.

6. **Commit** — once verify is green:
   ```bash
   git add -A
   git commit -m "<what changed and why>"
   ```
   Keep commits scoped to one logical change.

## Rules

- **Never assume ambiguous spec values — always ask.** If a request mentions a model name, config
  key, port, or identifier that could be misread, confirm the exact value before writing code.
- **Never start coding before an approved plan** for non-trivial work. If the user says "just do
  it", restate the plan in the same reply, then proceed.
- **Keep the tree green** — don't commit with a failing `pnpm typecheck` or `pnpm test:headless`.
