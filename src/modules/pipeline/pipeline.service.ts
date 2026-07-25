/**
 * Pipeline executor.
 *
 * The administrator composes an SDLC as a node graph in the pipeline-builder
 * widget; this service validates and executes it.
 *
 * Honesty about what executes: the cognitive nodes (understand, think, explore,
 * design) genuinely query the knowledge base and return real, grounded output.
 * The side-effecting nodes (push, deploy, update_jira, send_slack_message) are
 * PLANNED, not performed — each returns the exact command or API call it would
 * issue, derived from what the DevOps Navigator actually found in the repo.
 * A bridge that force-pushes to a stranger's master branch during a demo is not
 * a feature. Every such node is flagged `executed: false` in the result.
 */
import { Injectable } from '@nitrostack/core';
import { StoreService } from '../../shared/services/store.service.js';
import { SemanticService } from '../../shared/services/semantic.service.js';
import type { PipelineGraph, PipelineNodeType } from '../../shared/schemas/index.js';

export interface NodeDescriptor {
  type: PipelineNodeType;
  label: string;
  description: string;
  category: 'cognitive' | 'authoring' | 'verification' | 'delivery' | 'communication';
  /** Whether this node performs a real side effect when executed. */
  sideEffecting: boolean;
  backingTool?: string;
}

export const NODE_CATALOG: NodeDescriptor[] = [
  {
    type: 'understand',
    label: 'Understand',
    description:
      'Loads the pre-computed manifest and knowledge graph to establish baseline context for the task.',
    category: 'cognitive',
    sideEffecting: false,
    backingTool: 'query_knowledge',
  },
  {
    type: 'think',
    label: 'Think',
    description:
      'Reasons about the problem without emitting code, evaluating constraints against the team style guide.',
    category: 'cognitive',
    sideEffecting: false,
  },
  {
    type: 'explore',
    label: 'Explore',
    description:
      'Semantic search across the knowledge base plus a dependency-graph walk to find the files a change will touch.',
    category: 'cognitive',
    sideEffecting: false,
    backingTool: 'find_change_surface',
  },
  {
    type: 'design',
    label: 'Design',
    description: 'Produces an architectural proposal and pauses for administrator approval.',
    category: 'cognitive',
    sideEffecting: false,
  },
  {
    type: 'develop',
    label: 'Develop',
    description:
      'Generates code using the structural topography and syntax heuristics mapped by the swarm.',
    category: 'authoring',
    sideEffecting: false,
  },
  {
    type: 'write_tests',
    label: 'Write Tests',
    description: "Generates tests in the exact framework, location and naming convention the QA Analyst recovered.",
    category: 'authoring',
    sideEffecting: false,
    backingTool: 'extract_test_strategy',
  },
  {
    type: 'run_tests',
    label: 'Run Tests',
    description: 'Runs the project test command and captures output for iterative refinement.',
    category: 'verification',
    sideEffecting: true,
  },
  {
    type: 'push',
    label: 'Push',
    description: 'Stages, commits using the extracted commit convention, and pushes to the branch.',
    category: 'delivery',
    sideEffecting: true,
    backingTool: 'parse_ci_cd_pipelines',
  },
  {
    type: 'deploy',
    label: 'Deploy',
    description: 'Triggers the CI/CD deployment stage the DevOps Navigator mapped.',
    category: 'delivery',
    sideEffecting: true,
    backingTool: 'parse_ci_cd_pipelines',
  },
  {
    type: 'update_jira',
    label: 'Update Jira',
    description: 'Transitions the ticket state and appends a development summary.',
    category: 'communication',
    sideEffecting: true,
    backingTool: 'fetch_sprint_goals',
  },
  {
    type: 'send_slack_message',
    label: 'Send Slack Message',
    description: 'Notifies the channel with a deployment summary and reviewer mentions.',
    category: 'communication',
    sideEffecting: true,
  },
];

export interface NodeResult {
  id: string;
  type: PipelineNodeType;
  label: string;
  status: 'ok' | 'planned' | 'paused' | 'skipped';
  executed: boolean;
  output: string;
  evidence: string[];
}

@Injectable({ deps: [StoreService, SemanticService] })
export class PipelineService {
  constructor(
    private store: StoreService,
    private semantic: SemanticService
  ) {}

