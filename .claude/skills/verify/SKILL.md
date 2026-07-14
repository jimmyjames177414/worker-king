---
name: verify
description: Run the worker-king verification gate (build → typecheck → headless tests) in order, stopping on first failure and reporting each step.
---

# /verify — worker-king verification gate

Run these checks in order from the repo root, **stopping on the first failure**. Report the result
of each step (pass / fail) and, on failure, show the relevant error output and suggest a fix.

Linting is not part of the gate — the repo has no mature repo-wide lint config yet. Verification is
gated on the compiler and tests instead.

## 1. Build all packages

```bash
pnpm build
```

Builds `packages/*` (`shared`, `core`, `voice-providers`, `app`). If this fails, stop — later steps
depend on build artifacts (e.g. the app spawns the built daemon).

## 2. Typecheck all packages

```bash
pnpm typecheck
```

Must be clean across every package. The `shared` contract change often surfaces here first.

## 3. Headless tests

```bash
pnpm test:headless
```

Runs the `shared` + `core` + `voice-providers` + `app` test suites (no GUI needed). These currently
pass on `main`.

## Reporting

- If **all three** pass, report success plainly (e.g. "build ✓, typecheck ✓, tests ✓").
- If any step fails, report which step, show the failing output, and stop — do not run later steps.
- Note that the Windows-only desktop UI (overlay/tray/hotkey via `pnpm app`) is **not** covered by
  this gate; if the change touches the Electron shell, suggest a manual `pnpm app` check on Windows.
