# Tenants, sitios, agentes y modos

Guía operativa de cómo Ekumetrics separa clientes, sedes y el software que reporta métricas. El YAML sigue usando `site`, `central`, `sensor` y `endpoint`. El portal muestra los tipos comerciales: **Servidor**, **NOC**, **Sensor** y **Endpoint**.

## Cómo se lee el árbol

```
Tenant (organización)
  └── Sitio (sede o planta)
        └── Agente (proceso que recolecta)
              └── Señales (hosts, SNMP, logs, flujos…)
```

Tres preguntas, tres objetos:

| Pregunta | Objeto | Ejemplo |
|---|---|---|
| ¿De qué cliente son los datos? | Tenant | `acme`, dominio `@acme.com` |
| ¿En qué ubicación física? | Sitio | `planta-norte` (Planta Norte) |
| ¿Qué proceso los envía? | Agente | `agent-planta-norte-01`, instalado en un servidor |

Un usuario, un host o un incidente **siempre** pertenecen a un tenant. Un agente **siempre** pertenece a un tenant y a un sitio. El dashboard, el kiosk y EkuAssistant filtran por ese tenant (y, cuando aplica, por sitio).

## Tenant

Es la organización cliente. Un cliente = un tenant.

| Campo | Uso |
|---|---|
| `name` | Nombre visible (Acme Latam) |
| `slug` | Identidad técnica. Es el `tenantId` del YAML del agente y el atributo `tenant` de Keycloak |
| `emailDomain` | Dominio corporativo. Los usuarios de ese tenant solo pueden tener correo `@dominio` |

Al crear un tenant, la plataforma:

1. Crea la ficha en Prisma.
2. Crea el primer sitio (por defecto `local` / Sede principal).
3. Crea el primer administrador en Prisma y en Keycloak (rol `admin`, atributo `tenant` = slug).
4. Muestra una sola vez la contraseña inicial.

### Quién puede hacer qué

| Actor | Rol Keycloak | Tenant del token | Qué puede |
|---|---|---|---|
| Operador Gradotech | `operator` | `default` | Crear tenants, impersonar (`?as=` / selector), ver todos |
| Administrador de cliente | `admin` | slug del cliente | Usuarios, sitios y agentes **de su tenant** |
| Consulta | `viewer` | slug del cliente | Ver, no alta |

El login no pide tenant: Keycloak lo lleva en el token. Un admin de Acme no puede gestionar el tenant de otro cliente. El selector de tenant del navbar solo aparece para el operador.

El tenant `default` es Gradotech. No se recrea.

## Sitio

Es una sede, planta o zona **dentro** de un tenant. Sirve para partir dashboards, agregados y el recuento de agentes.

| Campo | Uso |
|---|---|
| `name` | Nombre visible (Planta Norte) |
| `slug` | Debe coincidir con `agent.site` en el YAML. Solo minúsculas, números, `.`, `-`, `_` |

Al crear el tenant se crea el primer sitio. El resto lo agrega el admin en **Administración → Sitios**.

Si el YAML dice `site: planta-norte` y en la plataforma el slug es `norte`, las señales no se agrupan en esa sede. El slug es el contrato, no el nombre visible.

Un tenant puede tener varios sitios (oficina, planta, DR). Un sitio no se comparte entre tenants.

## Agente

Es el proceso **Ekumetrics Agent** que corre en una máquina y empuja métricas, logs y eventos. No se instala desde el portal: el portal **inscribe** la identidad y entrega el YAML.

Identidad en cada señal:

| Campo YAML | Origen | Viaja como |
|---|---|---|
| `agent.tenantId` | slug del tenant | `tenant_id` |
| `agent.site` | slug del sitio | `site_id` |
| `agent.agentId` | id único en ese tenant | `agent_id` |
| `agent.mode` | modo de instalación | etiqueta `mode` |

`tenantId` + `agentId` son únicos. Dos sedes del mismo cliente no pueden reutilizar el mismo `agentId`.

### Por qué existe «Agregar agente»

