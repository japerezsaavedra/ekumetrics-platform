import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { API_BASE_URL } from '../../core/api';
import {
  agentTypeLabel,
  investigationStatusLabel,
  rcaModeLabel,
  rcaPercent,
  type AgentFindingDto,
  type AiopsInvestigationDto,
  type IncidentEnrichmentDto,
} from './incident-enrichment.view';

@Component({
  selector: 'app-incident-enrichment-panel',
  imports: [DatePipe, ReactiveFormsModule],
  templateUrl: './incident-enrichment-panel.html',
  styleUrl: './incident-enrichment-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IncidentEnrichmentPanel {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private poll: ReturnType<typeof setInterval> | null = null;

  readonly incidentId = input.required<string>();
  readonly enrichment = input<IncidentEnrichmentDto | null>(null);
  readonly feedbackApplied = output<IncidentEnrichmentDto>();

  protected readonly rcaPercent = rcaPercent;
  protected readonly rcaModeLabel = rcaModeLabel;
  protected readonly investigationStatusLabel = investigationStatusLabel;
  protected readonly agentTypeLabel = agentTypeLabel;
  protected readonly sending = signal(false);
  protected readonly investigating = signal(false);
  protected readonly feedbackError = signal<string | null>(null);
  protected readonly investigateError = signal<string | null>(null);
  protected readonly feedbackAvailable = signal(true);
  protected readonly investigation = signal<AiopsInvestigationDto | null>(null);
  protected readonly findings = signal<AgentFindingDto[]>([]);

  protected readonly feedbackForm = this.fb.nonNullable.group({
    action: ['CONFIRM', Validators.required],
    candidateId: [''],
    note: ['', Validators.maxLength(500)],
  });

  constructor() {
    this.destroyRef.onDestroy(() => this.stopPoll());
    effect((onCleanup) => {
      const id = this.incidentId();
      this.loadInvestigation(id);
      onCleanup(() => this.stopPoll());
    });
  }

  protected durationLabel(): string {
    const row = this.investigation();
    if (!row?.startedAt) return '—';
    const start = Date.parse(row.startedAt);
    const end = row.completedAt ? Date.parse(row.completedAt) : Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
    return `${((end - start) / 1000).toFixed(1)}s`;
  }

  protected investigate(retry = false): void {
    this.investigating.set(true);
    this.investigateError.set(null);
    this.http
      .post<AiopsInvestigationDto>(
        `${API_BASE_URL}/v1/incidents/${this.incidentId()}/investigate`,
        { retry },
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (row) => {
          this.investigating.set(false);
          this.investigation.set(row);
          this.loadFindings();
          this.maybePoll();
        },
        error: (err: { status?: number; error?: { message?: string } }) => {
          this.investigating.set(false);
          this.investigateError.set(
            err.error?.message ?? 'No se pudo iniciar la investigación AIOps.',
          );
        },
      });
  }

  protected submitFeedback(): void {
    if (!this.feedbackAvailable() || this.feedbackForm.invalid) return;
    const value = this.feedbackForm.getRawValue();
    if (value.action === 'SELECT_ALTERNATIVE' && !value.candidateId.trim()) {
      this.feedbackForm.controls.candidateId.markAsTouched();
      this.feedbackForm.controls.candidateId.setErrors({ required: true });
      return;
    }
    this.sending.set(true);
    this.feedbackError.set(null);
    this.http
      .post<IncidentEnrichmentDto>(`${API_BASE_URL}/v1/incidents/${this.incidentId()}/rca-feedback`, {
        action: value.action,
        candidateId: value.candidateId || undefined,
        note: value.note || undefined,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (row) => {
          this.sending.set(false);
          this.feedbackApplied.emit(row);
          this.feedbackForm.patchValue({ note: '' });
        },
        error: (err: { status?: number; error?: { message?: string } }) => {
          this.sending.set(false);
          if (err.status === 404) {
            this.feedbackAvailable.set(false);
            return;
          }
          this.feedbackError.set(err.error?.message ?? 'No se pudo registrar el feedback de RCA.');
        },
      });
  }

  private loadInvestigation(id: string): void {
    this.http
      .get<{ investigation: AiopsInvestigationDto | null }>(
        `${API_BASE_URL}/v1/incidents/${id}/investigation`,
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (row) => {
          this.investigation.set(row.investigation);
          if (row.investigation) this.loadFindings();
          else this.findings.set([]);
          this.maybePoll();
        },
        error: () => {
          this.investigation.set(null);
        },
      });
  }

  private loadFindings(): void {
    this.http
      .get<{ findings: AgentFindingDto[] }>(
        `${API_BASE_URL}/v1/incidents/${this.incidentId()}/investigation/findings`,
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (row) => this.findings.set(row.findings ?? []),
        error: () => this.findings.set([]),
      });
  }

  private maybePoll(): void {
    this.stopPoll();
    const status = this.investigation()?.productStatus ?? this.investigation()?.status;
    if (status === 'PENDING' || status === 'QUEUED' || status === 'RUNNING' || status === 'SYNTHESIZING') {
      this.poll = setInterval(() => this.loadInvestigation(this.incidentId()), 2500);
    }
  }

  private stopPoll(): void {
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }
}
