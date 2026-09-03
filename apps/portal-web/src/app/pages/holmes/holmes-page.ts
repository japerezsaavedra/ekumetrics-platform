import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { MatTab, MatTabGroup } from '@angular/material/tabs';
import { MatTooltip } from '@angular/material/tooltip';
import { ActivatedRoute, Router } from '@angular/router';
import { API_BASE_URL } from '../../core/api';
import { EkuEmptyStateComponent } from '../../shared/eku/empty-state/eku-empty-state';
import { EkuErrorStateComponent } from '../../shared/eku/error-state/eku-error-state';
import { EkuLoadingSkeletonComponent } from '../../shared/eku/loading-skeleton/eku-loading-skeleton';
import { EkuMarkdownComponent } from '../../shared/eku/markdown/eku-markdown';
import { EkuPageHeaderComponent } from '../../shared/eku/page-header/eku-page-header';
import {
  ConversationStore,
  type ChatEvidence,
  type ChatMessage,
  type ConversationSummary,
  type InvestigationSummary,
} from './conversation-store';
import { EXAMPLE_QUESTIONS } from './example-questions';
import {
  confidenceLabel,
  investigationSources,
  outcomeLabel,
  sourceStateLabel,
} from './investigation-view';

type AiAskResponse = {
  analysis: string;
  conversationId: string;
  evidence: ChatEvidence[];
  investigation: InvestigationSummary;
};

