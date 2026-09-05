import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { KeycloakAdminService } from '../auth/keycloak-admin';
import { PrismaService } from '../prisma/prisma.service';
import { buildAgentYaml } from './agent-yaml';
import { normalizeTenantModules } from './tenant-modules';

const OPERATOR_SLUG = 'default';

@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keycloak: KeycloakAdminService,
  ) {}

  async list(actorSlug?: string, operator = false) {
    await this.ensureOperator();
    return this.prisma.tenant.findMany({
      where: operator
        ? undefined
        : { slug: this.slugify(actorSlug) || 'default' },
      orderBy: [{ slug: 'asc' }],
      include: {
        _count: { select: { agents: true, users: true, sites: true } },
        users: {
          where: { role: 'admin' },
          take: 3,
          orderBy: { createdAt: 'asc' },
        },
        sites: { orderBy: { slug: 'asc' } },
      },
    });
  }

  async create(
    operatorSlug?: string,
    nameInput?: string,
    slugInput?: string,
    adminEmailInput?: string,
    adminNameInput?: string,
    emailDomainInput?: string,
    siteNameInput?: string,
    siteSlugInput?: string,
    modulesInput?: unknown,
  ) {
    this.assertOperator(operatorSlug);
    const name = (nameInput ?? '').trim();
    const slug = this.slugify(slugInput || name);
    const emailDomain = this.domain(emailDomainInput);
    const adminEmail = (adminEmailInput ?? '').trim().toLowerCase();
    const adminName = (adminNameInput ?? '').trim();
    const siteSlug = this.slugify(siteSlugInput) || 'local';
    const siteName = (siteNameInput ?? '').trim() || 'Sede principal';
    if (!name || !slug) {
      throw new ConflictException('Nombre y slug son obligatorios.');
    }
    if (slug === OPERATOR_SLUG) {
      throw new ConflictException(
        'El tenant default es de Gradotech y no se puede recrear.',
      );
    }
    if (!emailDomain) {
      throw new ConflictException(
        'Indique el dominio corporativo (ejemplo: cliente.com).',
      );
    }
    if (!adminEmail || !adminEmail.includes('@') || !adminName) {
      throw new ConflictException('Asigne un administrador: nombre y correo.');
    }
    this.assertCorporateEmail(adminEmail, emailDomain);
    const exists = await this.prisma.tenant.findUnique({ where: { slug } });
    if (exists) {
      throw new ConflictException(`Ya existe el tenant ${slug}.`);
    }
    const modules = normalizeTenantModules(modulesInput);
    const tenant = await this.prisma.tenant.create({
      data: {
        name,
        slug,
        emailDomain,
        modules,
        users: {
          create: {
            email: adminEmail,
            displayName: adminName,
            role: 'admin',
            mustChangePassword: false,
          },
        },
        sites: {
          create: { slug: siteSlug, name: siteName },
        },
      },
      include: {
        users: { where: { role: 'admin' } },
        sites: true,
        _count: { select: { agents: true, users: true, sites: true } },
      },
    });
    try {
      const temporaryPassword = await this.keycloak.provisionUser({
        email: adminEmail,
        displayName: adminName,
        role: 'admin',
        tenant: slug,
      });
      return { ...tenant, temporaryPassword };
    } catch (error) {
      await this.prisma.tenant.delete({ where: { id: tenant.id } });
      throw error;
    }
  }

  async listUsers(actorSlug?: string) {
    await this.ensureOperator();
    const actor = this.slugify(actorSlug);
    const where =
      actor && actor !== OPERATOR_SLUG ? { tenant: { slug: actor } } : {};
    return this.prisma.user.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }],
      include: {
        tenant: { select: { name: true, slug: true, emailDomain: true } },
      },
    });
  }

  async addUser(
    actorSlug?: string,
    tenantSlug?: string,
    emailInput?: string,
    nameInput?: string,
    roleInput?: string,
  ) {
    const tenant = await this.requireManagedTenant(actorSlug, tenantSlug);
    const email = (emailInput ?? '').trim().toLowerCase();
    const displayName = (nameInput ?? '').trim();
    const role = (roleInput ?? 'admin').trim() || 'admin';
    if (!email || !email.includes('@') || !displayName) {
      throw new ConflictException(
        'Nombre y correo del usuario son obligatorios.',
      );
    }
    this.assertUserRole(role);
    this.assertCorporateEmail(email, tenant.emailDomain);
    const exists = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email } },
    });
    if (exists) {
      throw new ConflictException(`Ese correo ya existe en ${tenant.slug}.`);
    }
    const user = await this.prisma.user.create({
      data: {
        tenantId: tenant.id,
        email,
        displayName,
        role,
        mustChangePassword: false,
      },
      include: {
        tenant: { select: { name: true, slug: true, emailDomain: true } },
      },
    });
    try {
      const temporaryPassword = await this.keycloak.provisionUser({
        email,
        displayName,
        role,
        tenant: tenant.slug,
      });
      return { ...user, temporaryPassword };
    } catch (error) {
      await this.prisma.user.delete({ where: { id: user.id } });
      throw error;
    }
  }

  async updateUser(
    actorSlug?: string,
    userId?: string,
    nameInput?: string,
    roleInput?: string,
  ) {
    const current = await this.requireUser(actorSlug, userId);
    const displayName = (nameInput ?? '').trim();
    const role = (roleInput ?? current.role).trim() || current.role;
    if (!displayName) {
      throw new ConflictException('El nombre del usuario es obligatorio.');
    }
    this.assertUserRole(role);
    await this.assertAdminContinuity(current, role);
    const user = await this.prisma.user.update({
      where: { id: current.id },
      data: { displayName, role },
      include: {
        tenant: { select: { name: true, slug: true, emailDomain: true } },
      },
    });
    await this.keycloak.updateUser(user.email, displayName, role);
    return user;
  }

  async resetUserPassword(actorSlug?: string, userId?: string) {
    const current = await this.requireUser(actorSlug, userId);
    const temporaryPassword = await this.keycloak.resetPassword(current.email);
    await this.prisma.user.update({
      where: { id: current.id },
      data: { mustChangePassword: true },
    });
    return { email: current.email, temporaryPassword };
  }

  async removeUser(actorSlug?: string, actorEmail?: string, userId?: string) {
    const current = await this.requireUser(actorSlug, userId);
    if (actorEmail && current.email === actorEmail.trim().toLowerCase()) {
      throw new ForbiddenException('No puede eliminar su propia cuenta.');
    }
    await this.assertAdminContinuity(current, 'viewer');
    await this.keycloak.deleteUser(current.email);
    await this.prisma.user.delete({ where: { id: current.id } });
    return { id: current.id };
  }

  async listSites(actorSlug?: string, tenantSlug?: string) {
    const tenant = await this.requireManagedTenant(
      actorSlug,
      tenantSlug || actorSlug,
    );
    const [sites, agents] = await Promise.all([
      this.prisma.site.findMany({
        where: { tenantId: tenant.id },
        orderBy: { slug: 'asc' },
      }),
      this.prisma.agent.findMany({
        where: { tenantId: tenant.id },
        select: { siteId: true },
      }),
    ]);
    const counts = new Map<string, number>();
    for (const agent of agents) {
      counts.set(agent.siteId, (counts.get(agent.siteId) ?? 0) + 1);
    }
    return sites.map((site) => ({
      ...site,
      tenantSlug: tenant.slug,
      agentCount: counts.get(site.slug) ?? 0,
    }));
  }

  async addSite(
    actorSlug?: string,
    tenantSlug?: string,
    nameInput?: string,
    slugInput?: string,
  ) {
    const tenant = await this.requireManagedTenant(
      actorSlug,
      tenantSlug || actorSlug,
    );
    const name = (nameInput ?? '').trim();
    const slug = this.slugify(slugInput || name);
    if (!name || !slug) {
      throw new ConflictException('Nombre y slug del sitio son obligatorios.');
    }
    const exists = await this.prisma.site.findUnique({
      where: { tenantId_slug: { tenantId: tenant.id, slug } },
    });
    if (exists) {
      throw new ConflictException(
        `Ya existe el sitio ${slug} en ${tenant.slug}.`,
      );
    }
    return this.prisma.site.create({
      data: { tenantId: tenant.id, name, slug },
    });
  }

  async updateSite(
    actorSlug?: string,
    tenantSlug?: string,
    siteId?: string,
    nameInput?: string,
    slugInput?: string,
  ) {
    const tenant = await this.requireManagedTenant(
      actorSlug,
      tenantSlug || actorSlug,
    );
    const site = await this.prisma.site.findFirst({
      where: { id: siteId, tenantId: tenant.id },
    });
    if (!site) {
      throw new NotFoundException('El sitio no existe.');
    }
    const name = (nameInput ?? '').trim() || site.name;
    const slug = this.slugify(slugInput) || site.slug;
    if (slug !== site.slug) {
      const exists = await this.prisma.site.findUnique({
        where: { tenantId_slug: { tenantId: tenant.id, slug } },
      });
      if (exists) {
        throw new ConflictException(
          `Ya existe el sitio ${slug} en ${tenant.slug}.`,
        );
      }
      await this.prisma.agent.updateMany({
        where: { tenantId: tenant.id, siteId: site.slug },
        data: { siteId: slug },
      });
      await this.prisma.kioskDevice.updateMany({
        where: { siteId: site.id, revokedAt: null },
        data: { credentialVersion: { increment: 1 } },
      });
    }
    return this.prisma.site.update({
      where: { id: site.id },
      data: { name, slug },
    });
  }

  async removeSite(actorSlug?: string, tenantSlug?: string, siteId?: string) {
    const tenant = await this.requireManagedTenant(
      actorSlug,
      tenantSlug || actorSlug,
    );
    const site = await this.prisma.site.findFirst({
      where: { id: siteId, tenantId: tenant.id },
    });
    if (!site) {
      throw new NotFoundException('El sitio no existe.');
    }
    const remaining = await this.prisma.site.count({
      where: { tenantId: tenant.id },
    });
    if (remaining <= 1) {
      throw new ConflictException(
        'El tenant debe conservar al menos un sitio.',
      );
    }
    const agents = await this.prisma.agent.count({
      where: { tenantId: tenant.id, siteId: site.slug },
    });
    if (agents) {
      throw new ConflictException('Elimine primero los agentes de este sitio.');
    }
    const screens = await this.prisma.kioskDevice.count({
      where: { siteId: site.id, revokedAt: null },
    });
    if (screens) {
      throw new ConflictException(
        'Revoque primero las pantallas de monitoreo de este sitio.',
      );
    }
    await this.prisma.site.delete({ where: { id: site.id } });
    return { id: site.id };
  }

  async listAgents(actorSlug?: string, slugInput?: string) {
    const tenant = await this.requireManagedTenant(actorSlug, slugInput);
    const agents = await this.prisma.agent.findMany({
      where: { tenantId: tenant.id },
      orderBy: { agentId: 'asc' },
    });
    return agents.map((agent) => ({
      ...agent,
      tenantSlug: tenant.slug,
      yaml: this.yamlFor(
        tenant.slug,
        agent.siteId,
        agent.agentId,
        agent.mode,
        tenant.modules,
      ),
    }));
  }

  async addAgent(
    actorSlug?: string,
    slugInput?: string,
    agentIdInput?: string,
    siteIdInput?: string,
    modeInput?: string,
  ) {
    const tenant = await this.requireManagedTenant(actorSlug, slugInput);
    const agentId = this.id(agentIdInput);
    const siteId = this.id(siteIdInput) || 'local';
    const mode = this.id(modeInput) || 'site';
    if (!agentId) {
      throw new ConflictException('agent_id es obligatorio.');
    }
    const site = await this.prisma.site.findUnique({
      where: { tenantId_slug: { tenantId: tenant.id, slug: siteId } },
    });
    if (!site) {
      throw new ConflictException(
        `El sitio ${siteId} no existe en ${tenant.slug}.`,
      );
    }
    const exists = await this.prisma.agent.findUnique({
      where: { tenantId_agentId: { tenantId: tenant.id, agentId } },
    });
    if (exists) {
      throw new ConflictException(
        `El agente ${agentId} ya esta en ${tenant.slug}.`,
      );
    }
    const agent = await this.prisma.agent.create({
      data: { tenantId: tenant.id, agentId, siteId, mode },
    });
    return {
      ...agent,
      tenantSlug: tenant.slug,
      yaml: this.yamlFor(tenant.slug, siteId, agentId, mode, tenant.modules),
    };
  }

  async updateAgent(
    actorSlug?: string,
    slugInput?: string,
    id?: string,
    siteIdInput?: string,
    modeInput?: string,
  ) {
    const tenant = await this.requireManagedTenant(actorSlug, slugInput);
    const agent = await this.prisma.agent.findFirst({
      where: { id, tenantId: tenant.id },
    });
    if (!agent) {
      throw new NotFoundException('El agente no existe.');
    }
    const siteId = this.id(siteIdInput) || agent.siteId;
    const mode = this.id(modeInput) || agent.mode;
    const site = await this.prisma.site.findUnique({
      where: { tenantId_slug: { tenantId: tenant.id, slug: siteId } },
    });
    if (!site) {
      throw new ConflictException(
        `El sitio ${siteId} no existe en ${tenant.slug}.`,
      );
    }
    const updated = await this.prisma.agent.update({
      where: { id: agent.id },
      data: { siteId, mode },
    });
    return {
      ...updated,
      tenantSlug: tenant.slug,
      yaml: this.yamlFor(
        tenant.slug,
        siteId,
        updated.agentId,
        mode,
        tenant.modules,
      ),
    };
  }

  async removeAgent(actorSlug?: string, slugInput?: string, id?: string) {
    const tenant = await this.requireManagedTenant(actorSlug, slugInput);
    const agent = await this.prisma.agent.findFirst({
      where: { id, tenantId: tenant.id },
    });
    if (!agent) {
      throw new NotFoundException('El agente no existe.');
    }
    await this.prisma.agent.delete({ where: { id: agent.id } });
    return { id: agent.id };
  }

  async updateTenant(
    operatorSlug?: string,
    slugInput?: string,
    nameInput?: string,
    emailDomainInput?: string,
    modulesInput?: unknown,
  ) {
    this.assertOperator(operatorSlug);
    const tenant = await this.requireTenant(slugInput);
    const name = (nameInput ?? '').trim() || tenant.name;
    const emailDomain = this.domain(emailDomainInput) || tenant.emailDomain;
    if (!name) {
      throw new ConflictException('El nombre del tenant es obligatorio.');
    }
    return this.prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        name,
        emailDomain,
        ...(modulesInput === undefined
          ? {}
          : { modules: normalizeTenantModules(modulesInput) }),
      },
      include: {
        users: { where: { role: 'admin' } },
        sites: true,
        _count: { select: { agents: true, users: true, sites: true } },
      },
    });
  }

  async removeTenant(operatorSlug?: string, slugInput?: string) {
    this.assertOperator(operatorSlug);
    const tenant = await this.requireTenant(slugInput);
    if (tenant.slug === OPERATOR_SLUG) {
      throw new ForbiddenException('El tenant default no se puede eliminar.');
    }
    const users = await this.prisma.user.findMany({
      where: { tenantId: tenant.id },
      select: { email: true },
    });
    for (const user of users) {
      await this.keycloak.deleteUser(user.email);
    }
    await this.prisma.tenant.delete({ where: { id: tenant.id } });
    return { id: tenant.id, slug: tenant.slug };
  }

  async requireTenant(slugInput?: string) {
    await this.ensureOperator();
    const slug = this.slugify(slugInput || OPERATOR_SLUG);
    const tenant = await this.prisma.tenant.findUnique({ where: { slug } });
    if (!tenant) {
      throw new NotFoundException(`Tenant ${slug} no existe.`);
    }
    return tenant;
  }

  private async requireUser(actorSlug?: string, userId?: string) {
    if (!userId) {
      throw new NotFoundException('El usuario no existe.');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { tenant: { select: { slug: true } } },
    });
    if (!user) {
      throw new NotFoundException('El usuario no existe.');
    }
    await this.requireManagedTenant(actorSlug, user.tenant.slug);
    return user;
  }

  private async requireManagedTenant(actorSlug?: string, tenantSlug?: string) {
    await this.ensureOperator();
    const actor = this.slugify(actorSlug);
    const target = this.slugify(tenantSlug);
    if (!actor) {
      throw new ForbiddenException('Indique el tenant actor.');
    }
    if (actor !== OPERATOR_SLUG && target && target !== actor) {
      throw new ForbiddenException(
        'Un administrador solo gestiona su propio tenant.',
      );
    }
    return this.requireTenant(
      actor === OPERATOR_SLUG ? target || actor : actor,
    );
  }

  private assertOperator(operatorSlug?: string) {
    if (this.slugify(operatorSlug) !== OPERATOR_SLUG) {
      throw new ForbiddenException(
        'Solo Gradotech (tenant default) puede crear tenants.',
      );
    }
  }

  private assertCorporateEmail(email: string, domain?: string | null) {
    const suffix = this.domain(domain);
    if (!suffix) {
      throw new ConflictException('El tenant no tiene dominio corporativo.');
    }
    if (!email.endsWith(`@${suffix}`)) {
      throw new ConflictException(
        `El correo debe usar el dominio corporativo @${suffix}.`,
      );
    }
  }

  private assertUserRole(role: string) {
    if (role !== 'admin' && role !== 'viewer') {
      throw new ConflictException('El rol debe ser admin o viewer.');
    }
  }

  private async assertAdminContinuity(
    current: { id: string; tenantId: string; role: string },
    nextRole: string,
  ) {
    if (current.role !== 'admin' || nextRole === 'admin') return;
    const remaining = await this.prisma.user.count({
      where: {
        tenantId: current.tenantId,
        role: 'admin',
        id: { not: current.id },
      },
    });
    if (remaining === 0) {
      throw new ConflictException(
        'El tenant debe conservar al menos un administrador.',
      );
    }
  }

  private domain(value?: string | null) {
    return (value ?? '')
      .trim()
      .toLowerCase()
      .replace(/^@/, '')
      .replace(/[^a-z0-9.-]/g, '')
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 80);
  }

  private async ensureOperator() {
    const tenant = await this.prisma.tenant.upsert({
      where: { slug: OPERATOR_SLUG },
      create: {
        slug: OPERATOR_SLUG,
        name: 'Gradotech',
        emailDomain: 'gradotech.com',
        sites: { create: { slug: 'local', name: 'Sede principal' } },
      },
      update: { name: 'Gradotech' },
    });
    if (!tenant.emailDomain) {
      await this.prisma.tenant.update({
        where: { id: tenant.id },
        data: { emailDomain: 'gradotech.com' },
      });
    }
    const local = await this.prisma.site.findUnique({
      where: { tenantId_slug: { tenantId: tenant.id, slug: 'local' } },
    });
    if (!local) {
      await this.prisma.site.create({
        data: { tenantId: tenant.id, slug: 'local', name: 'Sede principal' },
      });
    }
  }

  private yamlFor(
    tenantId: string,
    site: string,
    agentId: string,
    mode: string,
    modules?: unknown,
  ) {
    return buildAgentYaml({ tenantId, site, agentId, mode, modules });
  }

  private slugify(value?: string) {
    return (value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
  }

  private id(value?: string) {
    return (value ?? '')
      .trim()
      .replace(/[^A-Za-z0-9._-]/g, '')
      .slice(0, 80);
  }
}
