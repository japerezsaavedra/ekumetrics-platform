import { BadRequestException } from '@nestjs/common';

jest.mock('@nestjs/config', () => ({
  ConfigService: class ConfigService {},
}));

import { AlertmanagerService } from './alertmanager.service';

describe('AlertmanagerService', () => {
  const originalFetch = global.fetch;
  const config = {
    get: jest.fn().mockReturnValue('http://alertmanager:9093/'),
  };

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('normaliza alertas y silencios sin exponer la URL interna', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            {
              fingerprint: 'alert-1',
              labels: { alertname: 'DiskFull', severity: 'critical' },
              annotations: { summary: 'Disco crítico' },
              status: { state: 'active', silencedBy: [] },
            },
          ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });

    const result = await new AlertmanagerService(config as never).overview(
      'acme',
      true,
    );

    expect(result.tenant).toBe('acme');
    expect(result.alerts[0]).toMatchObject({
      fingerprint: 'alert-1',
      name: 'DiskFull',
      severity: 'critical',
    });
    expect(JSON.stringify(result)).not.toContain('http://alertmanager:9093');
  });

  it('oculta alertas de otro tenant y deja las de plataforma solo al operador', async () => {
    global.fetch = jest.fn().mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            String(url).includes('/alerts')
              ? [
                  {
                    fingerprint: 'acme',
                    labels: { alertname: 'DiskFull', tenant_id: 'acme' },
                  },
                  {
                    fingerprint: 'other',
                    labels: { alertname: 'DiskFull', tenant_id: 'otro' },
                  },
                  {
                    fingerprint: 'platform',
                    labels: { alertname: 'ApiDown' },
                  },
                ]
              : [],
          ),
      }),
    );

    const admin = await new AlertmanagerService(config as never).overview(
      'acme',
      false,
    );
    expect(admin.alerts.map((alert) => alert.fingerprint)).toEqual(['acme']);

    const operator = await new AlertmanagerService(config as never).overview(
      'acme',
      true,
    );
    expect(operator.alerts.map((alert) => alert.fingerprint)).toEqual([
      'acme',
      'platform',
    ]);
  });

  it('crea silencios exactos, acotados y atribuidos al operador', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ silenceID: '12345678-abcd' }),
    });
    const service = new AlertmanagerService(config as never);

    await expect(
      service.createSilence('operator@gradotech.com', 'acme', {
        durationMinutes: 60,
        comment: 'Mantenimiento aprobado EKM-40',
        matchers: [
          { name: 'alertname', value: 'DiskFull' },
          { name: 'instance', value: 'host-01' },
        ],
      }),
    ).resolves.toMatchObject({ id: '12345678-abcd' });

    const request = jest.mocked(global.fetch).mock.calls[0];
    const body = request[1]?.body;
    expect(typeof body).toBe('string');
    if (typeof body !== 'string') throw new Error('Falta el body JSON.');
    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(request[0]).toBe('http://alertmanager:9093/api/v2/silences');
    expect(payload).toMatchObject({
      createdBy: 'operator@gradotech.com',
      comment: 'Mantenimiento aprobado EKM-40',
    });
    expect(payload.matchers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'tenant_id', value: 'acme' }),
      ]),
    );
  });

  it('rechaza silencios amplios o sin motivo', async () => {
    const service = new AlertmanagerService(config as never);
    await expect(
      service.createSilence('operator@gradotech.com', 'acme', {
        durationMinutes: 60,
        comment: 'ok',
        matchers: [{ name: 'severity', value: 'warning' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createSilence('operator@gradotech.com', 'acme', {
        durationMinutes: 60,
        comment: 'Mantenimiento general',
        matchers: [{ name: 'alertname', value: '.*', isRegex: true }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createSilence('operator@gradotech.com', 'acme', {
        durationMinutes: 60,
        comment: 'Mantenimiento general',
        matchers: [{ name: 'alertname', value: 'DiskFull', isEqual: false }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
