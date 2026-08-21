# ADR-0002 — Ekumetrics Design System

- Estado: aceptado
- Fecha: 2026-08-20
- Producto: Ekumetrics Platform

## Contexto

El portal usa Angular Material como infraestructura, pero el producto no debe parecer una aplicación Material genérica. Hace falta una identidad propia, temas claro y oscuro, y tokens semánticos compartidos.

## Decisión

1. Angular Material y Angular CDK son la única biblioteca visual. No se añade PrimeNG, Bootstrap, Tailwind ni Nebular.
2. La identidad se llama Ekumetrics Design System. Los tokens viven en `apps/portal-web/src/styles/`.
3. Los componentes de feature no usan hex ni `!important`. Consumen tokens semánticos (`surface`, `primary`, `critical`, etc.).
4. Temas claro y oscuro con Angular Material Theming API y clase `eku-theme-light` / `eku-theme-dark` en `html`.
5. Iconos: Material Symbols. Estado local: Signals. HTTP: RxJS.
6. Wrappers `Eku*` se crean cuando hay uso repetido. Fase 1: `EkuPageHeader`, `EkuEmptyState`, `EkuErrorState`, `EkuLoadingSkeleton`.
7. Grafana embebido permanece en el laboratorio. Apache ECharts y el resto de wrappers se añaden cuando existan APIs de series propias.

## Consecuencias

- Un cambio de marca o de tema se hace en tokens, no página a página.
- Los gráficos nativos deberán leer los mismos tokens que Material.
- MatSnackBar no se usa para incidentes persistentes.
