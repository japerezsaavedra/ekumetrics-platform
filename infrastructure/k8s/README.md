# Despliegue de Ekumetrics SaaS en Kubernetes

Este directorio contiene los manifiestos de Kubernetes para desplegar ekumetrics-platform como SaaS público en **ekumetrics.com**.

⚠️ **IMPORTANTE**: Este es el despliegue de producción del SaaS. Los archivos de Docker Compose (`infrastructure/docker/`) siguen siendo una alternativa válida para despliegues autoalojados. Ver `docs/operations.md` para más detalles.

## Infraestructura

### Cluster
- k3s HA en Hetzner
- 3 workers: 6 CPU / ~12Gi RAM cada uno (18 CPU / ~36Gi total)
- IPs públicas de workers: `13.140.39.245`, `13.140.39.246`, `13.140.39.247`
- Puertos expuestos: 80, 443 (web), 4317, 4318 (agent mTLS)
- API k3s y SSH permanecen privados (no expuestos a internet)

### DNS y certificados
- **Dominios web**: `portal.ekumetrics.com`, `api.ekumetrics.com`, `auth.ekumetrics.com`, `grafana.ekumetrics.com`
  - Cloudflare A records → IPs de workers (puede ser orange cloud, Traefik termina TLS)
  - Certificados Let's Encrypt vía cert-manager ClusterIssuer `letsencrypt-prod`
  - HTTP redirige a HTTPS automáticamente

- **Dominio de agentes**: `ingest.ekumetrics.com`
  - Cloudflare A records → IPs de workers (**DEBE ser DNS-only / grey cloud**)
  - Orange cloud rompe mTLS client certificate verification
  - Certificados de agente mTLS son de PKI interna, NO Let's Encrypt
  - Puertos 4317 (OTLP gRPC) y 4318 (OTLP HTTP) expuestos vía LoadBalancer

### Namespace
- Nombre: `ekumetrics`
- ResourceQuota sugerida:
  - Requests: 14 CPU / 28Gi RAM / 400Gi storage
  - Limits: 16 CPU / 32Gi RAM
  - Máximo: 80 pods / 30 PVCs
- StorageClass: Longhorn (predeterminado)
- IngressClass: `traefik`
- NetworkPolicy: default-deny Ingress, permite same-namespace y kube-system

## Servicios incluidos

El overlay `overlays/saas` despliega el stack completo de producción:

### Base de datos e infraestructura
- **postgres** (pgvector) - Base de datos de plataforma
- **keycloak-db** - Base de datos dedicada para Keycloak
- **nats** - Mensajería JetStream

### Observabilidad
- **prometheus** - Métricas (30d retención)
- **loki** - Logs (30d retención)
- **tempo** - Trazas (30d retención)
- **alertmanager** - Gestión de alertas
- **grafana** - Visualización del producto (NO cluster monitoring)
- **otel-collector** - OpenTelemetry collector
- **node-exporter** - Métricas de host (DaemonSet)
- **alloy** - Recolección de logs de pods Kubernetes

### Aplicación
- **keycloak** - Identidad y autenticación (modo producción optimizado)
- **platform-api** - Backend de Ekumetrics
- **portal-web** - Frontend Angular
- **ingest-gateway** - Gateway nginx para ingesta interna
- **agent-edge** - Gateway mTLS para ingesta de agentes (LoadBalancer en 4317/4318)

### IA
- **ollama** - Runtime de modelos LLM
- **ollama-pull** - Job para descargar modelos (`qwen3.5:4b` + `qwen3-embedding:0.6b`)
- **holmes** - Perfil de investigación de IA

## Secretos requeridos

### 1. Secretos de aplicación

```bash
# Generar valores seguros
PG_PASS=$(openssl rand -base64 24)
KC_DB_PASS=$(openssl rand -base64 24)
KC_ADMIN_PASS=$(openssl rand -base64 24)
GF_PASS=$(openssl rand -base64 24)
INGEST_KEY=$(openssl rand -hex 32)
AGENT_EDGE_KEY=$(openssl rand -hex 32)
KIOSK_SECRET=$(openssl rand -hex 32)
BFF_SECRET=$(openssl rand -hex 32)
AI_ENC_KEY=$(openssl rand -hex 32)
HOLMES_KEY=$(openssl rand -hex 32)

# Crear Secret
kubectl create secret generic ekumetrics-secrets \
  --namespace ekumetrics \
  --from-literal=postgres_password="${PG_PASS}" \
  --from-literal=database_url="postgresql://ekumetrics:${PG_PASS}@postgres:5432/ekumetrics?schema=public" \
  --from-literal=keycloak_db_password="${KC_DB_PASS}" \
  --from-literal=keycloak_admin_password="${KC_ADMIN_PASS}" \
  --from-literal=grafana_admin_password="${GF_PASS}" \
  --from-literal=ingest_shared_key="${INGEST_KEY}" \
  --from-literal=agent_edge_assertion_key="${AGENT_EDGE_KEY}" \
  --from-literal=kiosk_token_secret="${KIOSK_SECRET}" \
  --from-literal=bff_session_secret="${BFF_SECRET}" \
  --from-literal=ai_settings_encryption_key="${AI_ENC_KEY}" \
  --from-literal=holmes_upstream_key="${HOLMES_KEY}"

# GUARDE estos valores en Vault o gestor de secretos
```

