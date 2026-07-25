/**
 * Enterprise Agentic Bridge — MCP server entry point.
 *
 * Two things happen here beyond the standard NitroStack bootstrap:
 *
 *   1. The live server instance is stashed in the server registry. That is what
 *      lets `generate_custom_skill` register a brand-new MCP tool on the running
 *      server and have it appear in the client's tool list without a restart.
 *   2. Previously generated skills are rehydrated from the durable registry, so
 *      a restart does not lose the swarm's work.
 */
import 'dotenv/config';
import { McpApplicationFactory, DIContainer } from '@nitrostack/core';
import { AppModule } from './app.module.js';
import { setServer } from './shared/services/server-registry.js';
import { ensureWidgetsBuilt } from './shared/ensure-widgets.js';
import { SkillRuntimeService } from './modules/skills/skill-runtime.service.js';

async function bootstrap() {
  // Must run before create(): the factory resolves every @Widget route to a
  // static export while building the tool list, and throws if one is missing.
  ensureWidgetsBuilt();

  const server = await McpApplicationFactory.create(AppModule);

  // Must happen before start(): a client can call tools the moment we are up.
  setServer(server);

  await server.start();

  // Re-register skills the swarm minted in a previous session.
  try {
    const runtime = DIContainer.getInstance().resolve(SkillRuntimeService) as SkillRuntimeService;
    const { restored, failed } = runtime.rehydrate();
    if (restored.length) {
      console.error(`[bridge] Rehydrated ${restored.length} generated skill(s): ${restored.join(', ')}`);
    }
    for (const f of failed) {
      console.error(`[bridge] Could not rehydrate skill "${f.name}": ${f.error}`);
    }
  } catch (error) {
    // Never let skill rehydration take the server down — the core tools still work.
    console.error(
      '[bridge] Skill rehydration skipped:',
      error instanceof Error ? error.message : String(error)
    );
  }
}

bootstrap().catch((error) => {
  console.error('❌ Failed to start the Enterprise Agentic Bridge:', error);
  process.exit(1);
});
