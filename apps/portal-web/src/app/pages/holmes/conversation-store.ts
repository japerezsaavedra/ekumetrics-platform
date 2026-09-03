import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../../core/api';
import { AuthService } from '../../core/auth';
import { TenantService } from '../../core/tenant';

export type EvidenceReference = {
  traceId?: string;
  spanIds?: string[];
  service?: string;
  operation?: string;
  durationMs?: number;
  documentId?: string;
  sourceKey?: string;
  title?: string;
  section?: string;
  version?: string;
  approvedAt?: string;
};

export type ChatEvidence = {
  id: string;
  source: 'prometheus' | 'loki' | 'tempo' | 'postgresql' | 'inventory' | 'knowledge';
  operation?: string;
  query?: string;
  window: { start: string; end: string };
  summary: string;
  timestamp: string;
  resultCount: number;
  available?: boolean;
  citation?: string;
  references?: EvidenceReference[];
};

export type InvestigationSourceState = 'available' | 'no_data' | 'unavailable' | 'not_requested';

export type InvestigationSummary = {
  window: { start: string; end: string };
  entities: { agents: string[]; sites: string[] };
  sources: Record<ChatEvidence['source'], InvestigationSourceState>;
  confidence: {
    level: 'high' | 'medium' | 'low';
    score: number;
    reason: string;
  };
  outcome: 'normal' | 'attention' | 'no_data';
};

export type ChatMessage = {
  role: 'user' | 'assistant';
  text: string;
  turnId?: string;
  createdAt?: string;
  evidence?: ChatEvidence[];
  investigation?: InvestigationSummary;
};

export type ConversationSummary = {
  id: string;
  title: string;
  questionCount: number;
  updatedAt: string;
};

export type Conversation = ConversationSummary & {
  messages: ChatMessage[];
};

const LEGACY_STORAGE_PREFIX = 'eku-assistant-conversations';
const ACTIVE_PREFIX = 'eku-assistant-active';

@Injectable({ providedIn: 'root' })
export class ConversationStore {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly tenants = inject(TenantService);
  private restoreVersion = 0;

  readonly conversations = signal<ConversationSummary[]>([]);
  readonly activeId = signal<string | null>(null);
  readonly activeConversation = signal<Conversation | null>(null);
  readonly active = computed(() => this.activeConversation());

  constructor() {
    effect(() => {
      this.auth.email();
      this.tenants.slug();
      void this.restore();
    });
  }

  async create(title = 'Nueva sesion'): Promise<Conversation> {
    const conversation = await firstValueFrom(
      this.http.post<Conversation>(`${API_BASE_URL}/v1/ai/conversations`, { title }),
    );
    this.upsertSummary(conversation);
    this.activeConversation.set(conversation);
    this.activeId.set(conversation.id);
    this.persistActive();
    return conversation;
  }

  async select(id: string): Promise<Conversation> {
    const conversation = await firstValueFrom(
      this.http.get<Conversation>(`${API_BASE_URL}/v1/ai/conversations/${id}`),
    );
    this.upsertSummary(conversation);
    this.activeConversation.set(conversation);
    this.activeId.set(conversation.id);
    this.persistActive();
    return conversation;
  }

  reflectMessages(id: string, messages: ChatMessage[], title?: string): void {
    const active = this.activeConversation();
    if (!active || active.id !== id) return;
    const next: Conversation = {
      ...active,
      messages,
      title: title || active.title,
      questionCount: messages.filter((item) => item.role === 'user').length,
      updatedAt: new Date().toISOString(),
    };
    this.activeConversation.set(next);
    this.upsertSummary(next);
  }

  async remove(id: string): Promise<void> {
    await firstValueFrom(this.http.delete(`${API_BASE_URL}/v1/ai/conversations/${id}`));
    const next = this.conversations().filter((item) => item.id !== id);
    this.conversations.set(next);
    if (this.activeId() !== id) return;
    this.activeId.set(null);
    this.activeConversation.set(null);
    this.persistActive();
    if (next[0]) await this.select(next[0].id);
  }

  private async restore(): Promise<void> {
    const keys = this.keys();
    const version = ++this.restoreVersion;
    if (!keys) {
      this.conversations.set([]);
      this.activeId.set(null);
      this.activeConversation.set(null);
      return;
    }
    localStorage.removeItem(keys.legacyList);
    try {
      const items = await firstValueFrom(
        this.http.get<ConversationSummary[]>(`${API_BASE_URL}/v1/ai/conversations`),
      );
      if (version !== this.restoreVersion) return;
      this.conversations.set(items);
      const stored = localStorage.getItem(keys.active);
      const selected = items.find((item) => item.id === stored)?.id ?? items[0]?.id;
      if (selected) {
        await this.select(selected);
      } else {
        this.activeId.set(null);
        this.activeConversation.set(null);
        this.persistActive();
      }
    } catch {
      if (version !== this.restoreVersion) return;
      this.conversations.set([]);
      this.activeId.set(null);
      this.activeConversation.set(null);
    }
  }

  private upsertSummary(conversation: ConversationSummary): void {
    const summary: ConversationSummary = {
      id: conversation.id,
      title: conversation.title,
      questionCount: conversation.questionCount,
      updatedAt: conversation.updatedAt,
    };
    this.conversations.update((items) => [
      summary,
      ...items.filter((item) => item.id !== summary.id),
    ]);
  }

  private persistActive(): void {
    const keys = this.keys();
    if (!keys) return;
    const active = this.activeId();
    if (active) localStorage.setItem(keys.active, active);
    else localStorage.removeItem(keys.active);
  }

  private keys(): { active: string; legacyList: string } | null {
    const email = this.auth.email().trim().toLowerCase();
    const tenant = this.tenants.slug().trim().toLowerCase();
    if (!email || !tenant) return null;
    const scope = `${email}:${tenant}`;
    return {
      active: `${ACTIVE_PREFIX}:${scope}`,
      legacyList: `${LEGACY_STORAGE_PREFIX}:${scope}`,
    };
  }
}
