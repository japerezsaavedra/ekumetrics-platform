import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { actingTenant, type AuthUser } from '../auth/auth.types';
import { DashboardService } from '../dashboard/dashboard.service';
import { PrismaService } from '../prisma/prisma.service';
import { sanitizeWidgets, type BoardWidget } from './board-widgets';

@Injectable()
export class BoardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dashboard: DashboardService,
  ) {}

  async list(actor: AuthUser, tenantQuery?: string) {
    const tenant = await this.tenantOf(actor, tenantQuery);
    return this.prisma.customDashboard.findMany({
      where: { tenantId: tenant.id },
      include: this.siteInclude,
      orderBy: { updatedAt: 'desc' },
    });
  }

  async create(
    actor: AuthUser,
    input: { name?: string; siteId?: string | null; tenant?: string },
  ) {
    this.requireEditor(actor);
    const tenant = await this.tenantOf(actor, input.tenant);
    const name = (input.name ?? '').trim();
    if (name.length < 2) {
      throw new BadRequestException('Ingrese un nombre para el dashboard.');
    }
    const site = await this.siteOf(tenant.id, input.siteId);
    return this.prisma.customDashboard.create({
      data: {
        tenantId: tenant.id,
        siteId: site?.id ?? null,
        name: name.slice(0, 80),
        widgets: [],
      },
      include: this.siteInclude,
    });
  }

  async get(actor: AuthUser, id: string, tenantQuery?: string) {
    return this.findBoard(actor, id, tenantQuery);
  }

  async update(
    actor: AuthUser,
    id: string,
    input: { name?: string; widgets?: unknown; siteId?: string | null },
    tenantQuery?: string,
  ) {
    this.requireEditor(actor);
    const board = await this.findBoard(actor, id, tenantQuery);
    const name = input.name?.trim();
    const site =
      input.siteId === undefined ? board.site : await this.siteOf(board.tenantId, input.siteId);
    return this.prisma.customDashboard.update({
      where: { id: board.id },
      data: {
        name: name && name.length >= 2 ? name.slice(0, 80) : board.name,
        siteId: site?.id ?? null,
        widgets: sanitizeWidgets(input.widgets ?? board.widgets),
      },
      include: this.siteInclude,
    });
  }

  async remove(actor: AuthUser, id: string, tenantQuery?: string) {
    this.requireEditor(actor);
    const board = await this.findBoard(actor, id, tenantQuery);
    await this.prisma.customDashboard.delete({ where: { id: board.id } });
    return { id: board.id };
  }

  async view(actor: AuthUser, id: string, tenantQuery?: string) {
    const board = await this.findBoard(actor, id, tenantQuery);
    if (actor.role === 'kiosk' && actor.dashboard !== `custom:${board.id}`) {
      throw new ForbiddenException('Esta pantalla no está autorizada a este dashboard.');
    }
    const tenantSlug = actingTenant(actor, tenantQuery);
    const siteSlug = board.site?.slug;
    const overview = await this.dashboard.getDashboard(
      undefined,
      '1h',
      tenantSlug,
      'hosts',
      siteSlug,
    );
    const widgets = sanitizeWidgets(board.widgets);
    const series: Record<
      string,
      { cpu: Array<[number, number]>; networkRx: Array<[number, number]>; networkTx: Array<[number, number]> }
    > = {};
    const agentIds = [
      ...new Set(widgets.map((item) => item.agentId).filter((item) => item.length > 0)),
    ];
    for (const agentId of agentIds) {
      const dash = await this.dashboard.getDashboard(
        agentId,
        '1h',
        tenantSlug,
        'hosts',
        siteSlug,
      );
      series[agentId] = this.pickSeries(dash.host?.series);
    }
    if (overview.agentId && !series[overview.agentId]) {
      series[overview.agentId] = this.pickSeries(overview.host?.series);
    }
    return {
      board: { ...board, widgets },
      hosts: overview.hosts,
      nics: overview.nics,
      series,
    };
  }

  private pickSeries(series: {
    cpu?: Array<[number, number]>;
    networkRx?: Array<[number, number]>;
    networkTx?: Array<[number, number]>;
  } | null | undefined) {
    return {
      cpu: series?.cpu ?? [],
      networkRx: series?.networkRx ?? [],
      networkTx: series?.networkTx ?? [],
    };
  }

  private async findBoard(actor: AuthUser, id: string, tenantQuery?: string) {
    const tenant = await this.tenantOf(actor, tenantQuery);
    const board = await this.prisma.customDashboard.findFirst({
      where: { id, tenantId: tenant.id },
      include: this.siteInclude,
    });
    if (!board) {
      throw new NotFoundException('El dashboard no existe.');
    }
    return {
      ...board,
      widgets: sanitizeWidgets(board.widgets) as BoardWidget[],
    };
  }

  private readonly siteInclude = {
    site: { select: { id: true, slug: true, name: true } },
  } as const;

  private async siteOf(tenantId: string, siteId?: string | null) {
    const id = (siteId ?? '').trim();
    if (!id) return null;
    const site = await this.prisma.site.findFirst({
      where: { id, tenantId },
      select: { id: true, slug: true, name: true },
    });
    if (!site) {
      throw new BadRequestException('El sitio no existe en este tenant.');
    }
    return site;
  }

  private async tenantOf(actor: AuthUser, tenantQuery?: string) {
    const slug = actingTenant(actor, tenantQuery);
    const tenant = await this.prisma.tenant.findUnique({ where: { slug } });
    if (!tenant) {
      throw new NotFoundException('El tenant no existe.');
    }
    return tenant;
  }

  private requireEditor(actor: AuthUser) {
    if (actor.role === 'viewer' || actor.role === 'kiosk') {
      throw new ForbiddenException('No puede editar dashboards.');
    }
  }
}
