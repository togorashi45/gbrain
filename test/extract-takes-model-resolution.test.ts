/**
 * Takes-extraction model resolution regression (#2997).
 *
 * extractTakesFromPages hardcoded `anthropic:claude-haiku-4-5` as the
 * classifier model. On OAuth/local-only installs (no ANTHROPIC_API_KEY;
 * chat routed through a gateway model) every extraction died with
 * llm_unavailable even though a working chat_model was configured.
 *
 * Pins the fix's resolution order AND its config plane:
 *   opts.model → getChatModel() (file-plane gateway config, the enrich.ts
 *   idiom) — NOT the DB config plane (engine.getConfig('chat_model')).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';
import {
  extractTakesFromPages,
  getTakesExtractionModel,
} from '../src/core/extract-takes-from-pages.ts';

let engine: PGLiteEngine;
const seenModels: string[] = [];
let pageN = 0;

/** Each test seeds a fresh uncovered page so the extraction loop fires. */
async function seedPage(): Promise<void> {
  const body = 'An opinion-bearing body long enough to clear the 200-char eligibility floor. '.repeat(5);
  await engine.putPage(`concepts/model-resolution-${pageN++}`, {
    type: 'concept', title: `M${pageN}`, compiled_truth: body, frontmatter: {},
  });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  __setChatTransportForTests(async (opts) => {
    seenModels.push(opts.model ?? '(unset)');
    return {
      text: '[{"claim":"a stubbed claim","kind":"take","weight":0.7}]',
      blocks: [{ type: 'text' as const, text: '[{"claim":"a stubbed claim","kind":"take","weight":0.7}]' }],
      stopReason: 'end' as const,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: opts.model ?? '(unset)',
      providerId: 'test',
    };
  });
});

afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(() => {
  seenModels.length = 0;
});

describe('extractTakesFromPages — model resolution (#2997)', () => {
  test('defaults to the configured chat_model from the file-plane gateway config', async () => {
    configureGateway({
      chat_model: 'openai:gpt-config-plane-test',
      env: { OPENAI_API_KEY: 'sk-test-model-resolution' },
    });
    // A conflicting DB-plane value must be IGNORED — model config is the
    // config-file plane (getChatModel), not the brain DB config table.
    await engine.setConfig('chat_model', 'wrong:db-plane-model');
    await seedPage();

    const r = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(r.pages_scanned).toBe(1);
    expect(seenModels).toEqual(['openai:gpt-config-plane-test']);
  });

  test('explicit opts.model wins over the configured chat_model', async () => {
    configureGateway({
      chat_model: 'openai:gpt-config-plane-test',
      env: { OPENAI_API_KEY: 'sk-test-model-resolution' },
    });
    await seedPage();

    const r = await extractTakesFromPages(engine, {
      bootstrapEnabled: true,
      maxPages: 50,
      model: 'anthropic:claude-haiku-4-5',
    });
    expect(r.pages_scanned).toBe(1);
    expect(seenModels).toEqual(['anthropic:claude-haiku-4-5']);
  });
});

/**
 * Tiering: takes extraction is the most output-heavy phase we run, so it must
 * be settable independently of chat. The interface doc claimed `opts.model`
 * "defaults to facts.extraction_model" while the code read `getChatModel()`
 * and never consulted the key. Pins the full chain:
 *
 *   opts.model → facts.extraction_model → getChatModel()
 *
 * The chat-model tail is load-bearing: unconfigured installs (six live boxes)
 * must keep the exact #2997 behavior, so this is a no-op by default.
 */
describe('extractTakesFromPages — facts.extraction_model tiering', () => {
  beforeEach(async () => {
    await engine.setConfig('facts.extraction_model', '');
    await engine.setConfig('models.default', '');
    configureGateway({
      chat_model: 'openai:gpt-config-plane-test',
      env: { OPENAI_API_KEY: 'sk-test-model-resolution' },
    });
  });

  test('unconfigured: still resolves to the chat model (no behavior change)', async () => {
    await seedPage();
    const r = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(r.pages_scanned).toBe(1);
    expect(seenModels).toEqual(['openai:gpt-config-plane-test']);
  });

  test('facts.extraction_model overrides the chat model', async () => {
    await engine.setConfig('facts.extraction_model', 'openrouter:openai/gpt-5.6-luna');
    await seedPage();
    const r = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(r.pages_scanned).toBe(1);
    expect(seenModels).toEqual(['openrouter:openai/gpt-5.6-luna']);
  });

  test('explicit opts.model beats both', async () => {
    await engine.setConfig('facts.extraction_model', 'openrouter:openai/gpt-5.6-luna');
    await seedPage();
    const r = await extractTakesFromPages(engine, {
      bootstrapEnabled: true,
      maxPages: 50,
      model: 'anthropic:claude-haiku-4-5',
    });
    expect(r.pages_scanned).toBe(1);
    expect(seenModels).toEqual(['anthropic:claude-haiku-4-5']);
  });

  test('getTakesExtractionModel: chain is resolvable without running extraction', async () => {
    expect(await getTakesExtractionModel(engine)).toBe('openai:gpt-config-plane-test');
    await engine.setConfig('facts.extraction_model', 'openrouter:openai/gpt-5.6-terra');
    expect(await getTakesExtractionModel(engine)).toBe('openrouter:openai/gpt-5.6-terra');
    expect(await getTakesExtractionModel(engine, 'anthropic:claude-haiku-4-5'))
      .toBe('anthropic:claude-haiku-4-5');
  });
});
