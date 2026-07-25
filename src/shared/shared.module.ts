import { Module } from '@nitrostack/core';
import { WorkspaceService } from './services/workspace.service.js';
import { StoreService } from './services/store.service.js';
import { SemanticService } from './services/semantic.service.js';

/**
 * Foundation services every module depends on. Exported so feature modules
 * receive the same singletons — the durable store in particular must be one
 * instance or two modules would hold divergent caches of the same JSON files.
 */
@Module({
  name: 'shared',
  description: 'Workspace, durable store and semantic services',
  providers: [WorkspaceService, StoreService, SemanticService],
  exports: [WorkspaceService, StoreService, SemanticService],
})
export class SharedModule {}
