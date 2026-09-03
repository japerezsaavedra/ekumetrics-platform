import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthService } from '../../core/auth';
import { TenantService } from '../../core/tenant';
import { ConversationStore } from './conversation-store';

describe('ConversationStore server-side', () => {
  let http: HttpTestingController;
  let store: ConversationStore;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: AuthService,
          useValue: { email: signal('user@example.com') },
        },
        {
          provide: TenantService,
          useValue: { slug: signal('tenant-a') },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('elimina el historial heredado y conserva solo el identificador opaco activo', async () => {
    const legacyKey = 'eku-assistant-conversations:user@example.com:tenant-a';
    localStorage.setItem(legacyKey, JSON.stringify([{ messages: ['secret'] }]));
    store = TestBed.inject(ConversationStore);
    TestBed.flushEffects();
    http.expectOne('http://localhost:3000/v1/ai/conversations').flush([]);
    await Promise.resolve();

    expect(localStorage.getItem(legacyKey)).toBeNull();
    const creating = store.create('CPU alta');
    http.expectOne('http://localhost:3000/v1/ai/conversations').flush({
      id: 'opaque-session-123',
      title: 'CPU alta',
      questionCount: 0,
      updatedAt: '2026-08-26T20:00:00.000Z',
      messages: [],
    });
    await creating;

    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem('eku-assistant-active:user@example.com:tenant-a')).toBe(
      'opaque-session-123',
    );
  });

  it('solicita el borrado al servidor y no elimina otra sesion localmente', async () => {
    store = TestBed.inject(ConversationStore);
    TestBed.flushEffects();
    http.expectOne('http://localhost:3000/v1/ai/conversations').flush([]);
    await Promise.resolve();
    const creating = store.create('Sesion');
    http.expectOne('http://localhost:3000/v1/ai/conversations').flush({
      id: 'opaque-session-456',
      title: 'Sesion',
      questionCount: 0,
      updatedAt: '2026-08-26T20:00:00.000Z',
      messages: [],
    });
    await creating;

    const removing = store.remove('opaque-session-456');
    http
      .expectOne('http://localhost:3000/v1/ai/conversations/opaque-session-456')
      .flush({ id: 'opaque-session-456', deleted: true });
    await removing;

    expect(store.conversations()).toEqual([]);
    expect(store.activeId()).toBeNull();
  });
});
