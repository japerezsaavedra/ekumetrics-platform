import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret, encryptSecret } from '../ai/secret-cipher';
import {
  renderAlertmanagerConfig,
  type ChannelConfig,
  type ChannelType,
} from './alertmanager-config';

const TYPES: ChannelType[] = ['email', 'slack', 'webhook'];
const SEVERITIES = ['critical', 'warning', 'info'] as const;
const MAX_CHANNELS = 20;

type ChannelBody = {
  name?: string;
  type?: string;
  enabled?: boolean;
  severities?: string[];
  to?: string;
  from?: string;
  smarthost?: string;
  username?: string;
  password?: string;
  requireTls?: boolean;
  webhookUrl?: string;
  channel?: string;
  url?: string;
  token?: string;
};

@Injectable()
export class AlertChannelsService implements OnModuleInit {
  private readonly logger = new Logger(AlertChannelsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.syncAlertmanager();
    } catch (error) {
      this.logger.warn(
        `No se pudo sincronizar Alertmanager al arrancar (${error instanceof Error ? error.message : 'error'}).`,
      );
    }
  }

  async list(tenantSlug: string) {
    const tenant = await this.requireTenant(tenantSlug);
    const items = await this.prisma.alertChannel.findMany({
      where: { tenantId: tenant.id },
      orderBy: { name: 'asc' },
    });
    return {
      tenant: tenant.slug,
      channels: items.map((item) => this.present(item, tenant.slug)),
    };
  }

  async create(tenantSlug: string, body: ChannelBody) {
    const tenant = await this.requireTenant(tenantSlug);
    const count = await this.prisma.alertChannel.count({
      where: { tenantId: tenant.id },
    });
    if (count >= MAX_CHANNELS) {
      throw new BadRequestException(
        `El tenant admite como máximo ${MAX_CHANNELS} canales.`,
      );
    }
    const name = this.name(body.name);
    const type = this.type(body.type);
    const exists = await this.prisma.alertChannel.findUnique({
      where: { tenantId_name: { tenantId: tenant.id, name } },
    });
    if (exists) {
      throw new ConflictException(`Ya existe el canal ${name}.`);
    }
    const created = await this.prisma.alertChannel.create({
      data: {
        tenantId: tenant.id,
        name,
        type,
        enabled: body.enabled !== false,
        severities: this.severities(body.severities),
        configEnc: this.encrypt(this.configFrom(type, body, {})),
      },
    });
    await this.syncAlertmanager();
    return this.present(created, tenant.slug);
  }

  async update(tenantSlug: string, id: string, body: ChannelBody) {
    const tenant = await this.requireTenant(tenantSlug);
    const current = await this.prisma.alertChannel.findFirst({
      where: { id, tenantId: tenant.id },
    });
    if (!current) throw new NotFoundException('El canal no existe.');
    const name = body.name ? this.name(body.name) : current.name;
    if (name !== current.name) {
      const exists = await this.prisma.alertChannel.findUnique({
        where: { tenantId_name: { tenantId: tenant.id, name } },
      });
      if (exists) throw new ConflictException(`Ya existe el canal ${name}.`);
    }
    const type = body.type
      ? this.type(body.type)
      : (current.type as ChannelType);
    const previous = this.decrypt(current.configEnc);
    const updated = await this.prisma.alertChannel.update({
      where: { id: current.id },
      data: {
        name,
        type,
        enabled: body.enabled ?? current.enabled,
        severities: body.severities
          ? this.severities(body.severities)
          : current.severities,
        configEnc: this.encrypt(this.configFrom(type, body, previous)),
      },
    });
    await this.syncAlertmanager();
    return this.present(updated, tenant.slug);
  }

  async remove(tenantSlug: string, id: string) {
    const tenant = await this.requireTenant(tenantSlug);
    const current = await this.prisma.alertChannel.findFirst({
      where: { id, tenantId: tenant.id },
    });
    if (!current) throw new NotFoundException('El canal no existe.');
    await this.prisma.alertChannel.delete({ where: { id: current.id } });
    await this.syncAlertmanager();
    return { id: current.id };
  }

  async syncAlertmanager(): Promise<void> {
    const rows = await this.prisma.alertChannel.findMany({
      include: { tenant: { select: { slug: true } } },
    });
    const yaml = renderAlertmanagerConfig(
      rows.map((row) => ({
        id: row.id,
        tenantSlug: row.tenant.slug,
        type: row.type as ChannelType,
        enabled: row.enabled,
        severities: row.severities,
        config: this.decrypt(row.configEnc),
      })),
    );
    const path = this.configPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, yaml, 'utf8');
    await this.reload();
  }

  private async reload(): Promise<void> {
    const base = (
      this.config.get<string>('ALERTMANAGER_URL') ?? 'http://127.0.0.1:9093'
    ).replace(/\/$/, '');
    const response = await fetch(`${base}/-/reload`, { method: 'POST' }).catch(
      (error: unknown) => {
        throw new BadGatewayException(
          `No se pudo recargar Alertmanager (${error instanceof Error ? error.message : 'error'}).`,
        );
      },
    );
    if (!response.ok) {
      throw new BadGatewayException(
        `Alertmanager rechazó la recarga (HTTP ${response.status}).`,
      );
    }
  }

  private present(
    row: {
      id: string;
      name: string;
      type: string;
      enabled: boolean;
      severities: string[];
      configEnc: string;
    },
    tenant: string,
  ) {
    const config = this.decrypt(row.configEnc);
    return {
      id: row.id,
      tenant,
      name: row.name,
      type: row.type,
      enabled: row.enabled,
      severities: row.severities,
      to: config.to ?? '',
      from: config.from ?? '',
      smarthost: config.smarthost ?? '',
      username: config.username ?? '',
      hasPassword: Boolean(config.password),
      slackChannel: config.channel ?? '',
      hasWebhookUrl: Boolean(config.webhookUrl),
      url: config.url ?? '',
      hasToken: Boolean(config.token),
    };
  }

  private configFrom(
    type: ChannelType,
    body: ChannelBody,
    previous: ChannelConfig,
  ): ChannelConfig {
    if (type === 'email') {
      const to = String(body.to ?? previous.to ?? '').trim();
      const smarthost = String(
        body.smarthost ?? previous.smarthost ?? '',
      ).trim();
      if (!to.includes('@') || !smarthost) {
        throw new BadRequestException(
          'El canal de correo exige destinatario y servidor SMTP (host:puerto).',
        );
      }
      return {
        to,
        from: String(body.from ?? previous.from ?? '').trim(),
        smarthost,
        username: String(body.username ?? previous.username ?? '').trim(),
        password: String(body.password ?? '').trim() || previous.password,
        requireTls: body.requireTls ?? previous.requireTls ?? true,
      };
    }
    if (type === 'slack') {
      const webhookUrl =
        String(body.webhookUrl ?? '').trim() || previous.webhookUrl || '';
      this.assertHttps(webhookUrl, 'La URL de Slack');
      return {
        webhookUrl,
        channel: String(body.channel ?? previous.channel ?? '').trim(),
      };
    }
    const url = String(body.url ?? previous.url ?? '').trim();
    this.assertHttpUrl(url, 'La URL del webhook');
    return {
      url,
      token: String(body.token ?? '').trim() || previous.token,
    };
  }

  private name(value?: string): string {
    const name = (value ?? '').trim();
    if (!/^[a-zA-Z0-9._-]{2,64}$/.test(name)) {
      throw new BadRequestException(
        'El nombre del canal admite 2 a 64 caracteres: letras, números, punto, guion o _.',
      );
    }
    return name;
  }

  private type(value?: string): ChannelType {
    if (!TYPES.includes(value as ChannelType)) {
      throw new BadRequestException(
        'El tipo de canal debe ser email, slack o webhook.',
      );
    }
    return value as ChannelType;
  }

  private severities(value?: string[]): string[] {
    const unique = [
      ...new Set((value ?? []).map((item) => String(item).trim())),
    ].filter((item) => (SEVERITIES as readonly string[]).includes(item));
    if (!unique.length) {
      throw new BadRequestException(
        'Seleccione al menos una severidad: critical, warning o info.',
      );
    }
    return unique;
  }

  private assertHttps(value: string, label: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException(`${label} no es válida.`);
    }
    if (url.protocol !== 'https:') {
      throw new BadRequestException(`${label} debe usar HTTPS.`);
    }
  }

  private assertHttpUrl(value: string, label: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException(`${label} no es válida.`);
    }
    const loopback =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol === 'http:' && loopback) return;
    if (url.protocol !== 'https:') {
      throw new BadRequestException(`${label} debe usar HTTPS.`);
    }
  }

  private encrypt(value: ChannelConfig): string {
    return encryptSecret(JSON.stringify(value), this.encryptionKey());
  }

  private decrypt(value: string): ChannelConfig {
    try {
      return JSON.parse(
        decryptSecret(value, this.encryptionKey()),
      ) as ChannelConfig;
    } catch {
      return {};
    }
  }

  private encryptionKey(): string {
    const secret = this.config.get<string>('AI_SETTINGS_ENCRYPTION_KEY') ?? '';
    if (secret.length < 32) {
      throw new BadRequestException(
        'Falta AI_SETTINGS_ENCRYPTION_KEY para cifrar los canales.',
      );
    }
    return secret;
  }

  private async requireTenant(slug: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: slug.trim() || 'default' },
    });
    if (!tenant) throw new NotFoundException('El tenant no existe.');
    return tenant;
  }

  private configPath(): string {
    return resolve(
      this.config.get<string>('ALERTMANAGER_CONFIG_PATH') ??
        resolve(
          process.cwd(),
          '../../infrastructure/docker/alertmanager/alertmanager.yml',
        ),
    );
  }
}
