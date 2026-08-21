import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const OPERATOR_SLUG = 'default';

@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(_operatorSlug?: string) {
    await this.ensureOperator();
    return this.prisma.tenant.findMany({
      orderBy: [{ slug: 'asc' }],
      include: {
        _count: { select: { agents: true, users: true, sites: true } },
        users: { where: { role: 'admin' }, take: 3, orderBy: { createdAt: 'asc' } },
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
      throw new ConflictException('El tenant default es de Gradotech y no se puede recrear.');
    }
    if (!emailDomain) {
      throw new ConflictException('Indique el dominio corporativo (ejemplo: cliente.com).');
    }
    if (!adminEmail || !adminEmail.includes('@') || !adminName) {
      throw new ConflictException('Asigne un administrador: nombre y correo.');
    }
    this.assertCorporateEmail(adminEmail, emailDomain);
    const exists = await this.prisma.tenant.findUnique({ where: { slug } });
    if (exists) {
      throw new ConflictException(`Ya existe el tenant ${slug}.`);
    }
    return this.prisma.tenant.create({
      data: {
        name,
        slug,
        emailDomain,
        users: {
          create: {
            email: adminEmail,
            displayName: adminName,
            role: 'admin',
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
  }

  async listUsers(actorSlug?: string) {
    await this.ensureOperator();
    const actor = this.slugify(actorSlug);
    const where = actor && actor !== OPERATOR_SLUG ? { tenant: { slug: actor } } : {};
    return this.prisma.user.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }],
      include: { tenant: { select: { name: true, slug: true, emailDomain: true } } },
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
      throw new ConflictException('Nombre y correo del usuario son obligatorios.');
    }
    this.assertCorporateEmail(email, tenant.emailDomain);
    const exists = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email } },
    });
    if (exists) {
      throw new ConflictException(`Ese correo ya existe en ${tenant.slug}.`);
    }
    return this.prisma.user.create({
      data: { tenantId: tenant.id, email, displayName, role },
      include: { tenant: { select: { name: true, slug: true, emailDomain: true } } },
    });
  }

  async listSites(actorSlug?: string, tenantSlug?: string) {
    const tenant = await this.requireManagedTenant(actorSlug, tenantSlug || actorSlug);
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

  async addSite(actorSlug?: string, tenantSlug?: string, nameInput?: string, slugInput?: string) {
    const tenant = await this.requireManagedTenant(actorSlug, tenantSlug || actorSlug);
    const name = (nameInput ?? '').trim();
    const slug = this.slugify(slugInput || name);
    if (!name || !slug) {
      throw new ConflictException('Nombre y slug del sitio son obligatorios.');
    }
    const exists = await this.prisma.site.findUnique({
      where: { tenantId_slug: { tenantId: tenant.id, slug } },
    });
    if (exists) {
      throw new ConflictException(`Ya existe el sitio ${slug} en ${tenant.slug}.`);
    }
    return this.prisma.site.create({
      data: { tenantId: tenant.id, name, slug },
    });
  }

  async listAgents(slugInput?: string) {
    const tenant = await this.requireTenant(slugInput);
    return this.prisma.agent.findMany({
      where: { tenantId: tenant.id },
      orderBy: { agentId: 'asc' },
    });
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
    const exists = await this.prisma.agent.findUnique({
      where: { tenantId_agentId: { tenantId: tenant.id, agentId } },
    });
    if (exists) {
      throw new ConflictException(`El agente ${agentId} ya esta en ${tenant.slug}.`);
    }
    const agent = await this.prisma.agent.create({
      data: { tenantId: tenant.id, agentId, siteId, mode },
    });
    return {
      ...agent,
      tenantSlug: tenant.slug,
      yaml: this.yamlFor(tenant.slug, siteId, agentId, mode),
    };
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

  private async requireManagedTenant(actorSlug?: string, tenantSlug?: string) {
    await this.ensureOperator();
    const actor = this.slugify(actorSlug);
    const target = this.slugify(tenantSlug);
    if (!actor) {
      throw new ForbiddenException('Indique el tenant actor.');
    }
    if (actor !== OPERATOR_SLUG && target && target !== actor) {
      throw new ForbiddenException('Un administrador solo gestiona su propio tenant.');
    }
    return this.requireTenant(actor === OPERATOR_SLUG ? target || actor : actor);
  }

  private assertOperator(operatorSlug?: string) {
    if (this.slugify(operatorSlug) !== OPERATOR_SLUG) {
      throw new ForbiddenException('Solo Gradotech (tenant default) puede crear tenants.');
    }
  }

  private assertCorporateEmail(email: string, domain?: string | null) {
    const suffix = this.domain(domain);
    if (!suffix) {
      throw new ConflictException('El tenant no tiene dominio corporativo.');
    }
    if (!email.endsWith(`@${suffix}`)) {
      throw new ConflictException(`El correo debe usar el dominio corporativo @${suffix}.`);
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

  private yamlFor(tenantId: string, site: string, agentId: string, mode: string) {
    return [
      'agent:',
      '  environment: production',
      `  site: ${site}`,
      `  tenantId: ${tenantId}`,
      `  agentId: ${agentId}`,
      `  mode: ${mode}`,
      '',
      'servers:',
      '  this:',
      '    enabled: true',
      '',
      'snmp:',
      '  enabled: false',
      '  devices: []',
      '',
      'databases:',
      '  enabled: false',
      '  targets: []',
      '',
      'queues:',
      '  enabled: false',
      '  targets: []',
      '',
      'icewarp:',
      '  enabled: false',
      '  targets: []',
    ].join('\n');
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
    return (value ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80);
  }
}
