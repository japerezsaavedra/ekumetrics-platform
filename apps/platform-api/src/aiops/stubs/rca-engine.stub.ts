import { Injectable, Logger } from '@nestjs/common';
import type { RcaEngine, RcaProposeInput } from '../interfaces/rca-engine';
import type { RootCauseCandidate } from '../types/root-cause-candidate';

/**
 * Stub wave 1 conservado para tests. Wave 2 usa DeterministicRcaEngine.
 */
@Injectable()
export class RcaEngineStub implements RcaEngine {
  private readonly logger = new Logger(RcaEngineStub.name);

  propose(input: RcaProposeInput): Promise<RootCauseCandidate[]> {
    this.logger.log(
      `aiops RcaEngine.propose stub; wave 1 no ejecuta RCA tenantId=${input.tenantId} incidentId=${input.incidentId}`,
    );
    return Promise.resolve([]);
  }
}