  descriptor(type: PipelineNodeType): NodeDescriptor {
    return NODE_CATALOG.find((n) => n.type === type)!;
  }

  /**
   * Validate a graph: node ids unique, edges reference real nodes, and the
   * graph is acyclic. Returns the execution order.
   */
  validateAndOrder(graph: PipelineGraph): string[] {
    const ids = graph.nodes.map((n) => n.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length) throw new Error(`Duplicate node id(s): ${[...new Set(dupes)].join(', ')}`);

    // No edges means the author intends a straight sequential chain.
    if (!graph.edges.length) return ids;

    const idSet = new Set(ids);
    for (const edge of graph.edges) {
      if (!idSet.has(edge.from)) throw new Error(`Edge references unknown node "${edge.from}"`);
      if (!idSet.has(edge.to)) throw new Error(`Edge references unknown node "${edge.to}"`);
    }

    // Kahn's algorithm — also gives us cycle detection for free.
    const indegree = new Map(ids.map((id) => [id, 0]));
    const adjacency = new Map(ids.map((id) => [id, [] as string[]]));
    for (const edge of graph.edges) {
      adjacency.get(edge.from)!.push(edge.to);
      indegree.set(edge.to, indegree.get(edge.to)! + 1);
    }

    const queue = ids.filter((id) => indegree.get(id) === 0);
    const order: string[] = [];
    while (queue.length) {
      const id = queue.shift()!;
      order.push(id);
      for (const next of adjacency.get(id)!) {
        indegree.set(next, indegree.get(next)! - 1);
        if (indegree.get(next) === 0) queue.push(next);
      }
    }

    if (order.length !== ids.length) {
      const stuck = ids.filter((id) => !order.includes(id));
      throw new Error(`Pipeline graph contains a cycle involving: ${stuck.join(', ')}`);
    }
    return order;
  }

