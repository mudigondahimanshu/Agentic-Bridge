import { Injectable, ToolDecorator as Tool, ExecutionContext, z } from '@nitrostack/core';
import { AgileService } from './agile.service.js';
import { StoreService } from '../../shared/services/store.service.js';
import type { KnowledgeFact } from '../../shared/schemas/index.js';

const SourceSchema = z.object({
  source: z
    .string()
    .optional()
    .describe('Absolute path to an alternate fixture file. Omit to use the bundled mock data.'),
});

@Injectable({ deps: [AgileService, StoreService] })
export class AgileTools {
  constructor(
    private agile: AgileService,
    private store: StoreService
  ) {}

  @Tool({
    name: 'fetch_sprint_goals',
    title: 'Fetch sprint goals (Jira)',
    description:
      'Product Synchronizer. Returns the active sprint, its goal and every issue with status ' +
      'and assignee, so the AI knows what humans are already working on and does not generate ' +
      'code that collides with in-flight work. Backed by a local Jira fixture for the ' +
      'hackathon; the payload shape matches the Jira Agile REST response.',
    inputSchema: SourceSchema,
    examples: {
      request: {},
      response: {
        sprint: { name: 'Sprint 41 - Invoice Read Path', state: 'active' },
        issueCount: 4,
        inFlight: [{ key: 'AUR-4471', status: 'In Progress', assignee: 'p.narang' }],
      },
    },
  })
  async fetchSprintGoals(input: { source?: string }, ctx: ExecutionContext) {
    const sprint = this.agile.loadSprint(input.source);
    ctx.logger.info('Product Synchronizer fetched sprint', {
      sprint: sprint.sprint.name,
      issues: sprint.issues.length,
    });

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
        detail:
          `${issue.description} ` +
          `Owner: ${issue.assignee ?? 'unassigned'}.` +
          (issue.labels.length ? ` Labels: ${issue.labels.join(', ')}.` : ''),
        evidence: [issue.key],
        weight: issue.status.toLowerCase().includes('progress') ? 4 : 3,
      })),
    ];

    this.store.clearAgentFacts('product-synchronizer');
    this.store.addFacts(facts);

    return {
      board: sprint.board,
      sprint: sprint.sprint,
      issueCount: sprint.issues.length,
      inFlight: inFlight.map((i) => ({
        key: i.key,
        status: i.status,
        assignee: i.assignee,
        summary: i.summary,
        storyPoints: i.storyPoints,
      })),
      issues: sprint.issues,
    };
  }

  @Tool({
    name: 'fetch_meeting_transcripts',
    title: 'Fetch meeting transcripts (Teams)',
    description:
      'Scrum Analyst. Parses a Microsoft Teams standup transcript into structured decisions. ' +
      'Each utterance is segmented, its technology entities extracted, and its intent classified ' +
      'as adopt / reject / freeze / mandate. This surfaces the unwritten verbal decisions that ' +
      'contradict the ticket tracker — the tribal knowledge an LLM would otherwise never see.',
    inputSchema: SourceSchema,
    examples: {
      request: {},
      response: {
        title: 'Microsoft Teams — Aurora Billing / Sprint 41 Daily Scrum',
        decisionCount: 14,
        bindingDirectives: [
          { speaker: 'D. Fairbanks', polarity: 'reject', entities: ['redis'], text: 'we are NOT introducing Redis…' },
        ],
      },
    },
  })
  async fetchMeetingTranscripts(input: { source?: string }, ctx: ExecutionContext) {
    const transcript = this.agile.loadTranscript(input.source);
    const binding = this.agile.bindingDirectives(transcript);
    ctx.logger.info('Scrum Analyst parsed transcript', {
      decisions: transcript.decisions.length,
      binding: binding.length,
    });

    const facts: KnowledgeFact[] = [
      {
        id: 'consensus:meeting',
        agent: 'scrum-analyst',
        category: 'consensus',
        title: `Human consensus: ${transcript.title}`,
        detail:
          `${transcript.occurredAt ?? 'undated'}. ` +
          `${transcript.attendees.length} attendees. ` +
          `${binding.length} binding directive(s) extracted from ${transcript.decisions.length} utterances.`,
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

    this.store.clearAgentFacts('scrum-analyst');
    this.store.addFacts(facts);

    return {
      source: transcript.source,
      title: transcript.title,
      occurredAt: transcript.occurredAt,
      attendees: transcript.attendees,
      decisionCount: transcript.decisions.length,
      bindingDirectives: binding.map((d) => ({
        id: d.id,
        timestamp: d.timestamp,
        speaker: d.speaker,
        authority: d.authority,
        polarity: d.polarity,
        entities: d.entities,
        text: d.text,
      })),
      decisions: transcript.decisions,
    };
  }
}