### 2. Certificados mTLS para agentes

Los agentes se autentican con certificados cliente firmados por una CA interna del producto.

```bash
# Requisitos de los certificados:
# - ca.crt: CA raíz que firma certificados de agentes
# - server.crt: Certificado del servidor con SAN DNS:ingest.ekumetrics.com
# - server.key: Clave privada del servidor (modo 0400)
# - Cada agente tiene cert cliente con Subject: O=<tenant_id>, OU=<site_id>, CN=<agent_id>

kubectl create secret generic agent-tls \
  --namespace ekumetrics \
  --from-file=ca.crt=/path/to/ca.crt \
  --from-file=server.crt=/path/to/server.crt \
  --from-file=server.key=/path/to/server.key
```

**CRÍTICO**: El certificado `server.crt` es de PKI interna, NO de Let's Encrypt. Los agentes validan la cadena de confianza completa. Cloudflare para `ingest.ekumetrics.com` DEBE estar en modo DNS-only (grey cloud); orange cloud termina TLS y rompe la verificación de certificados cliente.

## Despliegue

### Pre-requisitos
1. cert-manager instalado con ClusterIssuer `letsencrypt-prod`
2. Traefik IngressController configurado
3. Namespace `ekumetrics` creado con ResourceQuota
4. Secrets `ekumetrics-secrets` y `agent-tls` creados

### Aplicar manifiestos

```bash
# Desde la raíz del repositorio
kubectl apply -k infrastructure/k8s/overlays/saas
```

### Verificar despliegue

```bash
# Ver estado de pods
kubectl get pods -n ekumetrics

# Ver PVCs
kubectl get pvc -n ekumetrics

# Ver Ingress y certificados
kubectl get ingress,certificate -n ekumetrics

# Ver LoadBalancer de agent-edge
kubectl get svc agent-edge -n ekumetrics

# Logs de un servicio
kubectl logs -n ekumetrics deployment/platform-api --tail=100 -f

# Estado del Job de ollama-pull
kubectl get job ollama-pull -n ekumetrics
kubectl logs -n ekumetrics job/ollama-pull
```

## Acceso a servicios

### Para usuarios finales (web)
- **Portal**: https://portal.ekumetrics.com
- **API**: https://api.ekumetrics.com (backend, no acceso directo)
- **Grafana**: https://grafana.ekumetrics.com (embebido en portal)
- **Keycloak**: https://auth.ekumetrics.com (OIDC provider)

### Para agentes (mTLS)
Los agentes se configuran con:
- **Host**: `ingest.ekumetrics.com`
- **Puertos**: 4317 (gRPC), 4318 (HTTP)
- **Certificado cliente** con Subject `O=<tenant_id>, OU=<site_id>, CN=<agent_id>`
- **CA bundle** que incluye la ca.crt del producto

Ejemplo de configuración de agente OpenTelemetry:
```yaml
exporters:
  otlp:
    endpoint: ingest.ekumetrics.com:4317
    tls:
      insecure: false
      ca_file: /etc/ekumetrics/ca.crt
      cert_file: /etc/ekumetrics/agent.crt
      key_file: /etc/ekumetrics/agent.key
```

## Recursos dimensionados

Los recursos están ajustados para el hardware real (3×6 CPU/12Gi):

| Servicio | CPU request | Memory request | CPU limit | Memory limit | Storage |
|---|---:|---:|---:|---:|---:|
| postgres | 500m | 1Gi | 2000m | 2Gi | 10Gi |
| keycloak-db | 200m | 512Mi | 1000m | 1Gi | 5Gi |
| nats | 100m | 256Mi | 500m | 512Mi | 5Gi |
| prometheus | 500m | 1Gi | 2000m | 3Gi | 10Gi |
| loki | 300m | 512Mi | 1000m | 2Gi | 10Gi |
| tempo | 300m | 512Mi | 1000m | 2Gi | 10Gi |
| alertmanager | 50m | 128Mi | 200m | 256Mi | 2Gi |
| grafana | 200m | 256Mi | 500m | 1Gi | 2Gi |
| otel-collector | 200m | 256Mi | 1000m | 1Gi | - |
| keycloak | 500m | 768Mi | 2000m | 2Gi | - |
| platform-api | 500m | 512Mi | 2000m | 2Gi | - |
| ingest-gateway | 50m | 64Mi | 200m | 128Mi | - |
| portal-web | 100m | 128Mi | 500m | 256Mi | - |
| **ollama** | **1000m** | **4Gi** | **4000m** | **8Gi** | **20Gi** |
| holmes | 200m | 512Mi | 1000m | 2Gi | - |
| agent-edge | 100m | 128Mi | 500m | 256Mi | - |
| node-exporter | 50m | 64Mi | 200m | 128Mi | - |
| alloy | 100m | 128Mi | 500m | 512Mi | - |

