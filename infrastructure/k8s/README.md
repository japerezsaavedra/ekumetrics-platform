# Despliegue de Ekumetrics en Kubernetes (k3s Lab)

Este directorio contiene los manifiestos de Kubernetes para desplegar ekumetrics-platform en un cluster k3s de laboratorio existente.

⚠️ **IMPORTANTE**: Este es un despliegue adicional para laboratorio. Los archivos de Docker Compose (`infrastructure/docker/`) siguen siendo la forma recomendada para despliegues locales y de producción. Ver `docs/operations.md` para más detalles.

## Requisitos previos

- Cluster k3s HA con namespace `ekumetrics` ya creado
- ResourceQuota del namespace: 12 CPU / 24Gi RAM / 400Gi storage (requests), 16 CPU / 30Gi RAM (límites)
- StorageClass predeterminado: Longhorn
- IngressClass: `traefik`
- Control-plane nodes con taint NoSchedule (los workloads se programan solo en workers)
- NetworkPolicy default-deny Ingress (permite tráfico same-namespace y desde kube-system)

## Servicios incluidos en el overlay de lab

El overlay `overlays/lab` despliega:

- **postgres** (pgvector) - Base de datos principal
- **nats** - Mensajería JetStream
- **prometheus** - Métricas (30d retención, 8GB)
- **loki** - Logs (30d retención)
- **tempo** - Trazas (30d retención)
- **alertmanager** - Gestión de alertas
- **grafana** - Visualización
- **otel-collector** - OpenTelemetry collector
- **keycloak** - Identidad y autenticación (modo dev)
- **platform-api** - Backend de Ekumetrics
- **ingest-gateway** - Gateway nginx para ingesta OTLP
- **portal-web** - Frontend Angular

## Servicios NO incluidos (para evitar superar la quota)

Los siguientes servicios están disponibles en el Compose pero se excluyen del lab k8s por defecto:

- **ollama** + **ollama-pull** - Requiere demasiada RAM para la quota del lab
- **holmes** - Perfil de IA (opcional)
- **alloy** - Requiere acceso a docker.sock (no aplicable en k8s)
- **node-exporter** - Puede agregarse después como DaemonSet
- **agent-edge** - Borde mTLS para producción (no necesario en LAN de lab)

## Crear el Secret de credenciales

**Antes de aplicar los manifiestos**, cree el Secret con las credenciales:

```bash
# Generar contraseñas aleatorias seguras
PG_PASS=$(openssl rand -base64 24)
KC_PASS=$(openssl rand -base64 24)
GF_PASS=$(openssl rand -base64 24)
INGEST_KEY=$(openssl rand -hex 32)
KIOSK_SECRET=$(openssl rand -hex 32)
BFF_SECRET=$(openssl rand -hex 32)
AI_ENC_KEY=$(openssl rand -hex 32)

# Crear el Secret en el namespace ekumetrics
kubectl create secret generic ekumetrics-secrets \
  --namespace ekumetrics \
  --from-literal=postgres_password="${PG_PASS}" \
  --from-literal=database_url="postgresql://ekumetrics:${PG_PASS}@postgres:5432/ekumetrics?schema=public" \
  --from-literal=keycloak_admin_password="${KC_PASS}" \
  --from-literal=grafana_admin_password="${GF_PASS}" \
  --from-literal=ingest_shared_key="${INGEST_KEY}" \
  --from-literal=kiosk_token_secret="${KIOSK_SECRET}" \
  --from-literal=bff_session_secret="${BFF_SECRET}" \
  --from-literal=ai_settings_encryption_key="${AI_ENC_KEY}"

# Guarde estas credenciales de forma segura
echo "Postgres password: ${PG_PASS}"
echo "Keycloak admin password: ${KC_PASS}"
echo "Grafana admin password: ${GF_PASS}"
```

## Despliegue

Una vez creado el Secret, aplique los manifiestos:

```bash
# Desde la raíz del repositorio
kubectl apply -k infrastructure/k8s/overlays/lab
```

Verifique el despliegue:

```bash
# Ver todos los pods
kubectl get pods -n ekumetrics

# Ver PVCs
kubectl get pvc -n ekumetrics

# Ver Ingress
kubectl get ingress -n ekumetrics

# Ver eventos recientes
kubectl get events -n ekumetrics --sort-by='.lastTimestamp' | tail -20

# Logs de un pod específico
kubectl logs -n ekumetrics deployment/platform-api --tail=50
```

## Acceso a los servicios

Configure `/etc/hosts` en su máquina para apuntar a los workers del cluster:

```
# Ajuste las IPs según su cluster (workers: 10.0.0.2, 10.0.0.3, 10.0.0.6)
10.0.0.2  portal.gd.lan api.gd.lan grafana.eku.gd.lan auth.gd.lan
```

Luego acceda a:

