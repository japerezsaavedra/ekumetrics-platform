import { Module } from '@nestjs/common';
import { AgentFindingRepository } from './persistence/agent-finding.repository';
import { InvestigationRepository } from './persistence/investigation.repository';
import { RcaModule } from './rca/rca.module';
import { RcaAgentStub } from './stubs/rca-agent.stub';

/**
 * Fundación de dominio AIOps.
 * RCA vive en RcaModule. El AgentOrchestrator real está en InvestigationModule.
 */
@Module({
  imports: [RcaModule],
  providers: [
    AgentFindingRepository,
    InvestigationRepository,
    RcaAgentStub,
  ],
  exports: [
    RcaModule,
    AgentFindingRepository,
    InvestigationRepository,
    RcaAgentStub,
  ],
})
export class AiopsDomainModule {}
