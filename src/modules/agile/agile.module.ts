import { Module } from '@nitrostack/core';
import { AgileTools } from './agile.tools.js';
import { AgileService } from './agile.service.js';

@Module({
  name: 'agile',
  description: 'Product Synchronizer & Scrum Analyst — Jira sprint state and Teams consensus',
  controllers: [AgileTools],
  providers: [AgileService],
  exports: [AgileService],
})
export class AgileModule {}
