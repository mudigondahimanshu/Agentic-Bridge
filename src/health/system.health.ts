/**
 * Health checks.
 *
 * `@HealthCheck` is a CLASS decorator taking an options object, and the class
 * implements `HealthCheckInterface.check()` — one class per check.
 */
import {
  HealthCheck,
  Injectable,
  type HealthCheckInterface,
  type HealthCheckResult,
} from '@nitrostack/core';
import * as fs from 'fs';
import { WorkspaceService } from '../shared/services/workspace.service.js';
import { StoreService } from '../shared/services/store.service.js';

@HealthCheck({
  name: 'system',
  description: 'Process uptime and memory headroom',
  interval: 30,
})
@Injectable()
export class SystemHealthCheck implements HealthCheckInterface {
  async check(): Promise<HealthCheckResult> {
    const memory = process.memoryUsage();
    const heapPercent = (memory.heapUsed / memory.heapTotal) * 100;
    return {
      status: heapPercent < 90 ? 'up' : 'degraded',
      message: heapPercent < 90 ? 'Bridge is operational' : 'High heap usage',
      details: {
        uptime: `${Math.floor(process.uptime())}s`,
        heapUsed: `${Math.round(memory.heapUsed / 1024 / 1024)}MB`,
        heapPercent: `${heapPercent.toFixed(1)}%`,
        node: process.version,
      },
    };
  }
}

@HealthCheck({
  name: 'fixture',
  description: 'Bundled legacy fixture and mock enterprise data are readable',
  interval: 60,
})
@Injectable({ deps: [WorkspaceService] })
export class FixtureHealthCheck implements HealthCheckInterface {
  constructor(private workspace: WorkspaceService) {}

  async check(): Promise<HealthCheckResult> {
    const fixture = fs.existsSync(this.workspace.fixtureRoot);
    const data = fs.existsSync(this.workspace.dataRoot);
    return {
      status: fixture && data ? 'up' : 'degraded',
      message:
        fixture && data
          ? 'Bundled fixture and mock enterprise data are present'
          : 'Bundled assets missing — tools will require explicit paths',
      details: {
        fixtureRoot: this.workspace.fixtureRoot,
        fixturePresent: String(fixture),
        dataRoot: this.workspace.dataRoot,
        dataPresent: String(data),
        allowedRoots: this.workspace.allowedRoots.join(', '),
      },
    };
  }
}

@HealthCheck({
  name: 'knowledge-base',
  description: 'Durable knowledge base and swarm run state',
  interval: 30,
})
@Injectable({ deps: [StoreService] })
export class KnowledgeHealthCheck implements HealthCheckInterface {
  constructor(private store: StoreService) {}

  async check(): Promise<HealthCheckResult> {
    const facts = this.store.all('knowledge');
    const run = this.store.latestRun();
    const openConflicts = this.store.all('conflicts').filter((c) => c.status === 'open').length;
    return {
      // An empty knowledge base is a valid cold start, not a failure.
      status: 'up',
      message: facts.length
        ? `${facts.length} facts across ${new Set(facts.map((f) => f.category)).size} categories`
        : 'Cold start — run run_swarm to populate',
      details: {
        facts: String(facts.length),
        skills: String(this.store.all('skills').length),
        openConflicts: String(openConflicts),
        latestRun: run?.id ?? 'none',
        latestRunStatus: run?.status ?? 'none',
      },
    };
  }
}
