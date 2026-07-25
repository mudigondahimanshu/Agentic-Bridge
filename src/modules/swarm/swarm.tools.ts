/**
 * The swarm orchestrator.
 *
 * Runs all seven reconnaissance personas over a target, cross-references their
 * output for conflicts, and pauses for a human when the sources disagree.
 *
 * Durability is handled by StoreService rather than an external workflow engine:
 * every agent's result is committed to disk the moment it completes, so a crash
 * mid-run loses at most the agent that was in flight, and a run that pauses for
 * a human decision is still there after a restart. Progress and the pause are
 * expressed through MCP Tasks (`ctx.task`), which is the protocol-native way to
 * do exactly this — see `taskSupport: 'optional'` below.
 */
import { Injectable, ToolDecorator as Tool, Widget, ExecutionContext, z } from '@nitrostack/core';
import { CodebaseService } from '../codebase/codebase.service.js';
import { DocumentationService } from '../documentation/documentation.service.js';
import { QaService } from '../qa/qa.service.js';
import { DevOpsService } from '../devops/devops.service.js';
import { UiUxService } from '../uiux/uiux.service.js';
import { AgileService } from '../agile/agile.service.js';
import { ConflictService } from '../conflict/conflict.service.js';
import { ManifestService } from '../synthesis/manifest.service.js';
import { WorkspaceService } from '../../shared/services/workspace.service.js';
import { StoreService } from '../../shared/services/store.service.js';
import { SWARM_AGENTS, RunRefSchema, TargetSchema } from '../../shared/schemas/index.js';
import type { KnowledgeFact, SwarmRun } from '../../shared/schemas/index.js';

interface AgentDefinition {
  agent: (typeof SWARM_AGENTS)[number];
  title: string;
  /** Returns the facts this persona contributes, plus a one-line summary. */
  run: (target: string) => { facts: KnowledgeFact[]; summary: string };
}

@Injectable({ deps: [CodebaseService, DocumentationService, QaService, DevOpsService, UiUxService, AgileService, ConflictService, ManifestService, WorkspaceService, StoreService] })
export class SwarmTools {
  constructor(
    private codebase: CodebaseService,
    private documentation: DocumentationService,
    private qa: QaService,
    private devops: DevOpsService,
    private uiux: UiUxService,
    private agile: AgileService,
    private conflicts: ConflictService,
    private manifest: ManifestService,
    private workspace: WorkspaceService,
    private store: StoreService
  ) {}

