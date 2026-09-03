jest.mock('../src/auth/auth.service', () => ({
  AuthService: class AuthService {},
}));
jest.mock('../src/dashboard/dashboard.service', () => ({
  DashboardService: class DashboardService {},
}));
jest.mock('../src/kiosk/kiosk.service', () => ({
  KioskService: class KioskService {},
}));
jest.mock('../src/tenants/tenants.service', () => ({
  TenantsService: class TenantsService {},
}));

import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuthGuard } from '../src/auth/auth.guard';
import { AuthService } from '../src/auth/auth.service';
import type { AuthUser } from '../src/auth/auth.types';
import { DashboardController } from '../src/dashboard/dashboard.controller';
import { DashboardService } from '../src/dashboard/dashboard.service';
import { KioskController } from '../src/kiosk/kiosk.controller';
import { KioskService } from '../src/kiosk/kiosk.service';
import { AdminController } from '../src/tenants/admin.controller';
import { TenantsController } from '../src/tenants/tenants.controller';
import { TenantsService } from '../src/tenants/tenants.service';

const identities: Record<string, AuthUser> = {
  operator: {
    email: 'ops@gradotech.cl',
    name: 'Platform operator',
    tenant: 'default',
    role: 'operator',
  },
  admin: {
    email: 'admin@acme.example',
    name: 'Acme admin',
    tenant: 'acme',
    role: 'admin',
  },
  viewer: {
    email: 'viewer@acme.example',
    name: 'Acme viewer',
    tenant: 'acme',
    role: 'viewer',
  },
  kiosk: {
    email: 'kiosk:device-1',
    name: 'Operations wallboard',
    tenant: 'acme',
    role: 'kiosk',
    deviceId: 'device-1',
    site: 'north',
    dashboard: 'network',
  },
};

