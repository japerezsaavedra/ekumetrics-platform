import { isAiopsAgentType } from './aiops-agent-type';
import {
  assertFindingTransition,
  canTransitionFindingStatus,
  isTerminalFindingStatus,
} from './agent-finding';
import {
  mapIncidentStatusToLifecycle,
  mapLifecycleToIncidentStatus,
} from './incident-lifecycle';
import { selectAiopsAgents } from './select-aiops-agents';
import { createRcaEvidence } from './rca-evidence';
import {
  acceptRootCauseCandidate,
  acceptedCandidateCount,
  assertSingleAccepted,
  createRootCauseCandidate,
} from './root-cause-candidate';

describe('dominio RCA / AIOps (wave 1)', () => {
  const evidence = [
    createRcaEvidence({
      kind: 'topology',
      summary: 'commonCover apunta a sw-core',
      facts: { entityKey: 'sw-core', hops: 4 },
      entityKey: 'sw-core',
    }),
  ];

  it('exige evidencia y confidence en [0, 1] para RootCauseCandidate', () => {
    expect(() =>
      createRootCauseCandidate({
        tenantId: 't1',
        incidentId: 'inc-1',
        rank: 1,
        hypothesis: 'Saturación del switch core',
        confidence: 0.82,
        evidence,
        source: 'deterministic_rca',
        findingIds: [],
      }),
    ).not.toThrow();

    expect(() =>
      createRootCauseCandidate({
        tenantId: 't1',
        incidentId: 'inc-1',
        rank: 1,
        hypothesis: 'Sin evidencia',
        confidence: 0.5,
        evidence: [],
        source: 'deterministic_rca',
        findingIds: [],
      }),
    ).toThrow(/evidencia/);

    expect(() =>
      createRootCauseCandidate({
        tenantId: 't1',
        incidentId: 'inc-1',
        rank: 1,
        hypothesis: 'Confianza inválida',
        confidence: 1.4,
        evidence,
        source: 'deterministic_rca',
        findingIds: [],
      }),
    ).toThrow(/confidence/);
  });

  it('acepta como máximo una hipótesis por incidente y no implica Incident.status', () => {
    const first = createRootCauseCandidate({
      tenantId: 't1',
      incidentId: 'inc-1',
      rank: 1,
      hypothesis: 'Switch core',
      confidence: 0.8,
      evidence,
      source: 'deterministic_rca',
      findingIds: ['f1'],
    });
    const second = createRootCauseCandidate({
      tenantId: 't1',
      incidentId: 'inc-1',
      rank: 2,
      hypothesis: 'Enlace uplink',
      confidence: 0.4,
      evidence,
      source: 'deterministic_rca',
      findingIds: [],
    });

    const accepted = acceptRootCauseCandidate(
      [first, second],
      first.id,
      'operator@eku',
    );
    expect(acceptedCandidateCount(accepted)).toBe(1);
    expect(accepted.find((item) => item.id === first.id)?.status).toBe(
      'ACCEPTED',
    );
    expect(accepted.find((item) => item.id === second.id)?.status).toBe(
      'SUPERSEDED',
    );
    expect(() => assertSingleAccepted(accepted)).not.toThrow();
    expect(mapIncidentStatusToLifecycle('open')).toBe('DETECTED');
    expect(mapIncidentStatusToLifecycle('acknowledged')).toBe('INVESTIGATING');
  });

  it('mapea Incident.status a lifecycle sin alterar los valores legacy', () => {
    expect(mapIncidentStatusToLifecycle('resolved')).toBe('RESOLVED');
    expect(mapIncidentStatusToLifecycle('closed')).toBe('CLOSED');
    const legacy = ['open', 'acknowledged', 'resolved', 'closed'] as const;
    expect(legacy).toEqual(['open', 'acknowledged', 'resolved', 'closed']);
  });

  it('restringe transiciones de AgentFinding y tipos de AIOps Agent', () => {
    expect(canTransitionFindingStatus('PENDING', 'RUNNING')).toBe(true);
    expect(canTransitionFindingStatus('PENDING', 'SKIPPED')).toBe(true);
    expect(canTransitionFindingStatus('RUNNING', 'COMPLETED')).toBe(true);
    expect(canTransitionFindingStatus('COMPLETED', 'RUNNING')).toBe(false);
    expect(() => assertFindingTransition('FAILED', 'PENDING')).toThrow(
      /no permitida/,
    );
    expect(isTerminalFindingStatus('TIMEOUT')).toBe(true);
    expect(isAiopsAgentType('Rca')).toBe(true);
    expect(isAiopsAgentType('Metrics')).toBe(true);
    expect(isAiopsAgentType('collector')).toBe(false);
    expect(isAiopsAgentType('ekumetrics-agent')).toBe(false);
  });

  it('mapea lifecycle a Incident.status sin escribir el enum', () => {
    expect(mapLifecycleToIncidentStatus('DETECTED')).toBe('open');
    expect(mapLifecycleToIncidentStatus('CORRELATING')).toBe('open');
    expect(mapLifecycleToIncidentStatus('INVESTIGATING')).toBe('open');
    expect(mapLifecycleToIncidentStatus('ROOT_CAUSE_IDENTIFIED')).toBe(
      'acknowledged',
    );
    expect(mapLifecycleToIncidentStatus('MITIGATING')).toBe('acknowledged');
    expect(mapLifecycleToIncidentStatus('RESOLVED')).toBe('resolved');
    expect(mapLifecycleToIncidentStatus('CLOSED')).toBe('closed');
  });

  it('selecciona AIOps Agents por entityType y anomalías, siempre Rca', () => {
    expect(selectAiopsAgents({ tenantId: 't1', incidentId: 'inc-1' })).toEqual([
      'Rca',
    ]);
    expect(
      selectAiopsAgents({
        tenantId: 't1',
        incidentId: 'inc-1',
        entityType: 'K8S_POD',
        anomalies: ['cpu saturation', 'log errors'],
        needsBlastRadius: true,
      }),
    ).toEqual(['Rca', 'Kubernetes', 'Metrics', 'Logs', 'Topology']);
  });
});
