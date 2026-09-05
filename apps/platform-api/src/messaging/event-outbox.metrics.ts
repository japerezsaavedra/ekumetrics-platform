import { Injectable } from '@nestjs/common';
import { AiopsMetricNames } from '../aiops/contracts/metrics';
import { EventSubjects } from './subjects';

@Injectable()
export class EventOutboxMetrics {
  private ingestedPublished = 0;
  private ingestedFailures = 0;
  private rcaRequestedPublished = 0;
  private rcaRequestedFailures = 0;

  recordPublished(subject: string): void {
    if (subject === EventSubjects.EVENTS_INGESTED) {
      this.ingestedPublished += 1;
      return;
    }
    if (subject === EventSubjects.RCA_REQUESTED) {
      this.rcaRequestedPublished += 1;
    }
  }

  recordFailure(subject: string): void {
    if (subject === EventSubjects.EVENTS_INGESTED) {
      this.ingestedFailures += 1;
      return;
    }
    if (subject === EventSubjects.RCA_REQUESTED) {
      this.rcaRequestedFailures += 1;
    }
  }

  render(): string {
    return [
      `# HELP ${AiopsMetricNames.EVENTS_INGESTED_PUBLISHED_TOTAL} Publicaciones de ekumetrics.events.ingested.`,
      `# TYPE ${AiopsMetricNames.EVENTS_INGESTED_PUBLISHED_TOTAL} counter`,
      `${AiopsMetricNames.EVENTS_INGESTED_PUBLISHED_TOTAL} ${this.ingestedPublished}`,
      `# HELP ${AiopsMetricNames.EVENTS_INGESTED_PUBLISH_FAILURES_TOTAL} Fallos al publicar ekumetrics.events.ingested.`,
      `# TYPE ${AiopsMetricNames.EVENTS_INGESTED_PUBLISH_FAILURES_TOTAL} counter`,
      `${AiopsMetricNames.EVENTS_INGESTED_PUBLISH_FAILURES_TOTAL} ${this.ingestedFailures}`,
      `# HELP ${AiopsMetricNames.RCA_REQUESTED_PUBLISHED_TOTAL} Publicaciones de ekumetrics.rca.requested.`,
      `# TYPE ${AiopsMetricNames.RCA_REQUESTED_PUBLISHED_TOTAL} counter`,
      `${AiopsMetricNames.RCA_REQUESTED_PUBLISHED_TOTAL} ${this.rcaRequestedPublished}`,
      `# HELP ${AiopsMetricNames.RCA_REQUESTED_PUBLISH_FAILURES_TOTAL} Fallos al publicar ekumetrics.rca.requested.`,
      `# TYPE ${AiopsMetricNames.RCA_REQUESTED_PUBLISH_FAILURES_TOTAL} counter`,
      `${AiopsMetricNames.RCA_REQUESTED_PUBLISH_FAILURES_TOTAL} ${this.rcaRequestedFailures}`,
    ].join('\n') + '\n';
  }
}
