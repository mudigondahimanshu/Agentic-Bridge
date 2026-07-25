import { Module } from '@nitrostack/core';
import { SwarmTools } from './swarm.tools.js';
import { CodebaseModule } from '../codebase/codebase.module.js';
import { DocumentationModule } from '../documentation/documentation.module.js';
import { QaModule } from '../qa/qa.module.js';
import { DevOpsModule } from '../devops/devops.module.js';
import { UiUxModule } from '../uiux/uiux.module.js';
import { AgileModule } from '../agile/agile.module.js';
import { ConflictModule } from '../conflict/conflict.module.js';
import { SynthesisModule } from '../synthesis/synthesis.module.js';

@Module({
  name: 'swarm',
  description: 'Swarm orchestrator — dispatches all seven reconnaissance personas',
  imports: [
    CodebaseModule,
    DocumentationModule,
    QaModule,
    DevOpsModule,
    UiUxModule,
    AgileModule,
    ConflictModule,
    SynthesisModule,
  ],
  controllers: [SwarmTools],
})
export class SwarmModule {}
