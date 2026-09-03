import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';

const ACCESS_TTL_SECONDS = 10 * 60;
const DEFAULT_CREDENTIAL_DAYS = 365;
type DeviceWithScope = Awaited<ReturnType<KioskService['findDevice']>>;

@Injectable()
export class KioskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async createDevice(
    actor: AuthUser,
    input: {
      tenant?: string;
      site?: string;
      name?: string;
      dashboard?: string;
      credentialDays?: number;
    },
  ) {
    this.requireManager(actor);
    const tenantSlug = this.targetTenant(actor, input.tenant);
    const siteSlug = this.required(input.site, 'Seleccione un sitio.');
    const name = this.required(
      input.name,
      'Ingrese un nombre para la pantalla.',
    );
    const dashboard = await this.resolveDashboard(tenantSlug, input.dashboard);
    const days = Math.min(
      Math.max(Number(input.credentialDays) || DEFAULT_CREDENTIAL_DAYS, 1),
      730,
    );
    const site = await this.prisma.site.findFirst({
      where: { slug: siteSlug, tenant: { slug: tenantSlug } },
      include: { tenant: true },
    });
    if (!site) {
      throw new NotFoundException('El sitio indicado no existe.');
    }
    const secret = this.newSecret();
    const device = await this.prisma.kioskDevice.create({
      data: {
        tenantId: site.tenantId,
        siteId: site.id,
        name,
        dashboard,
        secretHash: this.hash(secret),
        credentialExpiresAt: new Date(Date.now() + days * 86_400_000),
        createdBy: actor.email,
      },
    });
    await this.audit(
      site.tenantId,
      actor.email,
      'kiosk.device.enrolled',
      device.id,
      {
        site: site.slug,
        dashboard,
        credentialExpiresAt: device.credentialExpiresAt.toISOString(),
      },
    );
    return {
      ...this.present(device, site.tenant.slug, site.slug),
      secret,
    };
  }

  async listDevices(actor: AuthUser, requestedTenant?: string) {
    this.requireManager(actor);
    const tenant = this.targetTenant(actor, requestedTenant);
    const devices = await this.prisma.kioskDevice.findMany({
      where: { tenant: { slug: tenant } },
      include: { tenant: true, site: true },
      orderBy: { createdAt: 'desc' },
    });
    return devices.map((item) =>
      this.present(item, item.tenant.slug, item.site.slug),
    );
  }

  async renew(deviceIdInput?: string, secretInput?: string) {
    const deviceId = this.required(
      deviceIdInput,
      'Falta el identificador del dispositivo.',
    );
    const secret = this.required(
      secretInput,
      'Falta la credencial del dispositivo.',
    );
    const device = await this.findDevice(deviceId);
    this.assertActive(device);
    const hash = this.hash(secret);
    if (!this.equalHash(hash, device.secretHash)) {
      throw new UnauthorizedException(
        'La credencial del dispositivo no es válida.',
      );
    }
    const now = new Date();
    await this.prisma.kioskDevice.update({
      where: { id: device.id },
      data: { lastRenewedAt: now, lastSeenAt: now },
    });
    await this.audit(
      device.tenantId,
      `kiosk:${device.id}`,
      'kiosk.session.renewed',
      device.id,
      {
        site: device.site.slug,
        dashboard: device.dashboard,
      },
    );
    return {
      accessToken: await this.accessToken(device),
      expiresIn: ACCESS_TTL_SECONDS,
      deviceSecret: secret,
      scope: {
        tenant: device.tenant.slug,
        site: device.site.slug,
        dashboard: device.dashboard,
      },
    };
  }

  async verifyAccessToken(token: string): Promise<AuthUser> {
    try {
      const { payload } = await jwtVerify(token, this.signingKey(), {
        issuer: 'ekumetrics:kiosk',
        audience: 'portal-web',
        algorithms: ['HS256'],
      });
      const deviceId = String(payload.sub ?? '');
      const version = Number(payload['ver']);
      const device = await this.findDevice(deviceId);
      this.assertActive(device);
      if (device.credentialVersion !== version) {
        throw new UnauthorizedException(
          'La sesión del dispositivo fue revocada.',
        );
      }
      return {
        email: `kiosk:${device.id}`,
        name: device.name,
        role: 'kiosk',
        tenant: device.tenant.slug,
        deviceId: device.id,
        site: device.site.slug,
        dashboard: device.dashboard,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException(
        'La sesión del dispositivo no es válida.',
      );
    }
  }

  async heartbeat(user: AuthUser) {
    if (user.role !== 'kiosk' || !user.deviceId) {
      throw new ForbiddenException(
        'Este recurso requiere una identidad de dispositivo.',
      );
    }
    const device = await this.findDevice(user.deviceId);
    this.assertActive(device);
    const now = new Date();
    await this.prisma.kioskDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: now },
    });
    await this.audit(
      device.tenantId,
      `kiosk:${device.id}`,
      'kiosk.device.heartbeat',
      device.id,
      {
        site: device.site.slug,
        dashboard: device.dashboard,
      },
    );
    return { ok: true, serverTime: now.toISOString() };
  }

  async revoke(actor: AuthUser, id: string) {
    const device = await this.managedDevice(actor, id);
    const updated = await this.prisma.kioskDevice.update({
      where: { id },
      data: { revokedAt: new Date(), credentialVersion: { increment: 1 } },
    });
    await this.audit(
      device.tenantId,
      actor.email,
      'kiosk.device.revoked',
      id,
      {},
    );
    return this.present(updated, device.tenant.slug, device.site.slug);
  }

  async remove(actor: AuthUser, id: string) {
    const device = await this.managedDevice(actor, id);
    await this.prisma.kioskDevice.delete({ where: { id } });
    await this.audit(device.tenantId, actor.email, 'kiosk.device.removed', id, {});
    return { id: device.id };
  }

  async rotate(actor: AuthUser, id: string) {
    const device = await this.managedDevice(actor, id);
    if (device.revokedAt)
      throw new BadRequestException('El dispositivo está revocado.');
    const secret = this.newSecret();
    const updated = await this.prisma.kioskDevice.update({
      where: { id },
      data: {
        secretHash: this.hash(secret),
        credentialVersion: { increment: 1 },
      },
    });
    await this.audit(
      device.tenantId,
      actor.email,
      'kiosk.device.credential_rotated',
      id,
      {},
    );
    return {
      ...this.present(updated, device.tenant.slug, device.site.slug),
      secret,
    };
  }

  async updateScope(
    actor: AuthUser,
    id: string,
    input: { site?: string; dashboard?: string; name?: string },
  ) {
    const device = await this.managedDevice(actor, id);
    const siteSlug = input.site?.trim() || device.site.slug;
    const site = await this.prisma.site.findFirst({
      where: { slug: siteSlug, tenantId: device.tenantId },
    });
    if (!site) throw new NotFoundException('El sitio indicado no existe.');
    const updated = await this.prisma.kioskDevice.update({
      where: { id },
      data: {
        siteId: site.id,
        dashboard: input.dashboard
          ? await this.resolveDashboard(device.tenant.slug, input.dashboard)
          : device.dashboard,
        name: input.name?.trim() || device.name,
        credentialVersion: { increment: 1 },
      },
    });
    await this.audit(
      device.tenantId,
      actor.email,
      'kiosk.device.scope_changed',
      id,
      {
        site: site.slug,
        dashboard: updated.dashboard,
      },
    );
    return this.present(updated, device.tenant.slug, site.slug);
  }

  private async accessToken(device: NonNullable<DeviceWithScope>) {
    return new SignJWT({
      role: 'kiosk',
      tenant: device.tenant.slug,
      site: device.site.slug,
      dashboard: device.dashboard,
      ver: device.credentialVersion,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('ekumetrics:kiosk')
      .setAudience('portal-web')
      .setSubject(device.id)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
      .sign(this.signingKey());
  }

  private signingKey() {
    const secret = this.config.get<string>('KIOSK_TOKEN_SECRET')?.trim() ?? '';
    if (secret.length < 32) {
      throw new Error('KIOSK_TOKEN_SECRET debe tener al menos 32 caracteres.');
    }
    return new TextEncoder().encode(secret);
  }

  private async findDevice(id: string) {
    const device = await this.prisma.kioskDevice.findUnique({
      where: { id },
      include: { tenant: true, site: true },
    });
    if (!device) throw new UnauthorizedException('El dispositivo no existe.');
    return device;
  }

  private async managedDevice(actor: AuthUser, id: string) {
    this.requireManager(actor);
    const device = await this.findDevice(id);
    if (actor.role !== 'operator' && device.tenant.slug !== actor.tenant) {
      throw new ForbiddenException(
        'No puede administrar dispositivos de otro tenant.',
      );
    }
    return device;
  }

  private assertActive(device: NonNullable<DeviceWithScope>) {
    if (device.revokedAt)
      throw new UnauthorizedException('El dispositivo fue revocado.');
    if (device.credentialExpiresAt <= new Date()) {
      throw new UnauthorizedException('La credencial del dispositivo expiró.');
    }
  }

  private present(
    device: {
      id: string;
      name: string;
      dashboard: string;
      credentialExpiresAt: Date;
      revokedAt: Date | null;
      lastSeenAt: Date | null;
      lastRenewedAt: Date | null;
      createdAt: Date;
    },
    tenant: string,
    site: string,
  ) {
    return {
      id: device.id,
      name: device.name,
      tenant,
      site,
      dashboard: device.dashboard,
      credentialExpiresAt: device.credentialExpiresAt,
      revokedAt: device.revokedAt,
      lastSeenAt: device.lastSeenAt,
      lastRenewedAt: device.lastRenewedAt,
      createdAt: device.createdAt,
    };
  }

  private async audit(
    tenantId: string,
    actor: string,
    action: string,
    entityId: string,
    metadata: Record<string, string>,
  ) {
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        actor,
        action,
        entity: 'kiosk_device',
        entityId,
        metadata,
      },
    });
  }

  private requireManager(actor: AuthUser) {
    if (actor.role !== 'operator' && actor.role !== 'admin') {
      throw new ForbiddenException('Se requiere un rol administrador.');
    }
  }

  private targetTenant(actor: AuthUser, requested?: string) {
    const target = requested?.trim() || actor.tenant;
    if (actor.role !== 'operator' && target !== actor.tenant) {
      throw new ForbiddenException(
        'No puede administrar dispositivos de otro tenant.',
      );
    }
    return target;
  }

  private async resolveDashboard(tenantSlug: string, value?: string) {
    const dashboard = this.required(value, 'Seleccione un dashboard.');
    const key = dashboard.toLowerCase();
    if (key.startsWith('custom:')) {
      const id = dashboard.slice(dashboard.indexOf(':') + 1).trim();
      const board = await this.prisma.customDashboard.findFirst({
        where: { id, tenant: { slug: tenantSlug } },
      });
      if (!board) {
        throw new BadRequestException('El dashboard indicado no está permitido.');
      }
      return `custom:${board.id}`;
    }
    throw new BadRequestException('Seleccione un dashboard creado.');
  }

  private required(value: string | undefined, message: string) {
    const normalized = (value ?? '').trim();
    if (!normalized) throw new BadRequestException(message);
    return normalized;
  }

  private newSecret() {
    return randomBytes(32).toString('base64url');
  }

  private hash(value: string) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private equalHash(left: string, right: string) {
    const leftBuffer = Buffer.from(left, 'hex');
    const rightBuffer = Buffer.from(right, 'hex');
    return (
      leftBuffer.length === rightBuffer.length &&
      timingSafeEqual(leftBuffer, rightBuffer)
    );
  }
}
