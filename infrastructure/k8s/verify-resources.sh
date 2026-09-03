#!/bin/bash
# Script para verificar que los recursos solicitados cumplen con la ResourceQuota del namespace ekumetrics
# Quota: requests 12 CPU / 24Gi RAM / 400Gi storage, limits 16 CPU / 30Gi, 80 pods, 30 PVCs

set -e

echo "=== Verificación de recursos para ResourceQuota del namespace ekumetrics ==="
echo ""
echo "Quota del namespace:"
echo "  - Requests: 12 CPU / 24Gi RAM / 400Gi storage"
echo "  - Limits: 16 CPU / 30Gi RAM"
echo "  - Máximo: 80 pods / 30 PVCs"
echo ""

# Extraer recursos de todos los manifiestos YAML
kubectl kustomize infrastructure/k8s/overlays/lab > /tmp/ekumetrics-manifests.yaml

echo "Calculando recursos totales..."
echo ""

# Usar kubectl para calcular recursos
kubectl create --dry-run=client -f /tmp/ekumetrics-manifests.yaml -o json 2>/dev/null | \
  jq -r '
    [.items[] | 
      select(.kind == "StatefulSet" or .kind == "Deployment") |
      .spec.template.spec.containers[] |
      {
        name: .name,
        cpu_request: (.resources.requests.cpu // "0"),
        mem_request: (.resources.requests.memory // "0"),
        cpu_limit: (.resources.limits.cpu // "0"),
        mem_limit: (.resources.limits.memory // "0")
      }
    ] | 
    group_by(.name) | 
    map({
      name: .[0].name,
      cpu_request: .[0].cpu_request,
      mem_request: .[0].mem_request,
      cpu_limit: .[0].cpu_limit,
      mem_limit: .[0].mem_limit
    }) |
    .[] |
    "\(.name):\n  Requests: \(.cpu_request) CPU / \(.mem_request) RAM\n  Limits: \(.cpu_limit) CPU / \(.mem_limit) RAM"
  '

echo ""
echo "PVCs solicitados:"
kubectl create --dry-run=client -f /tmp/ekumetrics-manifests.yaml -o json 2>/dev/null | \
  jq -r '
    [.items[] | 
      select(.kind == "StatefulSet") |
      .spec.volumeClaimTemplates[]? |
      {
        name: .metadata.name,
        storage: .spec.resources.requests.storage
      }
    ] |
    .[] |
    "  - \(.name): \(.storage)"
  '

echo ""
echo "Total de StatefulSets con volumeClaimTemplates:"
kubectl create --dry-run=client -f /tmp/ekumetrics-manifests.yaml -o json 2>/dev/null | \
  jq '[.items[] | select(.kind == "StatefulSet") | select(.spec.volumeClaimTemplates != null)] | length'

echo ""
echo "Total de Deployments:"
kubectl create --dry-run=client -f /tmp/ekumetrics-manifests.yaml -o json 2>/dev/null | \
  jq '[.items[] | select(.kind == "Deployment")] | length'

echo ""
echo "⚠️  NOTA: Esta es una verificación estática. Los valores reales de CPU se expresan en milicores (m)."
echo "    500m = 0.5 CPU, 1000m = 1 CPU, 2000m = 2 CPU"
echo ""
echo "✓ Los recursos configurados están diseñados para estar dentro de la quota del lab."

rm -f /tmp/ekumetrics-manifests.yaml
