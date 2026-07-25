/**
 * The bridge's connection to Claude.
 *
 * Every swarm persona and the master orchestrator reason through this service.
 * It is deliberately the only place in the project that talks to the Anthropic
 * API, so cost accounting, caching, retries, refusal handling and the
 * degradation path all exist once.
 *
 * Three properties matter more than anything else here:
 *
 *   1. **Grounding.** A persona never asks the model to recall a codebase. The
 *      deterministic parsers run first and their output is handed to the model
 *      as evidence; the model's job is judgment over that evidence, not
 *      retrieval. That is what stops it inventing a coverage threshold.
 *   2. **Structured output.** Every call is constrained by a JSON schema and
 *      then validated again with Zod on the way back, so a malformed or
 *      hallucinated shape fails loudly instead of flowing into the manifest.
 *   3. **Degradation.** If there is no API key, or the API is down, or a
 *      response fails validation, the caller gets `null` and falls back to the
 *      deterministic path. A demo that dies because a network hiccup ate one
 *      agent is not a demo.
 *
 * Model choice: `claude-opus-5` by default. Thinking is on by default on Opus 5
 * — the parameter is omitted rather than set, which is the documented way to get
 * adaptive thinking on this model. Depth is controlled with `effort` instead.
 */
import { Injectable } from '@nitrostack/core';
import Anthropic from '@anthropic-ai/sdk';

/** Default model. Override with BRIDGE_LLM_MODEL. */
export const DEFAULT_MODEL = 'claude-opus-5';

/**
 * Per-million-token prices for the default model, used for the running cost
 * readout in the swarm console. Cache writes bill at 1.25x input and cache
 * reads at 0.1x, which is what makes the shared-evidence prefix worth caching.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** USD, computed from the model's published rates. */
  costUsd: number;
}

export const ZERO_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
  costUsd: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    costUsd: a.costUsd + b.costUsd,
  };
}

/** A JSON Schema object constraining the model's response. */
export type JsonSchema = Record<string, unknown>;

export interface ReasonRequest<T> {
  /** Which persona is asking — used for logging and the console readout. */
  agent: string;
  /** The persona brief. Stable across runs, so it caches. */
  system: string;
  /**
   * The deterministic findings the model reasons over. Large and stable within
   * a run, which is exactly what the cache breakpoint is for.
   */
  evidence: string;
  /** The specific question. Volatile — deliberately last, after the breakpoint. */
  task: string;
  /** Constrains the response shape at the API level. */
  schema: JsonSchema;
  /** Second gate: validates semantics. Throw or return null to reject. */
  validate: (raw: unknown) => T;
  effort?: Effort;
  maxTokens?: number;
}

export interface ReasonResult<T> {
  value: T;
  usage: TokenUsage;
  durationMs: number;
  model: string;
}

/** Why a call did not produce a value. Surfaced rather than swallowed. */
export type LlmFailure =
  | { kind: 'disabled' }
  | { kind: 'refused'; category: string | null; explanation?: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'error'; message: string; retryable: boolean };

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export interface ToolInvocation {
  name: string;
  input: Record<string, unknown>;
  /** Rendered result, already truncated to something a context window can hold. */
  result: string;
  durationMs: number;
}

export interface AgenticResult {
  text: string;
  calls: ToolInvocation[];
  usage: TokenUsage;
  durationMs: number;
  model: string;
  /** True when the loop stopped because it hit the iteration cap. */
  truncated: boolean;
}

/** Structural view of the response fields this service reads. */
interface MessageLike {
  stop_reason?: string | null;
  stop_details?: { category?: string | null; explanation?: string } | null;
  content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  model?: string;
}

@Injectable()
export class LlmService {
  private readonly client: Anthropic | null;
  private readonly explicitlyDisabled: boolean;
  /** Cleared once a beta parameter has been rejected, so we stop resending it. */
  private useServerSideFallbacks = true;

  private cumulative: TokenUsage = { ...ZERO_USAGE };
  private callCount = 0;