@Component({
  selector: 'app-holmes-page',
  imports: [
    ReactiveFormsModule,
    MatIcon,
    MatTooltip,
    MatTabGroup,
    MatTab,
    EkuPageHeaderComponent,
    EkuMarkdownComponent,
    EkuEmptyStateComponent,
    EkuErrorStateComponent,
    EkuLoadingSkeletonComponent,
  ],
  templateUrl: './holmes-page.html',
  styleUrl: './holmes-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HolmesPage {
  private readonly http = inject(HttpClient);
  private readonly fb = inject(FormBuilder);
  private readonly store = inject(ConversationStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly examples = EXAMPLE_QUESTIONS;
  protected readonly conversations = this.store.conversations;
  protected readonly activeId = this.store.activeId;
  protected readonly activeTitle = computed(() => this.store.active()?.title ?? null);
  protected readonly messages = signal<ChatMessage[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly elapsed = signal(0);
  protected readonly selected = signal(0);
  private readonly thread = viewChild<ElementRef<HTMLElement>>('thread');
  private timer: ReturnType<typeof setInterval> | undefined;

  protected readonly form = this.fb.nonNullable.group({
    question: ['', [Validators.required, Validators.minLength(4)]],
  });

  constructor() {
    effect(() => {
      this.messages.set(this.store.active()?.messages ?? []);
    });
    effect(() => {
      this.messages();
      this.loading();
      queueMicrotask(() => this.scrollToEnd());
    });
    const draft = this.route.snapshot.queryParamMap.get('q')?.trim();
    if (draft && draft.length >= 4) {
      void this.startWithQuestion(draft);
      void this.router.navigate(['/asistente'], { replaceUrl: true });
    }
  }

  protected async startNew(): Promise<void> {
    if (this.loading()) return;
    try {
      await this.store.create();
      this.messages.set([]);
      this.error.set(null);
      this.form.reset({ question: '' });
      this.selected.set(0);
    } catch (error) {
      this.error.set(this.errorMessage(error));
    }
  }

  protected async openConversation(id: string): Promise<void> {
    if (this.loading()) {
      return;
    }
    try {
      const conversation = await this.store.select(id);
      this.messages.set(conversation.messages);
      this.error.set(null);
      this.selected.set(0);
    } catch (error) {
      this.error.set(this.errorMessage(error));
    }
  }

  protected async removeConversation(id: string, event: Event): Promise<void> {
    event.stopPropagation();
    if (this.loading()) {
      return;
    }
    try {
      await this.store.remove(id);
      this.messages.set(this.store.active()?.messages ?? []);
    } catch (error) {
      this.error.set(this.errorMessage(error));
    }
  }

  protected questionCount(item: ConversationSummary): number {
    return item.questionCount;
  }

  protected askExample(question: string): void {
    this.form.controls.question.setValue(question);
    void this.submit();
  }

  protected onQuestionKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey) {
      return;
    }
    event.preventDefault();
    void this.submit();
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const question = this.form.controls.question.value.trim();
    this.form.controls.question.setValue('');
    let conversation = this.store.active();
    if (!conversation) {
      try {
        conversation = await this.store.create(this.titleFrom(question));
      } catch (error) {
        this.error.set(this.errorMessage(error));
        return;
      }
    }
    const next = [...this.messages(), { role: 'user' as const, text: question }];
    this.messages.set(next);
    this.persist(conversation.id, next, this.titleFrom(question));
    this.loading.set(true);
    this.error.set(null);
    this.elapsed.set(0);
    this.stopTimer();
    this.timer = setInterval(() => this.elapsed.update((n) => n + 1), 1000);
    this.http
      .post<AiAskResponse>(`${API_BASE_URL}/v1/ai/ask`, {
        question,
        conversationId: conversation.id,
      })
      .subscribe({
        next: (value) => {
          this.stopTimer();
          const withReply = [
            ...this.messages(),
            {
              role: 'assistant' as const,
              text: this.replyText(value.analysis),
              evidence: value.evidence,
              investigation: value.investigation,
            },
          ];
          this.messages.set(withReply);
          this.persist(conversation.id, withReply);
          this.loading.set(false);
        },
        error: (err: { error?: { message?: string | string[] } }) => {
          this.stopTimer();
          this.loading.set(false);
          const raw = err.error?.message;
          this.error.set(Array.isArray(raw) ? raw.join(' ') : (raw ?? 'No hubo respuesta.'));
        },
      });
  }

  protected formatWhen(iso: string): string {
    return new Date(iso).toLocaleString('es', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  protected evidenceItems(value: ChatEvidence[] | undefined): ChatEvidence[] {
    return Array.isArray(value) ? value.slice(0, 20) : [];
  }

  protected sourceLabel(source: ChatEvidence['source']): string {
    const labels: Record<ChatEvidence['source'], string> = {
      prometheus: 'Métricas',
      loki: 'Logs',
      tempo: 'Trazas',
      postgresql: 'Eventos',
      inventory: 'Inventario',
      knowledge: 'Conocimiento',
    };
    return labels[source];
  }

  protected readonly investigationSources = investigationSources;
  protected readonly sourceStateLabel = sourceStateLabel;
  protected readonly outcomeLabel = outcomeLabel;
  protected readonly confidenceLabel = confidenceLabel;

  protected confidencePercent(value: number): number {
    return Math.round(Math.min(1, Math.max(0, value)) * 100);
  }

  private persist(id: string, messages: ChatMessage[], title?: string): void {
    this.store.reflectMessages(id, messages, title);
  }

  private async startWithQuestion(question: string): Promise<void> {
    await this.startNew();
    if (!this.store.active()) return;
    this.form.controls.question.setValue(question);
    await this.submit();
  }

  private errorMessage(error: unknown): string {
    if (!error || typeof error !== 'object' || !('error' in error)) {
      return 'No fue posible acceder al historial.';
    }
    const raw = (error as { error?: { message?: string | string[] } }).error?.message;
    return Array.isArray(raw) ? raw.join(' ') : (raw ?? 'No fue posible acceder al historial.');
  }

  private titleFrom(question: string): string {
    const clean = question.replace(/\s+/g, ' ').trim();
    return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean;
  }

  private replyText(analysis: string): string {
    const marker = 'Explicacion:';
    const index = analysis.indexOf(marker);
    const text = (index >= 0 ? analysis.slice(index + marker.length) : analysis).trim();
    return text || 'Sin respuesta.';
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private scrollToEnd(): void {
    const el = this.thread()?.nativeElement;
    if (!el) {
      return;
    }
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }
}
