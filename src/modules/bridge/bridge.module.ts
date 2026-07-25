import { Module } from '@nitrostack/core';
import { BridgeResources } from './bridge.resources.js';
import { BridgePrompts } from './bridge.prompts.js';
import { SynthesisModule } from '../synthesis/synthesis.module.js';

@Module({
  name: 'bridge',
  description: 'Bridge state exposed as MCP resources, plus guided prompts',
  imports: [SynthesisModule],
  controllers: [BridgeResources, BridgePrompts],
})
export class BridgeModule {}
