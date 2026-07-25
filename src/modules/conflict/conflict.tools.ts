import { Injectable, ToolDecorator as Tool, Widget, ExecutionContext, z } from '@nitrostack/core';
import { ConflictService, DRIFT_THRESHOLD, CONTRADICTION_THRESHOLD } from './conflict.service.js';
import { AgileService } from '../agile/agile.service.js';
import { StoreService } from '../../shared/services/store.service.js';
import { ConflictResolutionSchema } from '../../shared/schemas/index.js';

@Injectable({ deps: [ConflictService, AgileService, StoreService] })
export class ConflictTools {
  constructor(
    private conflicts: ConflictService,
    private agile: AgileService,
    private store: StoreService
  ) {}

  @Tool({
    name: 'detect_conflicts',
    title: 'Detect context conflicts',
    description:
      'Cross-references the Jira sprint against the Teams transcript and raises a conflict ' +
      'wherever the written ticket and the spoken decision disagree. Scores every pair on two ' +
      'axes: cosine ALIGNMENT (are they about the same thing?) and decision DIVERGENCE (do they ' +
      'choose differently?). A contradiction is high alignment plus high divergence — the case ' +
      'a similarity threshold alone provably cannot catch. Emits an interactive resolution widget.',
    inputSchema: z.object({
      jira_source: z.string().optional().describe('Override path to the Jira fixture'),
      transcript_source: z.string().optional().describe('Override path to the transcript fixture'),
    }),
    examples: {
      request: {},
      response: {
        conflictCount: 1,
        conflicts: [
          {
            id: 'conflict-AUR-4471-decision-3',
            kind: 'contradiction',
            topic: 'redis, memcached, cache',
            similarity: 0.41,
            divergence: 1,
            recommendation: 'b',
          },
        ],
      },
    },
  })
  @Widget('conflict-resolver')
  async detectConflicts(
    input: { jira_source?: string; transcript_source?: string },
    ctx: ExecutionContext
  ) {
    const sprint = this.agile.loadSprint(input.jira_source);
    const transcript = this.agile.loadTranscript(input.transcript_source);

    const conflicts = this.conflicts.detect(sprint, transcript);
    const open = conflicts.filter((c) => c.status === 'open');

    ctx.logger.info('Conflict detection complete', {
      total: conflicts.length,
      open: open.length,
    });

    return {
      conflictCount: conflicts.length,
      openCount: open.length,
      thresholds: { driftBelow: DRIFT_THRESHOLD, contradictionAtOrAbove: CONTRADICTION_THRESHOLD },
      sources: { jira: `${sprint.board} / ${sprint.sprint.name}`, teams: transcript.title },
      conflicts,
      nextStep: open.length
        ? 'Resolve each conflict in the widget, or call resolve_conflict with the conflict_id.'
        : 'No open conflicts. Safe to synthesize the CLAUDE.md manifest.',
    };
  }

  @Tool({
    name: 'resolve_conflict',
    title: 'Resolve a conflict',
    description:
      'Records the administrator\'s authoritative decision on a detected conflict and resumes ' +
      'the paused swarm run. The chosen directive is written into the knowledge base at the ' +
      'highest weight, so it outranks anything the parsers inferred and lands verbatim in ' +
      'CLAUDE.md. Called by the conflict-resolver widget buttons, or directly.',
    inputSchema: ConflictResolutionSchema,
    examples: {
      request: { conflict_id: 'conflict-AUR-4471-decision-3', chosen: 'b', resolved_by: 'admin' },
      response: { resolved: true, remainingOpen: 0 },
    },
  })
  @Widget('conflict-resolver')
  async resolveConflict(
    input: { conflict_id: string; chosen: 'a' | 'b' | 'custom'; directive?: string; resolved_by?: string },
    ctx: ExecutionContext
  ) {
    const updated = this.conflicts.resolve(
      input.conflict_id,
      input.chosen,
      input.directive,
      input.resolved_by ?? 'admin'
    );

    const all = this.store.all('conflicts');
    const open = all.filter((c) => c.status === 'open');

    // Resuming the paused run is the whole point of the human-in-the-loop step.
    let resumedRun: string | undefined;
    const run = this.store.latestRun();
    if (run && run.status === 'awaiting-resolution' && !open.length) {
      this.store.upsert('runs', { ...run, status: 'completed', finishedAt: new Date().toISOString() });
      resumedRun = run.id;
    }

    ctx.logger.info('Conflict resolved', {
      conflict: input.conflict_id,
      chosen: input.chosen,
      remainingOpen: open.length,
      resumedRun,
    });

    return {
      resolved: true,
      conflict: updated,
      conflictCount: all.length,
      openCount: open.length,
      conflicts: all,
      resumedRun,
      nextStep: open.length
        ? `${open.length} conflict(s) still open.`
        : 'All conflicts resolved — run synthesize_claude_md to regenerate the manifest.',
    };
  }

  @Tool({
    name: 'list_conflicts',
    title: 'List conflicts',
    description:
      'Returns every detected conflict with its current status and any recorded resolution. ' +
      'Useful for auditing which context decisions a human validated versus which the machine inferred.',
    inputSchema: z.object({
      only_open: z.boolean().default(false).describe('Return only unresolved conflicts'),
    }),
    examples: { request: { only_open: true }, response: { conflictCount: 0, conflicts: [] } },
  })
  @Widget('conflict-resolver')
  async listConflicts(input: { only_open?: boolean }) {
    const all = this.store.all('conflicts');
    const conflicts = input.only_open ? all.filter((c) => c.status === 'open') : all;
    return {
      conflictCount: conflicts.length,
      openCount: all.filter((c) => c.status === 'open').length,
      conflicts,
    };
  }
}
