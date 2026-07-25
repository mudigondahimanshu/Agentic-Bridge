import { Injectable, ToolDecorator as Tool, Widget, ExecutionContext, z } from '@nitrostack/core';
import * as path from 'path';
import { ManifestService } from './manifest.service.js';
import { WorkspaceService } from '../../shared/services/workspace.service.js';
import { StoreService } from '../../shared/services/store.service.js';
import { TargetSchema } from '../../shared/schemas/index.js';
import type { IngestedDocument } from '../../shared/services/store.service.js';

/** Chunk size tuned so a chunk is one coherent idea, not a paragraph fragment. */
const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 120;

@Injectable({ deps: [ManifestService, WorkspaceService, StoreService] })
export class SynthesisTools {
  constructor(
    private manifest: ManifestService,
    private workspace: WorkspaceService,
    private store: StoreService
  ) {}

  @Tool({
    name: 'synthesize_claude_md',
    title: 'Synthesize CLAUDE.md',
    description:
      'Distills the entire knowledge base into the CLAUDE.md manifest and writes it to disk. ' +
      'Generated deterministically with zero LLM calls: same repository in, byte-identical ' +
      'manifest out, every claim carrying its evidence path. Human-resolved conflicts are ' +
      'placed in section 0 where they override everything else. Unresolved conflicts are ' +
      'surfaced as an explicit warning rather than silently guessed at.',
    inputSchema: TargetSchema.extend({
      output_path: z
        .string()
        .optional()
        .describe('Where to write the manifest. Defaults to CLAUDE.md in the bridge project root.'),
      allow_unresolved: z
        .boolean()
        .default(false)
        .describe('Generate even with open conflicts. They are written in as an explicit warning block.'),
    }),
    examples: {
      request: {},
      response: {
        written: true,
        path: 'CLAUDE.md',
        bytes: 7412,
        sections: 6,
        unresolvedConflicts: 0,
      },
    },
  })
  @Widget('claude-manifest')
  async synthesizeClaudeMd(
    input: { target?: string; output_path?: string; allow_unresolved?: boolean },
    ctx: ExecutionContext
  ) {
    const facts = this.store.all('knowledge');
    if (!facts.length) {
      throw new Error(
        'The knowledge base is empty — there is nothing to synthesize. ' +
          'Run `run_swarm` first (or the individual reconnaissance tools).'
      );
    }

    const blocking = this.manifest.blockingConflicts();
    if (blocking.length && !input.allow_unresolved) {
      throw new Error(
        `${blocking.length} unresolved conflict(s) would make this manifest untrustworthy: ` +
          `${blocking.map((c) => c.id).join(', ')}. ` +
          `Resolve them with resolve_conflict, or pass allow_unresolved=true to generate anyway ` +
          `with an explicit warning block.`
      );
    }

    const target = this.workspace.resolveTarget(input.target);
    const result = this.manifest.write(target, input.output_path);

    const run = this.store.latestRun();
    if (run) {
      this.store.upsert('runs', {
        ...run,
        manifestPath: this.workspace.rel(this.workspace.projectRoot, result.path),
      });
    }

    ctx.logger.info('Manifest synthesized', { path: result.path, bytes: result.bytes });

    return {
      written: true,
      path: this.workspace.rel(this.workspace.projectRoot, result.path),
      absolutePath: result.path,
      bytes: result.bytes,
      lines: result.content.split('\n').length,
      factsUsed: facts.length,
      skillsDocumented: this.store.all('skills').length,
      resolvedConflicts: this.store.all('conflicts').filter((c) => c.status === 'resolved').length,
      unresolvedConflicts: blocking.length,
      content: result.content,
    };
  }

