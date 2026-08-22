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
import { ConversationStore, type ChatMessage, type Conversation } from './conversation-store';
import { EXAMPLE_QUESTIONS } from './example-questions';

type AiAskResponse = {
  analysis: string;
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
      this.startNew();
      this.askExample(draft);
      void this.router.navigate(['/asistente'], { replaceUrl: true });
    }
  }

  protected startNew(): void {
    this.store.create();
    this.messages.set([]);
    this.error.set(null);
    this.form.reset({ question: '' });
    this.selected.set(0);
  }

  protected openConversation(id: string): void {
    if (this.loading()) {
      return;
    }
    this.store.select(id);
    this.messages.set(this.store.active()?.messages ?? []);
    this.error.set(null);
    this.selected.set(0);
  }

  protected removeConversation(id: string, event: Event): void {
    event.stopPropagation();
    if (this.loading()) {
      return;
    }
    this.store.remove(id);
    this.messages.set(this.store.active()?.messages ?? []);
  }

  protected questionCount(item: Conversation): number {
    return item.messages.filter((message) => message.role === 'user').length;
  }

  protected askExample(question: string): void {
    this.form.controls.question.setValue(question);
    this.submit();
  }

  protected onQuestionKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey) {
      return;
    }
    event.preventDefault();
    this.submit();
  }

  protected submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const question = this.form.controls.question.value.trim();
    this.form.controls.question.setValue('');
    const conversation = this.store.active() ?? this.store.create(this.titleFrom(question));
    const next = [...this.messages(), { role: 'user' as const, text: question }];
    this.messages.set(next);
    this.persist(conversation.id, next, this.titleFrom(question));
    this.loading.set(true);
    this.error.set(null);
    this.elapsed.set(0);
    this.stopTimer();
    this.timer = setInterval(() => this.elapsed.update((n) => n + 1), 1000);
    this.http.post<AiAskResponse>(`${API_BASE_URL}/v1/ai/ask`, { question }).subscribe({
      next: (value) => {
        this.stopTimer();
        const withReply = [
          ...this.messages(),
          { role: 'assistant' as const, text: this.replyText(value.analysis) },
        ];
        this.messages.set(withReply);
        this.persist(conversation.id, withReply);
        this.loading.set(false);
      },
      error: (err: { error?: { message?: string | string[] } }) => {
        this.stopTimer();
        this.loading.set(false);
        const raw = err.error?.message;
        this.error.set(
          Array.isArray(raw) ? raw.join(' ') : (raw ?? 'No hubo respuesta.'),
        );
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

  private persist(id: string, messages: ChatMessage[], title?: string): void {
    this.store.saveMessages(id, messages, title);
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
