/**
 * Wave 3 hook for event-driven correlation.
 * Wave 2.5 keeps POST /v1/incidents/correlate as the product path.
 * Auto-correlation is not enabled: firing it on every ingested event
 * would change operator-visible incident creation.
 */
export const CORRELATION_PIPELINE_CONSUMER = Symbol(
  'CORRELATION_PIPELINE_CONSUMER',
);

export type CorrelationPipelineSignal = {
  tenantId: string;
  reason: 'events.ingested' | 'anomalies.detected' | 'manual';
  entityIds?: string[];
  incidentId?: string;
};

export interface CorrelationPipelineConsumer {
  onSignal(input: CorrelationPipelineSignal): Promise<void>;
}

/**
 * No-op consumer. Wave 3 can replace this with a subscriber that calls
 * CorrelationService without changing this port.
 */
export class DeferredCorrelationPipelineConsumer
  implements CorrelationPipelineConsumer
{
  onSignal(_input: CorrelationPipelineSignal): Promise<void> {
    return Promise.resolve();
  }
}
