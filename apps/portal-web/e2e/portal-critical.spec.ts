import { expect, test, type Page } from '@playwright/test';

const dashboard = {
  hosts: [
    {
      id: 'EKM-MON-01',
      siteId: 'north',
      tenantId: 'acme',
      mode: 'site',
      version: '1.0.0',
      online: true,
      cpuUsed: 0.24,
      memoryUsed: 0.48,
      uptimeSeconds: 86400,
      cpus: 8,
    },
  ],
  nics: [],
  databases: [],
  networkDevices: [],
  queues: [],
  icewarp: [],
  sap: [],
  agents: [{ agentId: 'EKM-MON-01', tenantId: 'acme', siteId: 'north' }],
  agentId: 'EKM-MON-01',
  refreshedAt: Date.now(),
  host: {
    id: 'EKM-MON-01',
    siteId: 'north',
    tenantId: 'acme',
    cpus: 8,
    cpuUsed: 0.24,
    memoryUsed: 0.48,
    memoryUsedBytes: 8_000_000_000,
    memoryTotalBytes: 16_000_000_000,
    diskUsed: 0.4,
    diskUsedBytes: 40_000_000_000,
    diskTotalBytes: 100_000_000_000,
    disks: [],
    processes: [],
    load1m: 0.2,
    load5m: 0.18,
    load15m: 0.15,
    uptimeSeconds: 86400,
    series: {
      cpu: [],
      cpuByState: [],
      load1: [],
      load5: [],
      load15: [],
      memoryByState: [],
      networkRx: [],
      networkTx: [],
      diskIo: [],
      diskOps: [],
      networkPackets: [],
      networkFaults: [],
      networkConn: [],
    },
  },
  agent: {
    online: true,
    lastSampleSeconds: 5,
    uptimeSeconds: 86400,
    licenseValid: true,
    licenseRemainingSeconds: 2_592_000,
    version: '1.0.0',
    identity: {},
    modules: [],
    assetsKnown: 1,
    assetsSuggested: 0,
  },
  logs: { volume: [], volumeAll: [], lines: [] },
};

async function mockPlatform(page: Page, authenticated = false): Promise<void> {
  const knowledge: Array<Record<string, unknown>> = [];
  await page.route('http://127.0.0.1:3000/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = {
      'access-control-allow-origin': 'http://127.0.0.1:4210',
      'access-control-allow-credentials': 'true',
      'content-type': 'application/json',
    };

    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    if (url.pathname === '/v1/auth/session') {
      await route.fulfill({
        status: authenticated ? 200 : 401,
        headers,
        body: authenticated
          ? JSON.stringify({
              user: {
                email: 'operator@acme.example',
                name: 'E2E Operator',
                tenant: 'acme',
                role: 'operator',
              },
              csrfToken: 'e2e-csrf-token',
              mfaEnrollmentRequired: false,
            })
          : JSON.stringify({ message: 'Inicie sesión.' }),
      });
      return;
    }
    if (url.pathname === '/v1/auth/login-options') {
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({
          mfaRequired: false,
          totpEnrolled: false,
          entraEnabled: false,
          adEnabled: false,
          idpHint: '',
        }),
      });
      return;
    }
    if (url.pathname === '/v1/auth/login') {
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({
          user: {
            email: 'operator@acme.example',
            name: 'E2E Operator',
            tenant: 'acme',
            role: 'operator',
          },
          csrfToken: 'e2e-csrf-token',
          redirect: '/hosts',
        }),
      });
      return;
    }
    if (url.pathname === '/v1/tenants') {
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify([{ id: 'tenant-acme', slug: 'acme', name: 'Acme' }]),
      });
      return;
    }
    if (url.pathname === '/v1/dashboard') {
      await route.fulfill({ status: 200, headers, body: JSON.stringify(dashboard) });
      return;
    }
    if (url.pathname === '/v1/ai/settings' && request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({
          service: 'ollama',
          model: 'qwen3.5:4b',
          baseUrl: '',
          hasApiKey: false,
          services: [
            {
              id: 'ollama',
              label: 'Ollama local',
              models: ['qwen3.5:4b'],
              defaultModel: 'qwen3.5:4b',
              configured: true,
              needsKey: false,
              needsBaseUrl: false,
              hint: 'Modelo local.',
            },
          ],
          active: {
            label: 'Ollama local',
            model: 'qwen3.5:4b',
            configured: true,
            online: true,
            detail: 'Modelo disponible',
          },
        }),
      });
      return;
    }
    if (url.pathname === '/v1/ai/knowledge/documents') {
      if (request.method() === 'POST') {
        const body = request.postDataJSON() as Record<string, string>;
        knowledge.unshift({
          id: 'knowledge-1',
          ...body,
          checksum: 'a'.repeat(64),
          approvedBy: 'operator@acme.example',
          approvedAt: '2026-08-27T00:00:00.000Z',
          validFrom: '2026-08-27T00:00:00.000Z',
          updatedAt: '2026-08-27T00:00:00.000Z',
          chunkCount: 1,
          status: 'active',
        });
        await route.fulfill({ status: 201, headers, body: JSON.stringify(knowledge[0]) });
      } else {
        await route.fulfill({ status: 200, headers, body: JSON.stringify(knowledge) });
      }
      return;
    }
    await route.fulfill({ status: 404, headers, body: '{}' });
  });
}

test('redirects an unauthenticated user to login and preserves the destination', async ({
  page,
}) => {
  await mockPlatform(page);
  await page.goto('/administracion/usuarios');

  await expect(page).toHaveURL(/\/login\?redirect=%2Fadministracion%2Fusuarios$/);
  await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();
});

test('signs in from the portal form without leaving the application', async ({ page }) => {
  await mockPlatform(page);
  await page.goto('/login?redirect=/hosts');

  await page.getByLabel('Correo').fill('operator@acme.example');
  await page.getByLabel('Contraseña').fill('ekumetrics-local');
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();

  await expect(page).toHaveURL(/\/hosts$/);
  await expect(page.getByRole('heading', { name: 'Hosts' })).toBeVisible();
});

test('restores the monitoring session after login and a full page reload', async ({ page }) => {
  await mockPlatform(page, true);
  await page.goto('/hosts');

  await expect(page.getByRole('heading', { name: 'Hosts' })).toBeVisible();
  await expect(page.getByText('EKM-MON-01')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cerrar sesion' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);

  await page.reload();

  await expect(page).toHaveURL(/\/hosts$/);
  await expect(page.getByRole('heading', { name: 'Hosts' })).toBeVisible();
  await expect(page.getByText('EKM-MON-01')).toBeVisible();
});

test('an operator approves and sees a runbook in the tenant corpus', async ({ page }) => {
  await mockPlatform(page, true);
  await page.goto('/administracion/ia');

  await expect(page.getByRole('heading', { name: 'Conocimiento aprobado' })).toBeVisible();
  await page.getByLabel('Clave de fuente').fill('runbooks/postgresql');
  await page.getByLabel('Título').fill('Diagnóstico PostgreSQL');
  await page.getByLabel('Contenido Markdown').fill('# Capacidad\nRevise disco y conexiones.');
  await page.getByRole('button', { name: 'Aprobar e indexar' }).click();

  await expect(page.getByText('Documento aprobado e indexado correctamente.')).toBeVisible();
  await expect(page.getByText('Diagnóstico PostgreSQL')).toBeVisible();
  await expect(page.getByText('Vigente', { exact: true })).toBeVisible();
});