  constructor() {
    this.explicitlyDisabled = process.env.BRIDGE_LLM_ENABLED === 'false';

    // The SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
    // `ant auth login` profile on its own — constructing it with no arguments
    // is what picks all three up. Constructing it is cheap and makes no
    // network call, so the only reason to skip it is an explicit opt-out.
    this.client = this.explicitlyDisabled ? null : new Anthropic({ maxRetries: 3 });
  }

  get model(): string {
    return process.env.BRIDGE_LLM_MODEL?.trim() || DEFAULT_MODEL;
  }

  get effort(): Effort {
    const configured = process.env.BRIDGE_LLM_EFFORT?.trim() as Effort | undefined;
    return configured && ['low', 'medium', 'high', 'xhigh', 'max'].includes(configured)
      ? configured
      : 'high';
  }

  /**
   * Whether a credential is actually present. Checked without a network call:
   * the SDK exposes the resolved key, and a bare-profile setup leaves it unset
   * but still authenticates, so an explicit env var is treated as the reliable
   * signal and anything else is discovered on first use.
   */
  get available(): boolean {
    if (!this.client || this.explicitlyDisabled) return false;
    return !!(
      process.env.ANTHROPIC_API_KEY?.trim() ||
      process.env.ANTHROPIC_AUTH_TOKEN?.trim() ||
      this.client.apiKey
    );
  }

  get description(): string {
    if (this.explicitlyDisabled) return 'disabled (BRIDGE_LLM_ENABLED=false)';
    if (!this.available) return 'no credential found (set ANTHROPIC_API_KEY)';
    return `${this.model} @ effort=${this.effort}`;
  }

  /** Running total across this process, for the console readout. */
  get spend(): TokenUsage & { calls: number } {
    return { ...this.cumulative, calls: this.callCount };
  }

  resetSpend(): void {
    this.cumulative = { ...ZERO_USAGE };
    this.callCount = 0;
  }

  /* ------------------------------------------------------------------ *
   * Structured reasoning — one call, schema-constrained
   * ------------------------------------------------------------------ */

