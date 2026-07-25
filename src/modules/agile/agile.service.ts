/**
 * Product Synchronizer + Scrum Analyst.
 *
 * Live Jira/Teams OAuth is deliberately out of scope for the hackathon window,
 * so these read from local fixtures under `data/`. The important part is that
 * the *shape* is the real integration shape: swap `loadSprint` for a Jira REST
 * call and nothing downstream changes.
 *
 * The transcript parser is the interesting half. It does not just dump lines —
 * it segments the transcript into individual utterances, extracts the
 * technologies each one is about, and classifies whether the speaker is
 * adopting, rejecting, freezing or mandating. That structured output is what
 * the conflict engine consumes.
 */
import { Injectable } from '@nitrostack/core';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceService } from '../../shared/services/workspace.service.js';
import { SemanticService } from '../../shared/services/semantic.service.js';
import {
  JiraSprintSchema,
  type JiraSprint,
  type MeetingDecision,
  type MeetingTranscript,
} from '../../shared/schemas/index.js';

/** Speakers whose word is authoritative when a conflict is scored. */
const AUTHORITY_HINTS: { pattern: RegExp; authority: MeetingDecision['authority'] }[] = [
  { pattern: /\(eng lead\)|fairbanks/i, authority: 'lead' },
  { pattern: /\(ops\)|brandt/i, authority: 'ops' },
];

@Injectable({ deps: [WorkspaceService, SemanticService] })
export class AgileService {
  constructor(
    private workspace: WorkspaceService,
    private semantic: SemanticService
  ) {}

  private dataFile(name: string, override?: string): string {
    if (override) {
      const resolved = path.resolve(override);
      if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
      return resolved;
    }
    const file = path.join(this.workspace.dataRoot, name);
    if (!fs.existsSync(file)) {
      throw new Error(
        `Missing fixture ${file}. This tool reads mocked enterprise data from data/. ` +
          `Pass "source" to point at a different file.`
      );
    }
    return file;
  }

  loadSprint(source?: string): JiraSprint {
    const file = this.dataFile('mock-jira-sprint.json', source);
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Validate at the boundary: a malformed fixture fails loudly here rather
    // than producing a confusing error three layers downstream.
    return JiraSprintSchema.parse(raw);
  }

  loadTranscript(source?: string): MeetingTranscript {
    const file = this.dataFile('mock-teams-transcript.txt', source);
    const raw = fs.readFileSync(file, 'utf8');
    return this.parseTranscript(path.basename(file), raw);
  }

  parseTranscript(sourceName: string, raw: string): MeetingTranscript {
    const lines = raw.split('\n');
    const title = lines.find((l) => l.trim().length > 0)?.trim() ?? sourceName;
    const occurredAt = lines.find((l) => /^\w+day,/.test(l.trim()))?.trim();
    const attendeesLine = lines.find((l) => /^attendees:/i.test(l.trim()));
    const attendees = attendeesLine
      ? attendeesLine.replace(/^attendees:\s*/i, '').split(',').map((a) => a.trim()).filter(Boolean)
      : [];

    const decisions: MeetingDecision[] = [];
    let current: { timestamp?: string; speaker?: string; parts: string[] } | null = null;

    const flush = () => {
      if (!current || !current.parts.length) return;
      const text = current.parts.join(' ').replace(/\s+/g, ' ').trim();
      if (text.length >= 15) {
        const signal = this.semantic.analyseDecision(text);
        decisions.push({
          id: `decision-${decisions.length + 1}`,
          timestamp: current.timestamp,
          speaker: current.speaker,
          text,
          entities: signal.entities,
          polarity: signal.polarity,
          authority: this.authorityOf(current.speaker, attendees),
        });
      }
      current = null;
    };

    for (const line of lines) {
      // `[10:04] D. Fairbanks: text` starts a new utterance.
      const header = line.match(/^\s*\[(\d{1,2}:\d{2})\]\s*([^:]{2,40}):\s*(.*)$/);
      if (header) {
        flush();
        current = { timestamp: header[1], speaker: header[2].trim(), parts: header[3] ? [header[3]] : [] };
        continue;
      }
      // Continuation lines belong to the utterance above.
      if (current && line.trim() && /^\s{4,}/.test(line)) {
        current.parts.push(line.trim());
      } else if (current && !line.trim()) {
        flush();
      }
    }
    flush();

    return {
      source: sourceName,
      title,
      occurredAt,
      attendees,
      decisions,
      rawLineCount: lines.length,
    };
  }

  private authorityOf(speaker: string | undefined, attendees: string[]): MeetingDecision['authority'] {
    if (!speaker) return 'unknown';
    const context = `${speaker} ${attendees.find((a) => a.includes(speaker.split(' ').pop() ?? '')) ?? ''}`;
    for (const hint of AUTHORITY_HINTS) {
      if (hint.pattern.test(context)) return hint.authority;
    }
    return 'engineer';
  }

  /**
   * Decisions that carry a directive an agent must obey, ranked by how binding
   * they are. These become "Current Human Alignment" rules in CLAUDE.md.
   */
  bindingDirectives(transcript: MeetingTranscript): MeetingDecision[] {
    const weight: Record<MeetingDecision['polarity'], number> = {
      reject: 4, freeze: 4, mandate: 3, adopt: 2, neutral: 0,
    };
    const authorityBoost: Record<MeetingDecision['authority'], number> = {
      lead: 2, ops: 2, engineer: 1, unknown: 0,
    };
    return transcript.decisions
      .filter((d) => d.polarity !== 'neutral')
      .sort((a, b) => weight[b.polarity] + authorityBoost[b.authority] - (weight[a.polarity] + authorityBoost[a.authority]));
  }
}
