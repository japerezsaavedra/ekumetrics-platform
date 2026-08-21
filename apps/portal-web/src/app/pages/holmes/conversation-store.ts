import { Injectable, computed, signal } from '@angular/core';

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

const STORAGE_KEY = 'eku-assistant-conversations';
const ACTIVE_KEY = 'eku-assistant-active';

@Injectable({ providedIn: 'root' })
export class ConversationStore {
  readonly conversations = signal<Conversation[]>([]);
  readonly activeId = signal<string | null>(null);
  readonly active = computed(() => {
    const id = this.activeId();
    return this.conversations().find((item) => item.id === id) ?? null;
  });

  constructor() {
    this.restore();
  }

  create(title = 'Nueva sesion'): Conversation {
    const conversation: Conversation = {
      id: crypto.randomUUID(),
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
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const items = raw ? (JSON.parse(raw) as Conversation[]) : [];
      this.conversations.set(Array.isArray(items) ? items : []);
      const active = localStorage.getItem(ACTIVE_KEY);
      this.activeId.set(
        items.some((item) => item.id === active) ? active : (items[0]?.id ?? null),
      );
    } catch {
      this.conversations.set([]);
      this.activeId.set(null);
    }
  }

  private persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.conversations()));
    const active = this.activeId();
    if (active) {
      localStorage.setItem(ACTIVE_KEY, active);
    } else {
      localStorage.removeItem(ACTIVE_KEY);
    }
  }
}