  @Tool({
    name: 'run_swarm',
    title: 'Run the reconnaissance swarm',
    description:
      'Runs all seven specialist agents over a legacy codebase in one pass: Structural ' +
      'Cartographer, Documentation Synthesizer, QA Analyst, DevOps Navigator, Product ' +
      'Synchronizer, Scrum Analyst and UI/UX Integrator. Each commits its findings to the ' +
      'durable knowledge base as it completes, then the orchestrator cross-references Jira ' +
      'against the Teams transcript. If they contradict each other the run PAUSES in the ' +
      "`awaiting-resolution` state rather than guessing — resolve it and the run resumes. " +
      'Optionally synthesizes CLAUDE.md at the end. Reports progress via MCP tasks.',
    inputSchema: TargetSchema.extend({
      synthesize: z
        .boolean()
        .default(true)
        .describe('Write CLAUDE.md at the end, if no conflicts are blocking'),
      detect_conflicts: z.boolean().default(true).describe('Cross-reference Jira against the Teams transcript'),
    }),
    taskSupport: 'optional',
    // Kept deliberately complete. Studio renders `examples.response` in the widget
    // preview BEFORE the tool has ever been executed, so a sparse example is not a
    // documentation nicety — it is what a first-time viewer sees. Omitting `agents`
    // and `target` here rendered the console as "7/0 agents · target undefined".
    examples: {
      request: { synthesize: true },
      response: {
        runId: 'run-1',
        status: 'awaiting-resolution',
        target: 'fixtures/legacy-monolith',
        agentsCompleted: 7,
        agentsFailed: 0,
        factsGathered: 54,
        generatedSkills: 0,
        openConflicts: 1,
        manifestSkippedReason:
          '1 unresolved conflict(s). The run is paused rather than guessing which source is authoritative.',
        factsByCategory: {
          dependency: 13,
          consensus: 11,
          testing: 9,
          architecture: 8,
          'design-system': 5,
          cicd: 4,
          agile: 4,
        },
        agents: [
          { agent: 'structural-cartographer', status: 'done', factCount: 8, durationMs: 142, summary: '33 files, 11 layers, 5 hotspots' },
          { agent: 'documentation-synthesizer', status: 'done', factCount: 13, durationMs: 38, summary: '21 deps across 3 manifest(s), 8 aging signal(s)' },
          { agent: 'qa-analyst', status: 'done', factCount: 9, durationMs: 51, summary: '4 runner(s), 5 written policy(ies)' },
          { agent: 'devops-navigator', status: 'done', factCount: 4, durationMs: 44, summary: '2 pipeline(s), commit convention recovered' },
          { agent: 'product-synchronizer', status: 'done', factCount: 4, durationMs: 6, summary: 'sprint "Sprint 41 - Invoice Read Path", 3 open issue(s)' },
          { agent: 'scrum-analyst', status: 'done', factCount: 11, durationMs: 9, summary: '14 binding directive(s) extracted' },
          { agent: 'uiux-integrator', status: 'done', factCount: 5, durationMs: 63, summary: '23 token(s), 3 component(s), 0 ad-hoc colour(s)' },
        ],
        nextStep: 'Resolve the conflict(s), then the manifest will generate.',
      },
    },
  })
  @Widget('swarm-console')
  async runSwarm(
    input: { target?: string; synthesize?: boolean; detect_conflicts?: boolean },
    ctx: ExecutionContext
  ) {
    const target = this.workspace.resolveTarget(input.target);
    const definitions = this.definitions();

    const run: SwarmRun = {
      id: `run-${this.store.all('runs').length + 1}-${Date.now().toString(36)}`,
      target: this.workspace.rel(this.workspace.projectRoot, target) || target,
      startedAt: new Date().toISOString(),
      status: 'running',
      agents: definitions.map((d) => ({
        agent: d.agent,
        status: 'pending' as const,
        factCount: 0,
        durationMs: 0,
        summary: '',
      })),
      conflictIds: [],
    };
    this.store.upsert('runs', run);

    ctx.logger.info('Swarm dispatched', { runId: run.id, target, agents: definitions.length });

    for (const [index, definition] of definitions.entries()) {
      ctx.task?.throwIfCancelled();
      ctx.task?.updateProgress(`[${index + 1}/${definitions.length}] ${definition.title}`);

      const slot = run.agents[index];
      slot.status = 'running';
      this.store.upsert('runs', run);

      const started = Date.now();
      try {
        // Each persona owns its facts: clearing first makes a re-run idempotent.
        this.store.clearAgentFacts(definition.agent);
        const { facts, summary } = definition.run(target);
        this.store.addFacts(facts);

        slot.status = 'done';
        slot.factCount = facts.length;
        slot.summary = summary;
      } catch (error) {
        // One agent failing must not abort the swarm — partial context still
        // beats no context, and the failure is reported rather than swallowed.
        slot.status = 'failed';
        slot.error = error instanceof Error ? error.message : String(error);
        ctx.logger.error(`Agent failed: ${definition.agent}`, { error: slot.error });
      }
      slot.durationMs = Date.now() - started;

      // Commit after every agent — this is what makes the run crash-survivable.
      this.store.upsert('runs', run);
    }

    /* ------------------------- conflict cross-reference ------------------------- */
    let openConflicts = 0;
    if (input.detect_conflicts !== false) {
      ctx.task?.updateProgress('Cross-referencing Jira against the Teams transcript');
      try {
        const detected = this.conflicts.detect(this.agile.loadSprint(), this.agile.loadTranscript());
        run.conflictIds = detected.map((c) => c.id);
        openConflicts = detected.filter((c) => c.status === 'open').length;
      } catch (error) {
        ctx.logger.warn('Conflict detection skipped', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    /* ------------------------------- synthesis ------------------------------- */
    let manifestPath: string | undefined;
    let manifestSkippedReason: string | undefined;

    if (openConflicts > 0) {
      run.status = 'awaiting-resolution';
      manifestSkippedReason =
        `${openConflicts} unresolved conflict(s). The run is paused rather than guessing which ` +
        `source is authoritative. Resolve them in the conflict-resolver widget and the run resumes.`;
      ctx.task?.requestInput(
        `Swarm paused: ${openConflicts} context conflict(s) need an administrator decision.`
      );
    } else if (input.synthesize !== false) {
      ctx.task?.updateProgress('Synthesizing CLAUDE.md');
      try {
        const written = this.manifest.write(target);
        manifestPath = this.workspace.rel(this.workspace.projectRoot, written.path);
        run.manifestPath = manifestPath;
        run.status = 'completed';
      } catch (error) {
        run.status = 'failed';
        run.error = error instanceof Error ? error.message : String(error);
      }
    } else {
      run.status = 'completed';
    }

    run.finishedAt = new Date().toISOString();
    this.store.upsert('runs', run);

    const facts = this.store.all('knowledge');
    ctx.logger.info('Swarm complete', {
      runId: run.id,
      status: run.status,
      facts: facts.length,
      openConflicts,
    });

    return {
      runId: run.id,
      status: run.status,
      target: run.target,
      agentsCompleted: run.agents.filter((a) => a.status === 'done').length,
      agentsFailed: run.agents.filter((a) => a.status === 'failed').length,
      agents: run.agents,
      factsGathered: facts.length,
      factsByCategory: this.countBy(facts),
      openConflicts,
      conflicts: this.store.all('conflicts'),
      generatedSkills: this.store.all('skills').length,
      manifestPath,
      manifestSkippedReason,
      nextStep:
        openConflicts > 0
          ? 'Resolve the conflict(s), then the manifest will generate.'
          : manifestPath
            ? `Manifest written to ${manifestPath}. Open it, or call query_knowledge to interrogate the graph.`
            : 'Call synthesize_claude_md to write the manifest.',
    };
  }

  @Tool({
    name: 'get_swarm_run',
    title: 'Get swarm run status',
    description:
      'Returns the state of a swarm run — per-agent status, timings, fact counts and any ' +
      'conflicts blocking it. Because run state is persisted to disk on every agent ' +
      'completion, this is accurate even after a server restart mid-run.',
    inputSchema: RunRefSchema,
    examples: {
      request: {},
      response: { runId: 'run-1', status: 'completed', agentsCompleted: 7 },
    },
  })
  @Widget('swarm-console')
  async getSwarmRun(input: { run_id?: string }) {
    const run = this.store.requireRun(input.run_id);
    const facts = this.store.all('knowledge');
    const conflicts = this.store.all('conflicts');

    return {
      runId: run.id,
      status: run.status,
      target: run.target,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      agents: run.agents,
      agentsCompleted: run.agents.filter((a) => a.status === 'done').length,
      agentsFailed: run.agents.filter((a) => a.status === 'failed').length,
      factsGathered: facts.length,
      factsByCategory: this.countBy(facts),
      openConflicts: conflicts.filter((c) => c.status === 'open').length,
      conflicts,
      generatedSkills: this.store.all('skills').length,
      manifestPath: run.manifestPath,
      allRuns: this.store.all('runs').map((r) => ({ id: r.id, status: r.status, startedAt: r.startedAt })),
    };
  }

  /* --------------------------- persona definitions --------------------------- */

  private definitions(): AgentDefinition[] {
    return [
      {
        agent: 'structural-cartographer',
        title: 'Structural Cartographer — mapping the dependency graph',
        run: (target) => {
          const map = this.codebase.buildMap(target);
          const facts: KnowledgeFact[] = [
            {
              id: 'arch:topography',
              agent: 'structural-cartographer',
              category: 'architecture',
              title: 'Architectural topography',
              detail: Object.entries(map.layers)
                .sort((a, b) => b[1] - a[1])
                .map(([l, n]) => `${l}: ${n} file(s)`)
                .join(', '),
              evidence: Object.keys(map.layers),
              weight: 5,
            },
            {
              id: 'arch:tree',
              agent: 'structural-cartographer',
              category: 'architecture',
              title: 'Directory tree',
              detail: map.tree,
              evidence: [],
              weight: 4,
            },
            ...map.hotspots.slice(0, 5).map<KnowledgeFact>((h) => ({
              id: `arch:hotspot:${h.path}`,
              agent: 'structural-cartographer',
              category: 'architecture',
              title: `High-blast-radius file: ${h.path}`,
              detail: `${h.path} (${h.layer}) is imported by ${h.inbound} other file(s). Changing it requires reviewing every dependent.`,
              evidence: [h.path],
              weight: 4,
            })),
          ];
          if (map.cycles.length) {
            facts.push({
              id: 'arch:cycles',
              agent: 'structural-cartographer',
              category: 'architecture',
              title: 'Import cycles',
              detail: map.cycles.map((c) => c.join(' → ')).join('\n'),
              evidence: map.cycles.flat(),
              weight: 3,
            });
          }
          return {
            facts,
            summary: `${map.fileCount} files, ${Object.keys(map.layers).length} layers, ${map.hotspots.length} hotspots`,
          };
        },
      },
      {
        agent: 'documentation-synthesizer',
        title: 'Documentation Synthesizer — dependency inventory',
        run: (target) => {
          const report = this.documentation.analyse(target);
          const facts: KnowledgeFact[] = [
            {
              id: 'dep:inventory',
              agent: 'documentation-synthesizer',
              category: 'dependency',
              title: 'Dependency inventory',
              detail: Object.entries(report.byEcosystem).map(([e, n]) => `${e}: ${n} package(s)`).join(', '),
              evidence: report.manifests,
              weight: 3,
            },
            ...report.agingSignals.map<KnowledgeFact>((s) => ({
              id: `dep:aging:${s.name}`,
              agent: 'documentation-synthesizer',
              category: 'dependency',
              title: `Pinned old: ${s.name}@${s.version}`,
              detail: s.note,
              evidence: report.manifests,
              weight: 4,
            })),
            ...report.internalDocs.slice(0, 8).map<KnowledgeFact>((d) => ({
              id: `dep:doc:${d.path}`,
              agent: 'documentation-synthesizer',
              category: 'dependency',
              title: `Internal doc: ${d.title}`,
              detail: d.excerpt,
              evidence: [d.path],
              weight: 2,
            })),
          ];
          return {
            facts,
            summary: `${report.dependencies.length} deps across ${report.manifests.length} manifest(s), ${report.agingSignals.length} aging signal(s)`,
          };
        },
      },
      {
        agent: 'qa-analyst',
        title: 'Quality Assurance Analyst — testing contract',
        run: (target) => {
          const report = this.qa.analyse(target);
          const facts: KnowledgeFact[] = [];
          if (report.frameworks.length) {
            facts.push({
              id: 'qa:frameworks',
              agent: 'qa-analyst',
              category: 'testing',
              title: 'Test frameworks in force',
              detail: report.frameworks.map((f) => `${f.name} (${f.ecosystem}) — ${f.detail}`).join('\n'),
              evidence: report.frameworks.map((f) => f.configFile),
              weight: 5,
            });
          }
          if (Object.keys(report.coverageThresholds).length) {
            facts.push({
              id: 'qa:coverage-gate',
              agent: 'qa-analyst',
              category: 'testing',
              title: 'Coverage gate',
              detail:
                'The build FAILS below these thresholds: ' +
                Object.entries(report.coverageThresholds).map(([k, v]) => `${k} ${v}%`).join(', '),
              evidence: report.frameworks.map((f) => f.configFile),
              weight: 5,
            });
          }
          facts.push({
            id: 'qa:naming',
            agent: 'qa-analyst',
            category: 'testing',
            title: 'Spec naming and location',
            detail:
              `Convention: ${report.namingConvention}. ` +
              (report.specLocations.length
                ? `Specs live in: ${report.specLocations.map((s) => `${s.directory} (${s.count})`).join(', ')}.`
                : 'No spec files found on disk.'),
            evidence: report.specLocations.map((s) => s.examplePath),
            weight: 4,
          });
          for (const lint of report.lintRules) {
            facts.push({
              id: `qa:lint:${lint.file}`,
              agent: 'qa-analyst',
              category: 'testing',
              title: `Lint rules (${lint.file})`,
              detail:
                (lint.extends.length ? `extends ${lint.extends.join(', ')}. ` : '') +
                lint.rules.map((r) => `${r.rule}=${r.setting}`).join(', '),
              evidence: [lint.file],
              weight: 4,
            });
          }
          if (report.formatter) {
            facts.push({
              id: 'qa:formatter',
              agent: 'qa-analyst',
              category: 'testing',
              title: 'Formatter settings',
              detail: Object.entries(report.formatter.settings).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', '),
              evidence: [report.formatter.file],
              weight: 3,
            });
          }
          report.writtenPolicies.forEach((policy, i) => {
            facts.push({
              id: `qa:policy:${i}`,
              agent: 'qa-analyst',
              category: 'testing',
              title: 'Written engineering policy',
              detail: policy,
              evidence: [],
              weight: 4,
            });
          });
          return {
            facts,
            summary: `${report.frameworks.length} runner(s), ${report.writtenPolicies.length} written policy(ies)`,
          };
        },
      },
      {
        agent: 'devops-navigator',
        title: 'DevOps Navigator — pipeline and commit contract',
        run: (target) => {
          const report = this.devops.analyse(target);
          const facts: KnowledgeFact[] = report.pipelines.map((p) => ({
            id: `cicd:pipeline:${p.file}`,
            agent: 'devops-navigator',
            category: 'cicd' as const,
            title: `${p.system} pipeline (${p.file})`,
            detail:
              `Stages in order: ${p.stages.map((s) => s.name).join(' → ')}.` +
              (p.agents.length ? ` Runs on: ${p.agents.join(', ')}.` : '') +
              (p.secrets.length ? ` Uses secrets: ${p.secrets.join(', ')}.` : ''),
            evidence: [p.file],
            weight: 5,
          }));

          if (report.commitConvention) {
            const c = report.commitConvention;
            facts.push({
              id: 'cicd:commit-convention',
              agent: 'devops-navigator',
              category: 'cicd',
              title: 'Commit message convention (CI-enforced)',
              detail:
                `Format: \`${c.pattern}\`. ` +
                (c.types.length ? `Types: ${c.types.join(', ')}. ` : '') +
                (c.scopes.length ? `Scopes: ${c.scopes.join(', ')}. ` : '') +
                (c.requiresTicketRef ? 'A ticket key is MANDATORY — CI rejects commits without one. ' : '') +
                (c.maxHeaderLength ? `Header max ${c.maxHeaderLength} chars. ` : '') +
                (c.example ? `Example: \`${c.example}\`` : ''),
              evidence: [c.source],
              weight: 5,
            });
          }
          if (report.manualApprovalGates.length) {
            facts.push({
              id: 'cicd:approval-gates',
              agent: 'devops-navigator',
              category: 'cicd',
              title: 'Manual approval gates',
              detail: report.manualApprovalGates
                .map((g) => `"${g.stage}" in ${g.pipeline} requires approval from ${g.who}`)
                .join('; '),
              evidence: report.manualApprovalGates.map((g) => g.pipeline),
              weight: 4,
            });
          }
          if (report.branchModel.length) {
            facts.push({
              id: 'cicd:branch-model',
              agent: 'devops-navigator',
              category: 'cicd',
              title: 'Branch model',
              detail: report.branchModel
                .map((b) => `${b.branch}: ${b.role}${b.deploysTo ? ` (${b.deploysTo})` : ''}`)
                .join('; '),
              evidence: report.pipelines.map((p) => p.file),
              weight: 4,
            });
          }
          return {
            facts,
            summary: `${report.pipelines.length} pipeline(s), commit convention ${report.commitConvention ? 'recovered' : 'not found'}`,
          };
        },
      },
      {
        agent: 'product-synchronizer',
        title: 'Product Synchronizer — Jira sprint state',
        run: () => {
          const sprint = this.agile.loadSprint();
          const inFlight = sprint.issues.filter((i) => !/done|closed/i.test(i.status));
          const facts: KnowledgeFact[] = [
            {
              id: 'agile:sprint',
              agent: 'product-synchronizer',
              category: 'agile',
              title: `Active sprint: ${sprint.sprint.name}`,
              detail:
                `Goal: ${sprint.sprint.goal ?? 'not stated'}. ` +
                `Runs ${sprint.sprint.startDate ?? '?'} → ${sprint.sprint.endDate ?? '?'}. ` +
                `${inFlight.length} of ${sprint.issues.length} issues still open.`,
              evidence: [`${sprint.board} board`],
              weight: 5,
            },
            ...inFlight.map<KnowledgeFact>((issue) => ({
              id: `agile:issue:${issue.key}`,
              agent: 'product-synchronizer',
              category: 'agile',
              title: `${issue.key} (${issue.status}) — ${issue.summary}`,
              detail: `${issue.description} Owner: ${issue.assignee ?? 'unassigned'}.`,
              evidence: [issue.key],
              weight: issue.status.toLowerCase().includes('progress') ? 4 : 3,
            })),
          ];
          return { facts, summary: `sprint "${sprint.sprint.name}", ${inFlight.length} open issue(s)` };
        },
      },
      {
        agent: 'scrum-analyst',
        title: 'Scrum Analyst — human consensus from Teams',
        run: () => {
          const transcript = this.agile.loadTranscript();
          const binding = this.agile.bindingDirectives(transcript);
          const facts: KnowledgeFact[] = [
            {
              id: 'consensus:meeting',
              agent: 'scrum-analyst',
              category: 'consensus',
              title: `Human consensus: ${transcript.title}`,
              detail:
                `${transcript.occurredAt ?? 'undated'}. ${transcript.attendees.length} attendees. ` +
                `${binding.length} binding directive(s) from ${transcript.decisions.length} utterances.`,
              evidence: [transcript.source],
              weight: 4,
            },
            ...binding.slice(0, 10).map<KnowledgeFact>((d) => ({
              id: `consensus:${d.id}`,
              agent: 'scrum-analyst',
              category: 'consensus',
              title: `${d.polarity.toUpperCase()}${d.entities.length ? `: ${d.entities.join(', ')}` : ''} — ${d.speaker ?? 'unknown'}`,
              detail: `"${d.text}" (${d.timestamp ?? '?'}, authority: ${d.authority})`,
              evidence: [transcript.source],
              weight: d.authority === 'lead' || d.authority === 'ops' ? 5 : 3,
            })),
          ];
          return { facts, summary: `${binding.length} binding directive(s) extracted` };
        },
      },
      {
        agent: 'uiux-integrator',
        title: 'UI/UX Integrator — corporate design language',
        run: (target) => {
          const report = this.uiux.analyse(target);
          const facts: KnowledgeFact[] = [];
          if (report.palette.length) {
            facts.push({
              id: 'ui:palette',
              agent: 'uiux-integrator',
              category: 'design-system',
              title: 'Approved colour palette',
              detail:
                'Use ONLY these colour tokens. Never introduce a raw hex value:\n' +
                report.palette.map((p) => `  ${p.name} = ${p.value}`).join('\n'),
              evidence: [...new Set(report.tokens.filter((t) => t.category === 'color').map((t) => t.source))],
              weight: 5,
            });
          }
          if (report.typography.length) {
            facts.push({
              id: 'ui:typography',
              agent: 'uiux-integrator',
              category: 'design-system',
              title: 'Typography',
              detail: report.typography.map((t) => `${t.name}: ${t.value}`).join('\n'),
              evidence: [...new Set(report.tokens.filter((t) => t.category === 'font').map((t) => t.source))],
              weight: 4,
            });
          }
          if (report.components.length) {
            facts.push({
              id: 'ui:components',
              agent: 'uiux-integrator',
              category: 'design-system',
              title: 'Reusable component inventory',
              detail:
                'Compose from these before writing new markup:\n' +
                report.components
                  .map((c) => `  <${c.name} ${c.props.map((p) => `${p}={…}`).join(' ')} />  — ${c.path}${c.doc ? ` — ${c.doc}` : ''}`)
                  .join('\n'),
              evidence: report.components.map((c) => c.path),
              weight: 5,
            });
          }
          const scale = report.tokens.filter((t) => ['spacing', 'radius', 'elevation', 'duration'].includes(t.category));
          if (scale.length) {
            facts.push({
              id: 'ui:scale',
              agent: 'uiux-integrator',
              category: 'design-system',
              title: 'Spacing, radius and motion scale',
              detail: scale.map((t) => `${t.name} = ${t.value}`).join('\n'),
              evidence: [...new Set(scale.map((t) => t.source))],
              weight: 3,
            });
          }
          report.conventions.forEach((convention, i) => {
            facts.push({
              id: `ui:convention:${i}`,
              agent: 'uiux-integrator',
              category: 'design-system',
              title: 'Design system rule',
              detail: convention,
              evidence: [],
              weight: 4,
            });
          });
          return {
            facts,
            summary: `${report.tokens.length} token(s), ${report.components.length} component(s), ${report.adHocColors.length} ad-hoc colour(s)`,
          };
        },
      },
    ];
  }

  private countBy(facts: KnowledgeFact[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const f of facts) out[f.category] = (out[f.category] ?? 0) + 1;
    return out;
  }
}