**Total aproximado**: ~5.5 CPU requests / ~11Gi RAM requests, ~18 CPU limits / ~28Gi RAM limits, ~74Gi storage.

Ollama es el consumidor principal de RAM. Si el cluster tiene problemas de memoria, considere reducir el límite de Ollama o usar un nodo dedicado.

## Imágenes de contenedor

### Imágenes del producto
Las imágenes de `platform-api` y `portal-web` se construyen y publican automáticamente en push a `dev`:
- `ghcr.io/japerezsaavedra/ekumetrics-platform-api:dev`
- `ghcr.io/japerezsaavedra/ekumetrics-portal-web:dev`

### Imagen de Keycloak
La imagen optimizada de Keycloak debe construirse y publicarse manualmente:
```bash
# Desde infrastructure/docker/keycloak/
docker build -t ghcr.io/japerezsaavedra/ekumetrics-keycloak:26.7.2 -f Containerfile .
docker push ghcr.io/japerezsaavedra/ekumetrics-keycloak:26.7.2
```

Si los paquetes de GHCR son privados, configure `imagePullSecret` en los Deployments.

## Solución de problemas

### Pods en CrashLoopBackOff

```bash
# Ver logs
kubectl logs -n ekumetrics <pod-name> --previous

# Ver eventos
kubectl describe pod -n ekumetrics <pod-name>

# Verificar secretos
kubectl get secret ekumetrics-secrets -n ekumetrics -o jsonpath='{.data}' | jq 'keys'
kubectl get secret agent-tls -n ekumetrics
```

### Keycloak no arranca

Keycloak en modo producción optimizado puede tardar ~60-90s en iniciar la primera vez. Verifique que keycloak-db esté Ready primero.

```bash
kubectl logs -n ekumetrics deployment/keycloak
kubectl logs -n ekumetrics statefulset/keycloak-db
```

### Ollama out of memory

Si Ollama es killed por OOM, ajuste sus límites de memoria en base a los modelos cargados. Para `qwen3.5:4b`, 8Gi suele ser suficiente pero puede requerir más dependiendo de la carga.

### Certificados Let's Encrypt pendientes

```bash
# Ver estado de certificados
kubectl get certificate -n ekumetrics
kubectl describe certificate portal-tls -n ekumetrics

# Ver challenges
kubectl get challenges -n ekumetrics

# Verificar issuer
kubectl describe clusterissuer letsencrypt-prod
```

Si cert-manager no puede validar, verifique que los DNS A records apunten a las IPs correctas y que el puerto 80 esté accesible.

### Agent mTLS no funciona

1. Verificar que `ingest.ekumetrics.com` resuelve a las IPs correctas
2. Verificar que Cloudflare está en DNS-only (grey cloud), no orange cloud
3. Verificar que el LoadBalancer de agent-edge tiene EXTERNAL-IP asignado
4. Probar con openssl:
   ```bash
   openssl s_client -connect ingest.ekumetrics.com:4318 \
     -cert agent.crt -key agent.key -CAfile ca.crt
   ```
5. Ver logs de agent-edge:
   ```bash
   kubectl logs -n ekumetrics deployment/agent-edge
   ```

### Ingesta funciona pero eventos no llegan

Verificar que otel-collector, loki, tempo y prometheus estén Running y Ready. Ver logs de platform-api para errores de conexión.

## Actualización

Para actualizar a nuevas versiones de las imágenes:

```bash
# Las imágenes se actualizan automáticamente en push a dev
# Para forzar re-pull:
kubectl rollout restart deployment/platform-api -n ekumetrics
kubectl rollout restart deployment/portal-web -n ekumetrics

# Verificar rollout
kubectl rollout status deployment/platform-api -n ekumetrics
```

## Backup y recuperación

- **PostgreSQL**: Implementar backup regular de `postgres` y `keycloak-db` (pg_dump o Longhorn snapshots)
- **PVCs**: Longhorn snapshots o Velero para disaster recovery
- **Secretos**: Almacenar en Vault u otro gestor de secretos fuera del cluster
- **Certificados agent-tls**: Mantener copia segura de la CA y renovar server.crt antes de expiración

## Monitoreo externo

El stack incluye Prometheus/Grafana del producto. Para monitoreo del cluster (nodes, k3s, Traefik), instale kube-prometheus-stack en un namespace separado o use un sistema externo.

## Relación con Docker Compose

Este despliegue de Kubernetes reutiliza las configuraciones de `infrastructure/docker/docker-compose.production.yml`. Las diferencias principales:

- Keycloak usa base de datos dedicada (keycloak-db)
- agent-edge expuesto vía LoadBalancer en lugar de bind host
- Alloy configurado para descubrir pods de Kubernetes en lugar de contenedores Docker
- node-exporter como DaemonSet en lugar de contenedor único
- Secrets en Kubernetes Secrets en lugar de archivos montados

Docker Compose sigue siendo una opción válida para despliegues autoalojados fuera de Kubernetes.
