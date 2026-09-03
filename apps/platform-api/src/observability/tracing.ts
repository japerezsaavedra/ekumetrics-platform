import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').replace(/\/$/, '');

if (endpoint) {
  const tracesUrl =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? `${endpoint}/v1/traces`;
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'ekumetrics-platform-api',
    traceExporter: new OTLPTraceExporter({ url: tracesUrl }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });
  sdk.start();
}