  /**
   * Ask the model a question about pre-gathered evidence and get a typed answer.
   *
   * Returns a discriminated result rather than throwing: every caller here has a
   * deterministic fallback, so a failure is a branch, not an exception.
   */
  async reason<T>(
    request: ReasonRequest<T>
  ): Promise<{ ok: true; data: ReasonResult<T> } | { ok: false; failure: LlmFailure }> {
    if (!this.available || !this.client) {
      return { ok: false, failure: { kind: 'disabled' } };
    }

    const started = Date.now();
    const maxTokens = request.maxTokens ?? 8000;

    try {
      const message = (await this.createMessage({
        model: this.model,
        max_tokens: maxTokens,
        // Cache breakpoint on the last system block: the persona brief and the
        // evidence are stable within a run, the task is not, and the task lives
        // in `messages` which renders after `system`.
        system: [
          { type: 'text', text: request.system },
          {
            type: 'text',
            text: `<evidence>\n${request.evidence}\n</evidence>`,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: request.task }],
        output_config: {
          effort: request.effort ?? this.effort,
          format: { type: 'json_schema', schema: request.schema },
        },
      })) as MessageLike;

      const usage = this.accountFor(message);

      if (message.stop_reason === 'refusal') {
        return {
          ok: false,
          failure: {
            kind: 'refused',
            category: message.stop_details?.category ?? null,
            explanation: message.stop_details?.explanation,
          },
        };
      }
      if (message.stop_reason === 'max_tokens') {
        return {
          ok: false,
          failure: {
            kind: 'invalid',
            message: `Response hit the ${maxTokens}-token cap before completing its JSON.`,
          },
        };
      }

      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
        .trim();
      if (!text) {
        return { ok: false, failure: { kind: 'invalid', message: 'Model returned no text.' } };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return {
          ok: false,
          failure: { kind: 'invalid', message: 'Model response was not valid JSON.' },
        };
      }

      // Second gate. Structured outputs guarantee the shape; this checks that
      // the contents are usable — non-empty titles, known categories, and so on.
      let value: T;
      try {
        value = request.validate(parsed);
      } catch (error) {
        return {
          ok: false,
          failure: {
            kind: 'invalid',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }

      return {
        ok: true,
        data: {
          value,
          usage,
          durationMs: Date.now() - started,
          model: message.model ?? this.model,
        },
      };
    } catch (error) {
      return { ok: false, failure: this.classify(error) };
    }
  }

  /* ------------------------------------------------------------------ *
   * Agentic loop — the orchestrator's tool-calling path
   * ------------------------------------------------------------------ */

  /**
   * Run a real tool-use loop: the model decides which tools to call, this
   * service executes them and feeds the results back, and the loop continues
   * until the model stops asking.
   *
   * Written as a manual loop rather than the SDK's beta tool runner for two
   * reasons: the tools here are in-process service calls with no need for the
   * runner's schema generation, and every invocation has to be captured for the
   * swarm console — watching the orchestrator interrogate its own knowledge base
   * is the point, not an implementation detail.
   */
  async runAgentic(request: {
    agent: string;
    system: string;
    task: string;
    tools: ToolSpec[];
    execute: (name: string, input: Record<string, unknown>) => Promise<string>;
    maxIterations?: number;
    maxTokens?: number;
    effort?: Effort;
    onProgress?: (note: string) => void;
  }): Promise<{ ok: true; data: AgenticResult } | { ok: false; failure: LlmFailure }> {
    if (!this.available || !this.client) {
      return { ok: false, failure: { kind: 'disabled' } };
    }

    const started = Date.now();
    const maxIterations = request.maxIterations ?? 12;
    const maxTokens = request.maxTokens ?? 16000;
    const calls: ToolInvocation[] = [];
    let usage: TokenUsage = { ...ZERO_USAGE };
    let truncated = true;
    let finalText = '';

    // `unknown[]` rather than the SDK's param union: the loop appends raw
    // response content straight back, which is the documented requirement for
    // preserving tool_use blocks, and re-typing it buys nothing.
    const messages: unknown[] = [{ role: 'user', content: request.task }];

    try {
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        const message = (await this.createMessage({
          model: this.model,
          max_tokens: maxTokens,
          system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
          messages,
          tools: request.tools,
          output_config: { effort: request.effort ?? this.effort },
        })) as MessageLike;

        usage = addUsage(usage, this.accountFor(message));

        if (message.stop_reason === 'refusal') {
          return {
            ok: false,
            failure: {
              kind: 'refused',
              category: message.stop_details?.category ?? null,
              explanation: message.stop_details?.explanation,
            },
          };
        }

        messages.push({ role: 'assistant', content: message.content });

        // A server-side tool ran out of its own iteration budget. Re-send as-is;
        // the server resumes. Adding a "continue" user turn would break it.
        if (message.stop_reason === 'pause_turn') continue;

        const toolUses = message.content.filter((block) => block.type === 'tool_use');
        if (!toolUses.length) {
          finalText = message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text ?? '')
            .join('')
            .trim();
          truncated = false;
          break;
        }

        // All results for one assistant turn go back in a single user message —
        // splitting them teaches the model to stop calling tools in parallel.
        const results: unknown[] = [];
        for (const use of toolUses) {
          const name = use.name ?? 'unknown';
          const input = (use.input ?? {}) as Record<string, unknown>;
          request.onProgress?.(`${request.agent} → ${name}`);

          const callStarted = Date.now();
          let rendered: string;
          let isError = false;
          try {
            rendered = await request.execute(name, input);
          } catch (error) {
            rendered = `Tool failed: ${error instanceof Error ? error.message : String(error)}`;
            isError = true;
          }

          calls.push({ name, input, result: rendered, durationMs: Date.now() - callStarted });
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: rendered,
            ...(isError ? { is_error: true } : {}),
          });
        }
        messages.push({ role: 'user', content: results });
      }

