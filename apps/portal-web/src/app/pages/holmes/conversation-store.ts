import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AuthService } from '../../core/auth';
import { TenantService } from '../../core/tenant';

export type ChatMessage = {
  role: 'user' | 'assistant';
  text: string;
};

export type Conversation = {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: string;
};

const STORAGE_PREFIX = 'eku-assistant-conversations';
const ACTIVE_PREFIX = 'eku-assistant-active';

function newConversationId(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

@Injectable({ providedIn: 'root' })
export class ConversationStore {
  private readonly auth = inject(AuthService);
  private readonly tenants = inject(TenantService);
  readonly conversations = signal<Conversation[]>([]);
  readonly activeId = signal<string | null>(null);
  readonly active = computed(() => {
    const id = this.activeId();
    return this.conversations().find((item) => item.id === id) ?? null;
  });

  constructor() {
    effect(() => {
      this.auth.email();
      this.tenants.slug();
      this.restore();
    });
  }

  create(title = 'Nueva sesion'): Conversation {
    const conversation: Conversation = {
      id: newConversationId(),
      title,
      messages: [],
      updatedAt: new Date().toISOString(),
    };
    this.conversations.update((items) => [conversation, ...items]);
    this.activeId.set(conversation.id);
    this.persist();
    return conversation;
  }

  select(id: string): void {
    if (this.conversations().some((item) => item.id === id)) {
      this.activeId.set(id);
      this.persist();
    }
  }

  saveMessages(id: string, messages: ChatMessage[], title?: string): void {
    this.conversations.update((items) =>
      items.map((item) =>
        item.id === id
          ? {
              ...item,
              messages,
              title: title || item.title,
              updatedAt: new Date().toISOString(),
            }
          : item,
      ),
    );
    this.persist();
  }

  remove(id: string): void {
    const next = this.conversations().filter((item) => item.id !== id);
    this.conversations.set(next);
    if (this.activeId() === id) {
      this.activeId.set(next[0]?.id ?? null);
    }
    this.persist();
  }

  private restore(): void {
    const keys = this.keys();
    if (!keys) {
      this.conversations.set([]);
      this.activeId.set(null);
      return;
    }
    try {
      const raw = localStorage.getItem(keys.list);
      const items = raw ? (JSON.parse(raw) as Conversation[]) : [];
      this.conversations.set(Array.isArray(items) ? items : []);
      const active = localStorage.getItem(keys.active);
      this.activeId.set(
        items.some((item) => item.id === active) ? active : (items[0]?.id ?? null),
      );
    } catch {
      this.conversations.set([]);
      this.activeId.set(null);
    }
  }

  private persist(): void {
    const keys = this.keys();
    if (!keys) {
      return;
    }
    localStorage.setItem(keys.list, JSON.stringify(this.conversations()));
    const active = this.activeId();
    if (active) {
      localStorage.setItem(keys.active, active);
    } else {
      localStorage.removeItem(keys.active);
    }
  }

  private keys(): { list: string; active: string } | null {
    const email = this.auth.email().trim().toLowerCase();
    const tenant = this.tenants.slug().trim().toLowerCase();
    if (!email || !tenant) {
      return null;
    }
    const scope = `${email}:${tenant}`;
    return {
      list: `${STORAGE_PREFIX}:${scope}`,
      active: `${ACTIVE_PREFIX}:${scope}`,
    };
  }
}
