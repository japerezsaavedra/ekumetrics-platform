import { renderAlertmanagerConfig } from './alertmanager-config';

describe('renderAlertmanagerConfig', () => {
  it('enruta cada canal por tenant y severidad sin mezclar destinos', () => {
    const yaml = renderAlertmanagerConfig([
      {
        id: 'ch1',
        tenantSlug: 'acme',
        type: 'email',
        enabled: true,
        severities: ['critical'],
        config: {
          to: 'ops@acme.test',
          smarthost: 'smtp.acme.test:587',
          password: 'secret-mail',
        },
      },
      {
        id: 'ch2',
        tenantSlug: 'norte',
        type: 'webhook',
        enabled: true,
        severities: ['warning'],
        config: { url: 'https://norte.test/hook', token: 'secret-hook' },
      },
    ]);

    expect(yaml).toContain('tenant_id="acme"');
    expect(yaml).toContain('receiver: eku_ch1');
    expect(yaml).toContain('tenant_id="norte"');
    expect(yaml).toContain('receiver: eku_ch2');
    expect(yaml).toContain('secret-mail');
    expect(yaml).toContain('secret-hook');
    expect(yaml).toContain('receiver: ekumetrics-default');
  });
});