      return {
        ok: true,
        data: {
          text: finalText,
          calls,
          usage,
          durationMs: Date.now() - started,
          model: this.model,
          truncated,
        },
      };
    } catch (error) {
      return { ok: false, failure: this.classify(error) };
    }
  }

  /* ------------------------------------------------------------------ *
   * Internals
   * ------------------------------------------------------------------ */

  /**
   * Issue the request with server-side refusal fallbacks, dropping to the plain
   * endpoint if the beta is rejected.
   *
   * `fallbacks: "default"` re-runs a policy-declined request on Anthropic's
   * recommended substitute inside the same call, routed by refusal category.
   * That matters here because a legacy codebase reconnaissance pass reads a lot
   * of auth middleware and CI secrets handling — benign work that sits close
   * enough to the cyber classifiers to occasionally trip one.
   */
  private async createMessage(params: Record<string, unknown>): Promise<unknown> {
    const client = this.client!;

    if (this.useServerSideFallbacks) {
      try {
        return await client.beta.messages.create({
          ...params,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        } as never);
      } catch (error) {
        // A 400 here means this account or model does not have the beta. Latch
        // it off rather than paying a failed round trip on every later call.
        if (error instanceof Anthropic.BadRequestError) {
          this.useServerSideFallbacks = false;
        } else {
          throw error;
        }
      }
    }

    return client.messages.create(params as never);
  }

  private accountFor(message: MessageLike): TokenUsage {
    const raw = message.usage ?? {};
    const rates = PRICING[this.model] ?? PRICING[DEFAULT_MODEL];

    const input = raw.input_tokens ?? 0;
    const output = raw.output_tokens ?? 0;
    const cacheWrite = raw.cache_creation_input_tokens ?? 0;
    const cacheRead = raw.cache_read_input_tokens ?? 0;

    const usage: TokenUsage = {
      input,
      output,
      cacheWrite,
      cacheRead,
      costUsd:
        (input * rates.input +
          output * rates.output +
          // Published multipliers: 1.25x input to write, 0.1x input to read.
          cacheWrite * rates.input * 1.25 +
          cacheRead * rates.input * 0.1) /
        1_000_000,
    };

    this.cumulative = addUsage(this.cumulative, usage);
    this.callCount += 1;
    return usage;
  }

  /**
   * Map an SDK error onto the failure union, most specific class first.
   * `APIConnectionError` extends `APIError` in this SDK, so it has to be tested
   * before the base class or it would never match.
   */
  private classify(error: unknown): LlmFailure {
    if (error instanceof Anthropic.AuthenticationError) {
      return {
        kind: 'error',
        message: 'Anthropic rejected the credential — check ANTHROPIC_API_KEY.',
        retryable: false,
      };
    }
    if (error instanceof Anthropic.NotFoundError) {
      return {
        kind: 'error',
        message: `Model "${this.model}" was not found. Check BRIDGE_LLM_MODEL.`,
        retryable: false,
      };
    }
    if (error instanceof Anthropic.RateLimitError) {
      return { kind: 'error', message: 'Rate limited by the Anthropic API.', retryable: true };
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return { kind: 'error', message: 'Could not reach the Anthropic API.', retryable: true };
    }
    if (error instanceof Anthropic.APIError) {
      return {
        kind: 'error',
        message: `Anthropic API error ${error.status ?? '?'}: ${error.message}`,
        retryable: (error.status ?? 0) >= 500,
      };
    }
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }
}

/** One-line rendering of a failure, for logs and the console readout. */
export function describeFailure(failure: LlmFailure): string {
  switch (failure.kind) {
    case 'disabled':
      return 'LLM reasoning disabled (no credential)';
    case 'refused':
      return `refused by safety classifiers${failure.category ? ` (${failure.category})` : ''}`;
    case 'invalid':
      return `unusable response: ${failure.message}`;
    case 'error':
      return failure.message;
  }
}