El botón no despliega software. Hace tres cosas:

1. Registra la ficha en Prisma (tenant, sitio, `agentId`, modo).
2. Genera el `agent.yaml` con esa identidad.
3. Lo muestra una vez para pegarlo en `/etc/ekumetrics-agent/agent.yaml` y reiniciar el servicio.

Sin ese alta, el binario no sabría a qué cliente y sede reportar, y el portal no tendría ficha para contar agentes por sitio.

Tras inscribir, hay que instalar el paquete del agente en la máquina, pegar el YAML y, en laboratorio, apuntar `export.otlp.endpoint` a la plataforma.

## Tipos de agente (nombres comerciales)

El portal muestra el **tipo**. El YAML guarda `site`, `central`, `sensor` o `endpoint`. El binario es el mismo.

| Tipo | YAML | Qué recolecta | Cuándo |
|---|---|---|---|
| **Servidor** | `site` | Esa máquina (CPU, disco, red) y, si se activa, la red de la planta: SNMP, syslog, NetFlow, traps, probes | Caso habitual. Servidor de aplicaciones, de archivos o recolector de sede |
| **NOC** | `central` | APIs de consolas (FortiAnalyzer, Strata, FMC). Reservado | El proceso vive junto a los gestores |
| **Sensor** | `sensor` | Tráfico de un puerto espejo (hoy: canal SAP). Sin payload salvo autorización | SPAN/TAP; se quieren conversaciones, no el host |
| **Endpoint** | `endpoint` | CPU, disco, procesos y logs del PC o portátil | El agente está en el puesto del usuario. No es MDM |

### Un servidor: ¿cuál elijo?

**Servidor** (`site`).

```yaml
agent:
  mode: site
  tenantId: acme
  site: planta-norte
  agentId: agent-planta-norte-01
```

`servers.this` va con **Servidor**. **Endpoint** es solo el PC o portátil.

### Cómo elegir

1. ¿PC o portátil del usuario? → **Endpoint**.
2. ¿Puerto espejo (SPAN/TAP)? → **Sensor**.
3. ¿Gestores del centro de operaciones? → **NOC**.
4. ¿Un servidor? → **Servidor**.

### Lo que el tipo no es

- No es el tipo de activo en la CMDB.
- No cambia el tenant ni el sitio.
- No instala un binario distinto.
- Un switch o UPS **no** lleva agente: los consulta el tipo **Servidor** de esa planta (SNMP).

### Relación con Zabbix

Zabbix no usa estos tipos. Equivalencia aproximada:

| Zabbix | Ekumetrics |
|---|---|
| Host con Zabbix agent | **Servidor** o **Endpoint** |
| Zabbix proxy | Parte de **Servidor** (un proceso por planta, también SNMP/syslog) |
| Host solo SNMP | No se inscribe agente; lo consulta el **Servidor** de la planta |
| Integraciones / APIs | **NOC** (reservado) |
| (sin equivalente de SPAN) | **Sensor** |

## Relación con el login

El alta de usuario (Usuarios o primer admin del tenant) crea la cuenta en Prisma y en Keycloak: mismo correo, atributo `tenant` = slug, rol `admin` o `viewer`. La contraseña inicial se muestra una vez; el primer ingreso obliga a cambiarla. El operador y el admin de laboratorio (`operator@`, `admin@`) no pasan por ese cambio.

## Dónde se opera en el portal

| Tarea | Pantalla | Quién |
|---|---|---|
| Crear cliente, dominio y primer admin | Administración → Tenants | Operador |
| Crear usuarios del cliente | Administración → Usuarios | Operador o admin del tenant |
| Crear sedes | Administración → Sitios → Agregar sitio | Admin del tenant |
| Inscribir un recolector y obtener YAML | Administración → Sitios → Agregar agente | Admin del tenant |

## Referencias

- Contrato de identidad del agente: `docs/adr/0001-stack-y-contrato-agente.md`
- Rol y capacidades del binario: `ekumetrics-agent/docs/ROL.md` y `ekumetrics-agent/docs/USO.md`
