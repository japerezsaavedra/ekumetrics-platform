# Wave 3 AIOps — multi-agent investigation

**Status:** implemented in `platform-api` + `portal-web`  
**Date:** 2026-09-05  
**Nomenclature:** **Ekumetrics Agent** = collector (`ekumetrics-agent/`). **AIOps Agent** = investigation agent inside the platform (`RcaAgent`, `MetricsAgent`, `LogsAgent`, `KubernetesAgent`, `TopologyAgent`, `SynthesisAgent`). HolmesGPT is an optional Kubernetes tool layer, not the orchestrator.

Wave 3 replaces `AgentOrchestratorStub` with `AgentOrchestratorService`. The Wave 2.5 deterministic path (ingest → anomaly → correlate → enrichment → RcaEngine) is unchanged. If the investigation subsystem is down, incidents and deterministic RCA still work.

---

## Runtime pipeline

```text
ekumetrics.incidents.enriched
  → InvestigationRequestedSubscriber
  → InvestigationPolicyService (default MANUAL → ack, no run)
  → AgentOrchestrator (only if mode=AUTOMATIC)

POST /v1/incidents/:id/investigate (product path)
  → InvestigationContext (bounded)
  → AgentSelectionService
  → persist AiopsInvestigation (unique tenantId+incidentId+version)
  → specialist AIOps Agents in parallel
  → SynthesisAgent (deterministic fallback; optional LLM)
  → IncidentEnrichment.applyInvestigationCompleted
  → GET /v1/incidents/:id/investigation
```

Independent specialists (Rca, Metrics, Logs, Topology, Kubernetes) run concurrently. Synthesis runs after. One failed specialist yields investigation `PARTIAL`, not `FAILED`.

---

## Policy defaults

| Field | Default |
|---|---|
| `mode` | `MANUAL` (automatic is opt-in per tenant) |
| `privacyMode` | `AI_DISABLED` |
| `holmesKubernetesEnabled` | `false` |
| `maxAgents` | 6 |
| `maxLLMCalls` | 0 when AI_DISABLED; policy may raise for LOCAL/CLOUD |
| `agentTimeoutMs` | 30_000 (Kubernetes/Holmes 20_000) |
| `maxDurationMs` | 120_000 |

`AiSettings` remains global (model/key). Privacy is per-tenant on `AiopsInvestigationPolicy`.

---

## RcaAgent

Projects `IncidentEnrichment` RCA snapshot when `rca.completed` already ran. Calls `RcaEngine.propose()` only if that snapshot is missing. Does not publish `rca.requested`.

---

## Confidence

```
base = 0.55 * deterministicRca + 0.25 * specialistMean + 0.20 * evidenceCoverage
LLM delta ∈ [-0.10, +0.05], cap base+0.05
```

LLM text without matching evidence must not raise confidence more than +0.05. `Incident.confidence` is not overwritten.

---

## APIs

- `POST /v1/incidents/:id/investigate`
- `GET /v1/incidents/:id/investigation`
- `GET /v1/incidents/:id/investigation/findings`
- `POST /v1/incidents/:id/investigation/retry`
- `POST /v1/incidents/:id/investigation/cancel`

Roles: `operator` | `admin`. Tenant via existing cookie / `X-Eku-Tenant`.

---

## NATS

Reused: `ekumetrics.aiops.investigation.requested`, `.completed`.  
Added: `.started`, `.failed`, `ekumetrics.aiops.agent.started`, `.completed`.

---

## UI

`/incidentes` and `/investigacion` share `incident-enrichment-panel`. The Wave 2.5 placeholder is replaced with status, AIOps Agent list, synthesis, evidence, recommendations, and Investigar / Reintentar.

---

## Persistence

Migration `20260905180000_wave3_investigation`: enums `PENDING` / `PARTIAL` / `TIMEOUT` (Wave 1 `QUEUED` / `SYNTHESIZING` / `BUDGET_EXCEEDED` remain), unique `(tenantId, incidentId, version)`, table `AiopsInvestigationPolicy` (defaults `MANUAL` + `AI_DISABLED`).

Runtime writes `PENDING`. HTTP DTO maps `QUEUED`→`PENDING` and `SYNTHESIZING`→`RUNNING` via `productStatus`.

---

## Out of scope

ITSM, autonomous remediation, `RemediationAgent`, `SecurityAgent` (interface only in `future-agents.ts`), auto-correlation change, CanonicalEvent, Ekumetrics Agent rewrite.
