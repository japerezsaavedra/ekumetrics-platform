import { ConflictException, ForbiddenException } from '@nestjs/common';

jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));
jest.mock('../auth/keycloak-admin', () => ({
  KeycloakAdminService: class KeycloakAdminService {},
}));

import { TenantsService } from './tenants.service';

describe('TenantsService tenant isolation', () => {
  function service() {
    const prisma = {
      tenant: {
        upsert: jest.fn().mockResolvedValue({
          id: 'default-id',
          slug: 'default',
          emailDomain: 'gradotech.com',
        }),
        update: jest.fn(),
        findUnique: jest.fn(),
      },
      site: {
        findUnique: jest.fn().mockResolvedValue({ id: 'local-id' }),
        create: jest.fn(),
        findFirst: jest.fn(),
        count: jest.fn(),
      },
      agent: {
        count: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      kioskDevice: {
        count: jest.fn(),
      },
    };
    return {
      tenants: new TenantsService(prisma as never, {} as never),
      prisma,
    };
  }

  it('impide a un administrador leer sitios de otro tenant', async () => {
    const { tenants, prisma } = service();
    await expect(
      tenants.listSites('acme', 'competidor'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it('impide a un administrador modificar agentes de otro tenant', async () => {
    const { tenants, prisma } = service();
    await expect(
      tenants.updateAgent('acme', 'competidor', 'agent-id', 'site', 'sensor'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it('impide degradar al ultimo administrador del tenant', async () => {
    const { tenants, prisma } = service();
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-id',
      tenantId: 'acme-id',
      email: 'admin@acme.test',
      displayName: 'Admin Acme',
      role: 'admin',
      tenant: { slug: 'acme' },
    });
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'acme-id',
      slug: 'acme',
      emailDomain: 'acme.test',
    });
    prisma.user.count.mockResolvedValue(0);

    await expect(
      tenants.updateUser('acme', 'admin-id', 'Admin Acme', 'viewer'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: {
        tenantId: 'acme-id',
        role: 'admin',
        id: { not: 'admin-id' },
      },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('impide a un administrador cambiar los modulos de un tenant', async () => {
    const { tenants, prisma } = service();
    await expect(
      tenants.updateTenant('acme', 'acme', 'Acme', 'acme.test', ['sap']),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('rechaza un modulo que no esta en el catalogo', async () => {
    const { tenants, prisma } = service();
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'acme-id',
      slug: 'acme',
      name: 'Acme',
      emailDomain: 'acme.test',
      modules: [],
    });
    await expect(
      tenants.updateTenant('default', 'acme', 'Acme', 'acme.test', [
        'icewarp',
        'otro',
      ]),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('permite al operator guardar los modulos del tenant', async () => {
    const { tenants, prisma } = service();
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'acme-id',
      slug: 'acme',
      name: 'Acme',
      emailDomain: 'acme.test',
      modules: [],
    });
    prisma.tenant.update.mockResolvedValue({ id: 'acme-id', modules: ['sap'] });

    await tenants.updateTenant('default', 'acme', 'Acme', 'acme.test', ['sap']);

    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'acme-id' },
        data: expect.objectContaining({ modules: ['sap'] }),
      }),
    );
  });

  it('impide eliminar un sitio con pantallas de monitoreo activas', async () => {
    const { tenants, prisma } = service();
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'acme-id',
      slug: 'acme',
      emailDomain: 'acme.test',
    });
    prisma.site.findFirst.mockResolvedValue({
      id: 'site-id',
      tenantId: 'acme-id',
      slug: 'planta',
      name: 'Planta',
    });
    prisma.site.count.mockResolvedValue(2);
    prisma.agent.count.mockResolvedValue(0);
    prisma.kioskDevice.count.mockResolvedValue(1);

    await expect(
      tenants.removeSite('acme', 'acme', 'site-id'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
