export type IncidentSignatureRecord = {
  tenantId: string;
  hash: string;
  entityTypes: string[];
  eventTypes: string[];
  anomalyTypes: string[];
  serviceKey?: string;
  topologyPattern?: string;
  environment?: string;
};

export type ResolutionRecordView = {
  tenantId: string;
  incidentId: string;
  signatureId?: string;
  confirmedRootCause?: string;
  rejectedRootCauses?: unknown;
  resolution?: string;
  successfulAction?: string;
  timeToDetectMs?: number;
  timeToResolveMs?: number;
};

export type HistoricalMatch = {
  tenantId: string;
  signatureHash: string;
  incidentId?: string;
  similarity?: number;
  confirmedRootCause?: string;
  successfulAction?: string;
};