- **Portal**: http://portal.gd.lan
- **API**: http://api.gd.lan
- **Grafana**: http://grafana.eku.gd.lan (usuario: `ekumetrics`, contraseña: ver Secret)
- **Keycloak**: http://auth.gd.lan (usuario: `admin`, contraseña: ver Secret)

⚠️ **Nota**: Estos hostnames son para LAN interna. No están expuestos a internet público.

## Imágenes de contenedor

Las imágenes de `platform-api` y `portal-web` se construyen y publican automáticamente en GHCR cuando se hace push a la rama `dev`:

- `ghcr.io/japerezsaavedra/ekumetrics-platform-api:dev`
- `ghcr.io/japerezsaavedra/ekumetrics-portal-web:dev`

Si los paquetes de GHCR se crean como privados, necesitará un `imagePullSecret`:

```bash
kubectl create secret docker-registry ghcr-pull \
  --namespace ekumetrics \
  --docker-server=ghcr.io \
  --docker-username=<GITHUB_USERNAME> \
  --docker-password=<GITHUB_PAT>

# Luego agregue a los Deployments:
# imagePullSecrets:
#   - name: ghcr-pull
```

## Recursos y límites

Los recursos están dimensionados para cumplir con la ResourceQuota del namespace:

| Servicio | CPU request | Memory request | CPU limit | Memory limit |
|---|---:|---:|---:|---:|
| postgres | 500m | 1Gi | 2000m | 2Gi |
| nats | 100m | 256Mi | 500m | 512Mi |
| prometheus | 500m | 1Gi | 2000m | 3Gi |
| loki | 300m | 512Mi | 1000m | 2Gi |
| tempo | 300m | 512Mi | 1000m | 2Gi |
| alertmanager | 50m | 128Mi | 200m | 256Mi |
| grafana | 200m | 256Mi | 500m | 1Gi |
| otel-collector | 200m | 256Mi | 1000m | 1Gi |
| keycloak | 500m | 768Mi | 2000m | 2Gi |
| platform-api | 500m | 512Mi | 2000m | 2Gi |
| ingest-gateway | 50m | 64Mi | 200m | 128Mi |
| portal-web | 100m | 128Mi | 500m | 256Mi |
| **TOTAL** | **~3.8 CPU** | **~5.3Gi** | **~12.4 CPU** | **~17.8Gi** |

Los valores están por debajo de la quota (12 CPU / 24Gi RAM requests) dejando margen para bursts y réplicas adicionales.

## Volúmenes persistentes

Cada StatefulSet solicita un PVC:

- postgres: 10Gi
- nats: 5Gi
- prometheus: 10Gi
- loki: 10Gi
- tempo: 10Gi
- alertmanager: 2Gi
- grafana: 2Gi

**Total**: ~49Gi (dentro de la quota de 400Gi storage y 30 PVCs)

Los tamaños están ajustados para un laboratorio. La retención de Prometheus se redujo a 8GB (vs 10GB en Compose).

## Solución de problemas

### Los pods no inician (Pending)

```bash
# Ver estado del pod y eventos
kubectl describe pod -n ekumetrics <pod-name>

# Revisar quota del namespace
kubectl describe resourcequota -n ekumetrics

# Verificar PVCs
kubectl get pvc -n ekumetrics
```

### ImagePullBackOff

Si los paquetes de GHCR son privados, cree el imagePullSecret (ver sección "Imágenes de contenedor" arriba).

### CrashLoopBackOff en platform-api

Verifique que el Secret `ekumetrics-secrets` exista y contenga todas las claves requeridas:

```bash
kubectl get secret ekumetrics-secrets -n ekumetrics -o jsonpath='{.data}' | jq 'keys'
```

### Keycloak no arranca

Keycloak tarda ~60s en iniciar la primera vez. Verifique los logs:

```bash
kubectl logs -n ekumetrics deployment/keycloak --tail=100
```

## Desinstalar

Para eliminar el despliegue pero conservar los datos:

```bash
kubectl delete -k infrastructure/k8s/overlays/lab
```

Para eliminar también los PVCs (⚠️ **esto borra todos los datos**):

```bash
kubectl delete pvc -n ekumetrics --all
```

## Relación con Docker Compose

Este despliegue de Kubernetes es **complementario** al Docker Compose. Las configuraciones base (Prometheus, Loki, Tempo, OTEL, Grafana, Keycloak realm) se copian desde `infrastructure/docker/`.

Para despliegues de producción, sigue siendo recomendable usar Docker Compose con el override `docker-compose.production.yml` según se documenta en `docs/operations.md`.

## Siguientes pasos

- Agregar DaemonSet de node-exporter si se necesita monitoreo de host
- Crear overlay de producción con Keycloak optimizado y base de datos dedicada
- Configurar HorizontalPodAutoscaler para platform-api si la carga aumenta
- Configurar backup de PVCs (Longhorn snapshots o Velero)
