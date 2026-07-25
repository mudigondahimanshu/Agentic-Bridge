import { Module } from '@nitrostack/core';
import { WorkspaceService } from './services/workspace.service.js';
import { StoreService } from './services/store.service.js';
import { SemanticService } from './services/semantic.service.js';
import { AuthService } from './services/auth.service.js';
import { HttpHardeningService } from './services/http-hardening.service.js';
import { PdfTextService } from './services/pdf-text.service.js';
import { AdminGuard } from './security/admin.guard.js';

/**
 * Foundation services every module depends on. Exported so feature modules
 * receive the same singletons — the durable store in particular must be one
 * instance or two modules would hold divergent caches of the same JSON files,
 * and AuthService must be one instance so the HTTP edge and the per-tool guard
 * agree on which credentials exist.
 */
@Module({
  name: 'shared',
  description: 'Workspace, durable store, semantic search and transport security',
  providers: [
    WorkspaceService,
    StoreService,
    SemanticService,
    AuthService,
    AdminGuard,
    HttpHardeningService,
    PdfTextService,
  ],
  exports: [
    WorkspaceService,
    StoreService,
    SemanticService,
    AuthService,
    AdminGuard,
    PdfTextService,
  ],
})
export class SharedModule {}