  @Tool({
    name: 'ingest_manual_document',
    title: 'Ingest a document',
    description:
      'Adds context the automated swarm could not reach — an architecture decision record in ' +
      'a wiki, a PDF the team never checked in, a Slack thread pasted as text. The document is ' +
      'chunked, embedded into the same vector space the rest of the knowledge base uses, and ' +
      'becomes searchable via query_knowledge and included in the next manifest. Accepts ' +
      'inline text or a file path.',
    inputSchema: z
      .object({
        name: z.string().min(1).describe('A short title for the document'),
        text: z.string().optional().describe('The document content as plain text'),
        file_path: z.string().optional().describe('Absolute path to a UTF-8 text/markdown file to read instead'),
        category_hint: z
          .enum(['architecture', 'testing', 'cicd', 'agile', 'consensus', 'design-system', 'manual'])
          .default('manual')
          .describe('Which section of the manifest this belongs in'),
      })
      .refine((v) => !!(v.text?.trim() || v.file_path?.trim()), {
        message: 'Provide either `text` or `file_path`.',
      }),
    examples: {
      request: { name: 'ADR-014 caching decision', text: 'Redis was rejected because…' },
      response: { ingested: true, chunks: 3, totalDocuments: 1 },
    },
  })
  @Widget('claude-manifest')
  async ingestManualDocument(
    input: { name: string; text?: string; file_path?: string; category_hint?: string },
    ctx: ExecutionContext
  ) {
    let content = input.text?.trim() ?? '';
    let mimeType = 'text/plain';

    if (!content && input.file_path) {
      const resolved = path.resolve(input.file_path);
      const text = this.workspace.read(resolved);
      if (text === null) {
        throw new Error(
          `Could not read ${resolved}. Provide a UTF-8 text or markdown file, or paste the ` +
            `content into the \`text\` parameter instead.`
        );
      }
      content = text;
      mimeType = resolved.endsWith('.md') ? 'text/markdown' : 'text/plain';
    }

    if (!content) throw new Error('Document is empty — nothing to ingest.');

    const chunks = this.chunk(content).map((text, i) => ({ id: `chunk-${i + 1}`, text }));
    const doc: IngestedDocument = {
      id: `doc-${this.slug(input.name)}`,
      name: input.name,
      mimeType,
      chars: content.length,
      chunks,
      ingestedAt: new Date().toISOString(),
    };

    const existing = this.store.all('documents').filter((d) => d.id !== doc.id);
    this.store.replace('documents', [...existing, doc]);

    // Each chunk becomes a searchable fact in the same space as everything else.
    this.store.addFacts(
      chunks.map((c) => ({
        id: `manual:${doc.id}:${c.id}`,
        agent: 'administrator',
        category: (input.category_hint ?? 'manual') as never,
        title: `${input.name} (${c.id})`,
        detail: c.text,
        evidence: [input.file_path ?? input.name],
        weight: 6, // manually injected context is trusted above parsed inference
      }))
    );

    ctx.logger.info('Document ingested', { name: input.name, chunks: chunks.length });

    return {
      ingested: true,
      document: { id: doc.id, name: doc.name, chars: doc.chars },
      chunks: chunks.length,
      totalDocuments: this.store.all('documents').length,
      nextStep: 'Re-run synthesize_claude_md to fold this into the manifest.',
    };
  }

  @Tool({
    name: 'reset_bridge',
    title: 'Reset bridge state',
    description:
      'Clears all derived state — knowledge base, runs, conflicts, pipelines, generated skill ' +
      'registry and ingested documents — so the next swarm run starts from nothing. Generated ' +
      'skill SOURCE files in src/skills/ are left on disk; delete them manually if you want a ' +
      'truly clean slate. Useful for rehearsing the demo.',
    inputSchema: z.object({
      confirm: z.boolean().describe('Must be true. Guards against an accidental wipe mid-demo.'),
    }),
    examples: { request: { confirm: true }, response: { reset: true } },
  })
  async resetBridge(input: { confirm: boolean }, ctx: ExecutionContext) {
    if (!input.confirm) {
      return { reset: false, message: 'No changes made. Pass confirm=true to actually reset.' };
    }
    this.store.reset();
    ctx.logger.warn('Bridge state reset');
    return {
      reset: true,
      message: 'All derived state cleared. Run run_swarm to rebuild.',
      note: `Generated skill sources remain in ${this.workspace.rel(this.workspace.projectRoot, this.workspace.skillsRoot)}.`,
    };
  }

  /** Split on paragraph boundaries, packing up to CHUNK_CHARS with a small overlap. */
  private chunk(text: string): string[] {
    const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const chunks: string[] = [];
    let current = '';

    for (const para of paragraphs) {
      if (current.length + para.length + 2 <= CHUNK_CHARS) {
        current = current ? `${current}\n\n${para}` : para;
        continue;
      }
      if (current) chunks.push(current);
      if (para.length <= CHUNK_CHARS) {
        current = para;
      } else {
        // A single oversized paragraph: hard-split with overlap so a sentence
        // spanning the boundary is still retrievable from one of the chunks.
        for (let i = 0; i < para.length; i += CHUNK_CHARS - CHUNK_OVERLAP) {
          chunks.push(para.slice(i, i + CHUNK_CHARS));
        }
        current = '';
      }
    }
    if (current) chunks.push(current);
    return chunks.length ? chunks : [text.slice(0, CHUNK_CHARS)];
  }

  private slug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'doc';
  }
}