describe('Critical authorization journeys (e2e)', () => {
  let app: INestApplication<App>;

  const auth = {
    authenticate: jest.fn(
      (request: { headers: { authorization?: string } }) => {
        const token =
          request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
        const identity = identities[token];
        if (!identity) {
          return Promise.reject(new UnauthorizedException('Inicie sesion.'));
        }
        return Promise.resolve({ user: identity, csrfToken: '' });
      },
    ),
  };

  const tenants = {
    list: jest.fn(),
    create: jest.fn(),
    updateTenant: jest.fn(),
    removeTenant: jest.fn(),
    listSites: jest.fn(),
    addSite: jest.fn(),
    updateSite: jest.fn(),
    removeSite: jest.fn(),
    listAgents: jest.fn(),
    addAgent: jest.fn(),
    updateAgent: jest.fn(),
    removeAgent: jest.fn(),
    listUsers: jest.fn(),
    addUser: jest.fn(),
    updateUser: jest.fn(),
    removeUser: jest.fn(),
  };

  const dashboardPayload = {
    hosts: [{ id: 'host-1' }],
    nics: [{ id: 'nic-1' }],
    networkDevices: [{ id: 'switch-1' }],
    databases: [{ id: 'db-1' }],
    queues: [{ id: 'queue-1' }],
    icewarp: [{ id: 'mail-1' }],
    sap: [{ id: 'sap-1' }],
    agents: [{ id: 'agent-1' }],
    agentId: 'agent-1',
    host: { id: 'host-1', series: {} },
    agent: { id: 'agent-1' },
    logs: { volume: [1], volumeAll: [1], lines: ['secret'] },
  };

  const dashboard = {
    getDashboard: jest.fn().mockResolvedValue(dashboardPayload),
  };

  const kiosk = {
    renew: jest.fn().mockResolvedValue({ accessToken: 'kiosk-access-token' }),
    heartbeat: jest.fn().mockResolvedValue({ status: 'ok' }),
    listDevices: jest.fn(),
    createDevice: jest.fn(),
    updateScope: jest.fn(),
    rotate: jest.fn(),
    revoke: jest.fn(),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [
        TenantsController,
        AdminController,
        DashboardController,
        KioskController,
      ],
      providers: [
        AuthGuard,
        { provide: APP_GUARD, useExisting: AuthGuard },
        { provide: AuthService, useValue: auth },
        { provide: TenantsService, useValue: tenants },
        { provide: DashboardService, useValue: dashboard },
        { provide: KioskService, useValue: kiosk },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects protected routes when no session is present', async () => {
    await request(app.getHttpServer()).get('/v1/tenants').expect(401);
    expect(tenants.list).not.toHaveBeenCalled();
  });

  it('keeps a viewer inside its tenant even when another tenant is requested', async () => {
    tenants.list.mockResolvedValue([{ slug: 'acme' }]);

    await request(app.getHttpServer())
      .get('/v1/tenants?as=globex')
      .set('Authorization', 'Bearer viewer')
      .set('X-Eku-Tenant', 'globex')
      .expect(200)
      .expect([{ slug: 'acme' }]);

    expect(tenants.list).toHaveBeenCalledWith('acme', false);
  });

  it('allows an operator to act explicitly on a managed tenant', async () => {
    tenants.list.mockResolvedValue([{ slug: 'globex' }]);

    await request(app.getHttpServer())
      .get('/v1/tenants?as=globex')
      .set('Authorization', 'Bearer operator')
      .expect(200);

    expect(tenants.list).toHaveBeenCalledWith('globex', true);
  });

  it('enforces RBAC on tenant and user administration', async () => {
    await request(app.getHttpServer())
      .post('/v1/tenants')
      .set('Authorization', 'Bearer admin')
      .send({ name: 'Globex', slug: 'globex' })
      .expect(403);

    await request(app.getHttpServer())
      .get('/v1/admin/users')
      .set('Authorization', 'Bearer viewer')
      .expect(403);

    expect(tenants.create).not.toHaveBeenCalled();
    expect(tenants.listUsers).not.toHaveBeenCalled();
  });

  it('allows an admin to manage only users from its own tenant', async () => {
    tenants.listUsers.mockResolvedValue([{ email: 'viewer@acme.example' }]);

    await request(app.getHttpServer())
      .get('/v1/admin/users?as=globex')
      .set('Authorization', 'Bearer admin')
      .expect(200);

    expect(tenants.listUsers).toHaveBeenCalledWith('acme');
  });

  it('enrolls an agent only inside the administrator tenant', async () => {
    tenants.addAgent.mockResolvedValue({
      id: 'agent-record-1',
      tenantSlug: 'acme',
      agentId: 'agent-01',
      siteId: 'north',
      mode: 'site',
      yaml: 'agent:\n  tenantId: acme\n  site: north\n  agentId: agent-01\n',
    });

    const response = await request(app.getHttpServer())
      .post('/v1/tenants/acme/agents?as=globex')
      .set('Authorization', 'Bearer admin')
      .send({ agentId: 'agent-01', siteId: 'north', mode: 'site' })
      .expect(201);

    expect(tenants.addAgent).toHaveBeenCalledWith(
      'acme',
      'acme',
      'agent-01',
      'north',
      'site',
    );
    expect(response.body as unknown).toMatchObject({
      tenantSlug: 'acme',
      agentId: 'agent-01',
      siteId: 'north',
    });
  });

  it('creates a kiosk session through the public credential exchange', async () => {
    await request(app.getHttpServer())
      .post('/v1/kiosk/session')
      .send({ deviceId: 'device-1', deviceSecret: 'device-secret' })
      .expect(201)
      .expect({ accessToken: 'kiosk-access-token' });

    expect(kiosk.renew).toHaveBeenCalledWith('device-1', 'device-secret');
  });

  it('limits a kiosk identity to its assigned tenant, site and dashboard', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/dashboard?tenant_id=globex&view=sap')
      .set('Authorization', 'Bearer kiosk')
      .expect(200);
    const body = response.body as unknown as {
      nics: unknown[];
      networkDevices: unknown[];
      hosts: unknown[];
      databases: unknown[];
      agents: unknown[];
      logs: { lines: unknown[] };
    };

    expect(dashboard.getDashboard).toHaveBeenCalledWith(
      undefined,
      undefined,
      'acme',
      'network',
      'north',
    );
    expect(body.nics).toEqual([{ id: 'nic-1' }]);
    expect(body.networkDevices).toEqual([{ id: 'switch-1' }]);
    expect(body.hosts).toEqual([]);
    expect(body.databases).toEqual([]);
    expect(body.agents).toEqual([]);
    expect(body.logs.lines).toEqual([]);
  });

  it('prevents a kiosk identity from using normal portal APIs', async () => {
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set('Authorization', 'Bearer kiosk')
      .expect(403);

    await request(app.getHttpServer())
      .get('/v1/kiosk/devices')
      .set('Authorization', 'Bearer kiosk')
      .expect(403);
  });
});
