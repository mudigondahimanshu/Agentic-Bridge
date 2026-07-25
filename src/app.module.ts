import { McpApp, Module, ConfigModule } from '@nitrostack/core';

import { SharedModule } from './shared/shared.module.js';
import { CodebaseModule } from './modules/codebase/codebase.module.js';
import { DocumentationModule } from './modules/documentation/documentation.module.js';
import { QaModule } from './modules/qa/qa.module.js';
import { DevOpsModule } from './modules/devops/devops.module.js';
import { UiUxModule } from './modules/uiux/uiux.module.js';
import { AgileModule } from './modules/agile/agile.module.js';
import { ConflictModule } from './modules/conflict/conflict.module.js';
import { SkillsModule } from './modules/skills/skills.module.js';
import { PipelineModule } from './modules/pipeline/pipeline.module.js';
import { SynthesisModule } from './modules/synthesis/synthesis.module.js';
import { SwarmModule } from './modules/swarm/swarm.module.js';
import { BridgeModule } from './modules/bridge/bridge.module.js';
import {
  SystemHealthCheck,
  FixtureHealthCheck,
  KnowledgeHealthCheck,
} from './health/system.health.js';

/**
 * Enterprise Agentic Bridge — root module.
 *
 * The domain layout mirrors the swarm personas one-to-one, so a reviewer can map
 * "Structural Cartographer" straight onto `modules/codebase` and find its tool,
 * its service and its module in one directory.
 *
 * Transport: STDIO by default — that is what NitroStudio spawns. Switches to
 * HTTP when NODE_ENV=production or BRIDGE_TRANSPORT=http, which is what
 * NitroCloud runs and what the ChatGPT connector needs.
 */
const transportType =
  (process.env.BRIDGE_TRANSPORT as 'stdio' | 'http' | 'dual' | undefined) ??
  (process.env.NODE_ENV === 'production' ? 'http' : 'stdio');

@McpApp({
  module: AppModule,
  server: {
    name: 'enterprise-agentic-bridge',
    version: '1.0.0',
  },
  transport: {
    type: transportType,
    http: {
      port: Number(process.env.PORT ?? 8080),
      host: process.env.HOST ?? '0.0.0.0',
      basePath: '/mcp',
    },
  },
  logging: {
    level: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') ?? 'info',
  },
})
@Module({
  name: 'app',
  description: 'Enterprise Agentic Bridge — legacy codebase to machine-readable context',
  imports: [
    ConfigModule.forRoot(),
    SharedModule,

    // Reconnaissance personas
    CodebaseModule,
    DocumentationModule,
    QaModule,
    DevOpsModule,
    UiUxModule,
    AgileModule,

    // Synthesis and control
    ConflictModule,
    SkillsModule,
    PipelineModule,
    SynthesisModule,
    SwarmModule,
    BridgeModule,
  ],
  providers: [SystemHealthCheck, FixtureHealthCheck, KnowledgeHealthCheck],
})
export class AppModule {}
