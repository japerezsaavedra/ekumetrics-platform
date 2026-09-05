import type {
  IncidentSignature,
  RcaFeedback,
  RcaFeedbackAction,
  ResolutionRecord,
} from './types';

export const HISTORICAL_REPOSITORY = Symbol('HISTORICAL_REPOSITORY');

export type UpsertSignatureInput = {
  tenantId: string;
  hash: string;
  entityTypes: string[];
  serviceKey: string;
  eventTypes: string[];
  anomalyTypes: string[];
  topologyPattern: string;
  environment: string;
  incidentId?: string;
};

export type UpsertResolutionInput = {
  tenantId: string;
  incidentId: string;
  signatureId?: string;
  confirmedRootCause?: string | null;
  rejectedRootCauses?: string[];
  appendRejected?: string[];
  resolution?: string;
  successfulAction?: string;
  timeToDetectMs?: number;
  timeToResolveMs?: number;
};

export type CreateFeedbackInput = {
  tenantId: string;
  incidentId: string;
  action: RcaFeedbackAction;
  selectedEntityId?: string;
  note?: string;
  userId?: string;
};

/**
 * Puerto de persistencia. Impl. in-memory hasta que existan modelos Prisma.
 * Toda consulta exige tenantId; nunca listar sin filtro de tenant.
 */
export interface HistoricalRepository {
  upsertSignature(input: UpsertSignatureInput): Promise<IncidentSignature>;
  findSignatureByHash(
    tenantId: string,
    hash: string,
  ): Promise<IncidentSignature | null>;
  findSignatureByIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<IncidentSignature | null>;
  listSignatures(tenantId: string): Promise<IncidentSignature[]>;
  upsertResolution(input: UpsertResolutionInput): Promise<ResolutionRecord>;
  findResolutionByIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<ResolutionRecord | null>;
  listResolutions(tenantId: string): Promise<ResolutionRecord[]>;
  createFeedback(input: CreateFeedbackInput): Promise<RcaFeedback>;
  listFeedback(tenantId: string, incidentId: string): Promise<RcaFeedback[]>;
}
