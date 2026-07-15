/**
 * WorkerKing eval harness (N10) — opt-in behavioral regression checks.
 *
 * Deliberately OUTSIDE the CI `test:headless` gate (run with `pnpm eval`): the
 * golden tier is deterministic and cheap; the optional LLM tier needs a real
 * Claude login and network, so it is gated behind `WORKERKING_EVAL_LLM=1` and
 * skips cleanly when Claude isn't reachable. Voice output is fuzzy — this is the
 * "test voice patterns early" lesson, kept where it won't slow the build.
 *
 * Add goldens to the tables below as new routing/persona/speech behaviors land.
 */
import {
  routeRequest,
  sanitizeForSpeech,
  SentenceChunker,
  type CapabilityManifestEntry,
} from '@workerking/shared';
import { assemblePersonaAppend } from '../persona/assemblePersona.js';
import { probeClaude, createClaudeBackend } from '../claude/createClaudeBackend.js';
import { createToolPolicy } from '../claude/toolPolicy.js';

export interface CaseResult {
  suite: string;
  name: string;
  ok: boolean;
  detail?: string;
}

// --- Routing goldens: a free-text request should rank the right capability first.
const MANIFEST: CapabilityManifestEntry[] = [
  { kind: 'command', name: 'deploy', description: 'Deploy the app to production', source: 'user' },
  { kind: 'skill', name: 'summarize', description: 'Summarize a document or webpage', source: 'user' },
  { kind: 'agent', name: 'test-writer', description: 'Write unit tests for code', source: 'project' },
  { kind: 'command', name: 'commit', description: 'Create a git commit with a message', source: 'builtin' },
];
const ROUTING: Array<{ query: string; expect: string }> = [
  { query: 'deploy my app to prod', expect: 'deploy' },
  { query: 'write unit tests for this function', expect: 'test-writer' },
  { query: 'summarize this article for me', expect: 'summarize' },
  { query: 'commit these changes', expect: 'commit' },
];

function checkRouting(): CaseResult[] {
  return ROUTING.map(({ query, expect }) => {
    const top = routeRequest(query, MANIFEST, { limit: 1 })[0]?.entry.name;
    return {
      suite: 'routing',
      name: query,
      ok: top === expect,
      detail: top === expect ? undefined : `expected "${expect}", got "${top ?? '(none)'}"`,
    };
  });
}

// --- Speech goldens: markdown/reasoning must be flattened before TTS.
const SPEECH: Array<{ name: string; input: string; include?: string[]; exclude?: string[] }> = [
  { name: 'strips think block', input: '<think>plan</think>Hello.', exclude: ['plan', '<think>'], include: ['Hello.'] },
  { name: 'code fence not read aloud', input: 'Run:\n```\nrm -rf /\n```\ndone', exclude: ['rm -rf', '```'] },
  { name: 'emphasis unwrapped', input: 'Use **bold** and `code`.', include: ['bold', 'code'], exclude: ['**', '`'] },
];

function checkSpeech(): CaseResult[] {
  const out: CaseResult[] = SPEECH.map(({ name, input, include, exclude }) => {
    const said = sanitizeForSpeech(input);
    const missing = (include ?? []).filter((s) => !said.includes(s));
    const leaked = (exclude ?? []).filter((s) => said.includes(s));
    const ok = missing.length === 0 && leaked.length === 0;
    return {
      suite: 'speech',
      name,
      ok,
      detail: ok ? undefined : `missing=[${missing}] leaked=[${leaked}] → "${said}"`,
    };
  });

  // Streaming: sentences should surface at their boundaries.
  const chunker = new SentenceChunker();
  const first = chunker.push('Hello there. How ');
  out.push({
    suite: 'speech',
    name: 'chunker emits first sentence early',
    ok: first.length === 1 && first[0] === 'Hello there.',
    detail: `got ${JSON.stringify(first)}`,
  });
  return out;
}

// --- Persona goldens: the assembled system-prompt append reflects config.
function checkPersona(): CaseResult[] {
  const append = assemblePersonaAppend({ assistantName: 'Bea', personality: 'calm and precise' });
  return [
    {
      suite: 'persona',
      name: 'includes assistant name',
      ok: append.includes('Bea'),
      detail: append.includes('Bea') ? undefined : `no name in "${append.slice(0, 80)}…"`,
    },
    {
      suite: 'persona',
      name: 'includes personality',
      ok: append.toLowerCase().includes('calm'),
    },
  ];
}

export function runGoldenSuites(): CaseResult[] {
  return [...checkRouting(), ...checkSpeech(), ...checkPersona()];
}

/**
 * Optional LLM tier: a smoke-level quality check against the real brain. Gated
 * behind WORKERKING_EVAL_LLM=1 and a reachable Claude; skips cleanly otherwise so
 * the harness is always runnable. Runs read-only (no mutating tools).
 */
async function runLlmTier(): Promise<CaseResult[]> {
  if (process.env.WORKERKING_EVAL_LLM !== '1') {
    console.log('LLM tier: skipped (set WORKERKING_EVAL_LLM=1 to enable)');
    return [];
  }
  const health = await probeClaude();
  if (!health.ok) {
    console.log(`LLM tier: skipped (Claude unavailable: ${health.detail ?? 'unknown'})`);
    return [];
  }
  const backend = createClaudeBackend({ canUseTool: createToolPolicy({ mode: () => 'readonly' }) });
  try {
    const reply = await backend.respond(
      'What is the capital of France? Answer with just the city name.',
      () => {},
    );
    const ok = /paris/i.test(reply);
    return [{ suite: 'llm', name: 'answers a factual question', ok, detail: ok ? undefined : `got "${reply}"` }];
  } catch (err) {
    return [{ suite: 'llm', name: 'answers a factual question', ok: false, detail: String(err) }];
  }
}

async function main(): Promise<void> {
  const results = [...runGoldenSuites(), ...(await runLlmTier())];
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} [${r.suite}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

// Run only when invoked directly (node dist/eval/runEval.js), not when imported.
const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('runEval.ts') || process.argv[1].endsWith('runEval.js'));
if (isDirectRun) {
  void main();
}
