# Registro ASVS 5.0.0 L2

`controls.json` es el registro auditable de los **253 controles** requeridos para una evaluación de nivel 2: 70 controles clasificados L1 y 183 clasificados L2. Fue generado desde la release estable `v5.0.0_release` de OWASP, cuyo JSON plano tiene SHA-256 `8201b20eec2908c3380ac600c91c8ba746346fbb808859366abb232027532311`.

El contenido normativo pertenece a OWASP y se distribuye bajo [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Fuente: [OWASP ASVS 5.0.0](https://github.com/OWASP/ASVS/tree/v5.0.0_release).

Estados permitidos:

- `not-reviewed`: aún no evaluado requisito por requisito;
- `verified`: exige responsable, fecha ISO y al menos una evidencia reproducible;
- `not-applicable`: exige responsable, fecha y justificación específica;
- `open`: exige responsable e incidencia `EKM-n`.

`npm run asvs:check` valida integridad, procedencia, cardinalidad y evidencia mínima. `npm run asvs:ready` es la compuerta previa a GA y falla mientras exista cualquier control `not-reviewed` u `open`.