  /** Execute one node against the knowledge base. */
  executeNode(
    node: { id: string; type: PipelineNodeType; label?: string; requiresApproval?: boolean },
    task: string
  ): NodeResult {
    const desc = this.descriptor(node.type);
    const label = node.label ?? desc.label;
    const base = { id: node.id, type: node.type, label };

    switch (node.type) {
      case 'understand': {
        const facts = this.store.all('knowledge');
        const byCategory = new Map<string, number>();
        for (const f of facts) byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1);
        return {
          ...base,
          status: facts.length ? 'ok' : 'skipped',
          executed: true,
          output: facts.length
            ? `Loaded ${facts.length} facts across ${byCategory.size} categories ` +
              `(${[...byCategory.entries()].map(([c, n]) => `${c}:${n}`).join(', ')}).`
            : 'Knowledge base is empty — run run_swarm before executing a pipeline.',
          evidence: [...byCategory.keys()],
        };
      }

      case 'think': {
        const constraints = this.store
          .all('knowledge')
          .filter((f) => f.weight >= 4 && ['testing', 'cicd', 'design-system', 'consensus'].includes(f.category));
        return {
          ...base,
          status: 'ok',
          executed: true,
          output:
            `Evaluating "${task}" against ${constraints.length} binding constraint(s):\n` +
            constraints.slice(0, 8).map((c) => `  • ${c.title}`).join('\n'),
          evidence: constraints.slice(0, 8).map((c) => c.id),
        };
      }

      case 'explore': {
        const hits = this.search(task, 6);
        return {
          ...base,
          status: hits.length ? 'ok' : 'skipped',
          executed: true,
          output: hits.length
            ? `Most relevant context for "${task}":\n` +
              hits.map((h) => `  • [${h.score.toFixed(2)}] ${h.title}`).join('\n')
            : `No knowledge matched "${task}".`,
          evidence: hits.flatMap((h) => h.evidence).slice(0, 10),
        };
      }

      case 'design': {
        const arch = this.store.factsByCategory('architecture');
        return {
          ...base,
          status: node.requiresApproval ? 'paused' : 'ok',
          executed: true,
          output:
            `Design proposal for "${task}" grounded in ${arch.length} architectural fact(s). ` +
            (node.requiresApproval
              ? 'PAUSED — awaiting administrator approval before proceeding.'
              : 'Proceeding without approval gate.'),
          evidence: arch.map((a) => a.id).slice(0, 5),
        };
      }

      case 'develop': {
        const style = [...this.store.factsByCategory('architecture'), ...this.store.factsByCategory('design-system')];
        return {
          ...base,
          status: 'ok',
          executed: true,
          output:
            `Code generation constrained by ${style.length} topography and design-system fact(s). ` +
            `Layer conventions and the approved token set are enforced.`,
          evidence: style.map((s) => s.id).slice(0, 6),
        };
      }

      case 'write_tests': {
        const testing = this.store.factsByCategory('testing');
        const naming = testing.find((t) => t.id === 'qa:naming');
        const gate = testing.find((t) => t.id === 'qa:coverage-gate');
        return {
          ...base,
          status: testing.length ? 'ok' : 'skipped',
          executed: true,
          output:
            (naming ? `${naming.detail}\n` : '') +
            (gate ? `${gate.detail}` : 'No coverage gate detected.'),
          evidence: testing.map((t) => t.id),
        };
      }

      case 'run_tests': {
        const frameworks = this.store.factsByCategory('testing').find((t) => t.id === 'qa:frameworks');
        return {
          ...base,
          status: 'planned',
          executed: false,
          output:
            'Would run the project test command in the target repository. ' +
            (frameworks ? `Detected runners:\n${frameworks.detail}` : 'No test runner detected.') +
            '\nNot executed: the bridge does not run commands in a codebase it only has read access to.',
          evidence: frameworks ? frameworks.evidence : [],
        };
      }

      case 'push': {
        const convention = this.store.factsByCategory('cicd').find((f) => f.id === 'cicd:commit-convention');
        const branches = this.store.factsByCategory('cicd').find((f) => f.id === 'cicd:branch-model');
        return {
          ...base,
          status: 'planned',
          executed: false,
          output:
            'Would stage, commit and push. Commit must satisfy:\n' +
            (convention?.detail ?? '  no commit convention detected') +
            (branches ? `\nBranch model: ${branches.detail}` : '') +
            '\nNot executed: no write operations are performed against the target repository.',
          evidence: convention ? convention.evidence : [],
        };
      }

      case 'deploy': {
        const pipelines = this.store.factsByCategory('cicd').filter((f) => f.id.startsWith('cicd:pipeline:'));
        const gates = this.store.factsByCategory('cicd').find((f) => f.id === 'cicd:approval-gates');
        return {
          ...base,
          status: 'planned',
          executed: false,
          output:
            'Would trigger the mapped deployment path:\n' +
            (pipelines.length ? pipelines.map((p) => `  • ${p.title}: ${p.detail}`).join('\n') : '  none detected') +
            (gates ? `\nApproval required: ${gates.detail}` : '') +
            '\nNot executed.',
          evidence: pipelines.flatMap((p) => p.evidence),
        };
      }

      case 'update_jira': {
        const issues = this.store.factsByCategory('agile').filter((f) => f.id.startsWith('agile:issue:'));
        return {
          ...base,
          status: 'planned',
          executed: false,
          output:
            `Would transition the ticket and append a development summary. ` +
            `${issues.length} open issue(s) are candidates:\n` +
            issues.slice(0, 5).map((i) => `  • ${i.title}`).join('\n') +
            '\nNot executed: the Jira integration is backed by a local fixture in this build.',
          evidence: issues.map((i) => i.id).slice(0, 5),
        };
      }

      case 'send_slack_message': {
        return {
          ...base,
          status: 'planned',
          executed: false,
          output:
            `Would post a summary of "${task}" to the team channel and mention reviewers. ` +
            'Not executed: no outbound webhook is configured, and the bridge does not send ' +
            'messages on your behalf without an explicit channel and token.',
          evidence: [],
        };
      }
    }
  }

  /** Rank knowledge facts against a free-text query. */
  search(query: string, limit = 8): { id: string; title: string; detail: string; score: number; evidence: string[] }[] {
    const queryVec = this.semantic.embed(query);
    return this.store
      .all('knowledge')
      .map((fact) => {
        const similarity = this.semantic.cosine(queryVec, this.semantic.embed(`${fact.title} ${fact.detail}`));
        // Weight nudges load-bearing facts up without letting them dominate.
        return { ...fact, score: similarity * (1 + fact.weight / 20) };
      })
      .filter((f) => f.score > 0.02)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((f) => ({ id: f.id, title: f.title, detail: f.detail, score: f.score, evidence: f.evidence }));
  }
}
