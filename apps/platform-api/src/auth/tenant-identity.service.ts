import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decryptSecret, encryptSecret } from '../ai/secret-cipher';
import { PrismaService } from '../prisma/prisma.service';
import { entraAlias, KeycloakAdminService } from './keycloak-admin';

export type IdentityBody = {
  mfaRequired?: boolean;
  entraEnabled?: boolean;
  entraTenantId?: string;
  entraClientId?: string;
  entraClientSecret?: string;
  adEnabled?: boolean;
  adConnectionUrl?: string;
  adBindDn?: string;
  adBindPassword?: string;
  adUsersDn?: string;
};

@Injectable()
export class TenantIdentityService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly keycloak: KeycloakAdminService,
  ) {}

  async get(tenantSlug: string) {
    const tenant = await this.requireTenant(tenantSlug);
    const row = await this.prisma.tenantIdentity.findUnique({
      where: { tenantId: tenant.id },
    });
    return this.present(tenant.slug, tenant.emailDomain, row);
  }

  async save(tenantSlug: string, body: IdentityBody) {
    const tenant = await this.requireTenant(tenantSlug);
    const current = await this.prisma.tenantIdentity.findUnique({
      where: { tenantId: tenant.id },
    });
    const previous = {
      entraSecret: current?.entraClientSecret
        ? this.decrypt(current.entraClientSecret)
        : '',
      adPassword: current?.adBindPassword
        ? this.decrypt(current.adBindPassword)
        : '',
    };
    const next = {
      mfaRequired: body.mfaRequired === true,
      entraEnabled: body.entraEnabled === true,
      entraTenantId: String(body.entraTenantId ?? current?.entraTenantId ?? '').trim(),
      entraClientId: String(body.entraClientId ?? current?.entraClientId ?? '').trim(),
      entraClientSecret:
        String(body.entraClientSecret ?? '').trim() || previous.entraSecret,
      adEnabled: body.adEnabled === true,
      adConnectionUrl: String(
        body.adConnectionUrl ?? current?.adConnectionUrl ?? '',
      ).trim(),
      adBindDn: String(body.adBindDn ?? current?.adBindDn ?? '').trim(),
      adBindPassword:
        String(body.adBindPassword ?? '').trim() || previous.adPassword,
      adUsersDn: String(body.adUsersDn ?? current?.adUsersDn ?? '').trim(),
    };
    if (next.entraEnabled) {
      if (!next.entraTenantId || !next.entraClientId || !next.entraClientSecret) {
        throw new BadRequestException(
          'Entra ID exige Tenant ID, Client ID y secreto de aplicación.',
        );
      }
    }
    if (next.adEnabled) {
      if (
        !next.adConnectionUrl ||
        !next.adBindDn ||
        !next.adBindPassword ||
        !next.adUsersDn
      ) {
        throw new BadRequestException(
          'Active Directory exige URL, usuario de enlace, contraseña y OU de usuarios.',
        );
      }
      this.assertLdapUrl(next.adConnectionUrl);
    }
    const saved = await this.prisma.tenantIdentity.upsert({
      where: { tenantId: tenant.id },
      create: {
        tenantId: tenant.id,
        ...this.persist(next),
      },
      update: this.persist(next),
    });
    await this.keycloak.applyTenantMfa(tenant.slug, next.mfaRequired);
    if (next.entraEnabled) {
      await this.keycloak.upsertEntraIdp({
        slug: tenant.slug,
        tenantId: next.entraTenantId,
        clientId: next.entraClientId,
        clientSecret: next.entraClientSecret,
        enabled: true,
      });
    } else {
      await this.keycloak.removeEntraIdp(tenant.slug);
    }
    if (next.adEnabled) {
      await this.keycloak.upsertAdFederation({
        slug: tenant.slug,
        connectionUrl: next.adConnectionUrl,
        bindDn: next.adBindDn,
        bindPassword: next.adBindPassword,
        usersDn: next.adUsersDn,
        enabled: true,
      });
    } else {
      await this.keycloak.removeAdFederation(tenant.slug);
    }
    return this.present(tenant.slug, tenant.emailDomain, saved);
  }

  async optionsForEmail(email: string) {
    const domain = email.split('@')[1]?.trim().toLowerCase();
    if (!domain) {
      return {
        mfaRequired: false,
        entraEnabled: false,
        adEnabled: false,
        idpHint: '',
      };
    }
    const tenant = await this.prisma.tenant.findFirst({
      where: { emailDomain: { equals: domain, mode: 'insensitive' } },
      include: { identity: true },
    });
    const identity = tenant?.identity;
    return {
      mfaRequired: identity?.mfaRequired === true,
      entraEnabled: identity?.entraEnabled === true,
      adEnabled: identity?.adEnabled === true,
      idpHint: identity?.entraEnabled && tenant ? entraAlias(tenant.slug) : '',
    };
  }

  private persist(next: {
    mfaRequired: boolean;
    entraEnabled: boolean;
    entraTenantId: string;
    entraClientId: string;
    entraClientSecret: string;
    adEnabled: boolean;
    adConnectionUrl: string;
    adBindDn: string;
    adBindPassword: string;
    adUsersDn: string;
  }) {
    return {
      mfaRequired: next.mfaRequired,
      entraEnabled: next.entraEnabled,
      entraTenantId: next.entraTenantId || null,
      entraClientId: next.entraClientId || null,
      entraClientSecret: next.entraClientSecret
        ? this.encrypt(next.entraClientSecret)
        : null,
      adEnabled: next.adEnabled,
      adConnectionUrl: next.adConnectionUrl || null,
      adBindDn: next.adBindDn || null,
      adBindPassword: next.adBindPassword
        ? this.encrypt(next.adBindPassword)
        : null,
      adUsersDn: next.adUsersDn || null,
    };
  }

  private present(
    slug: string,
    emailDomain: string | null,
    row: {
      mfaRequired: boolean;
      entraEnabled: boolean;
      entraTenantId: string | null;
      entraClientId: string | null;
      entraClientSecret: string | null;
      adEnabled: boolean;
      adConnectionUrl: string | null;
      adBindDn: string | null;
      adBindPassword: string | null;
      adUsersDn: string | null;
    } | null,
  ) {
    return {
      tenant: slug,
      emailDomain: emailDomain ?? '',
      mfaRequired: row?.mfaRequired === true,
      entraEnabled: row?.entraEnabled === true,
      entraTenantId: row?.entraTenantId ?? '',
      entraClientId: row?.entraClientId ?? '',
      hasEntraSecret: Boolean(row?.entraClientSecret),
      adEnabled: row?.adEnabled === true,
      adConnectionUrl: row?.adConnectionUrl ?? '',
      adBindDn: row?.adBindDn ?? '',
      hasAdBindPassword: Boolean(row?.adBindPassword),
      adUsersDn: row?.adUsersDn ?? '',
    };
  }

  private assertLdapUrl(value: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException('La URL de Active Directory no es válida.');
    }
    if (!['ldap:', 'ldaps:'].includes(url.protocol)) {
      throw new BadRequestException('Active Directory debe usar ldap:// o ldaps://.');
    }
  }

  private encrypt(value: string): string {
    return encryptSecret(value, this.encryptionKey());
  }

  private decrypt(value: string): string {
    return decryptSecret(value, this.encryptionKey());
  }

  private encryptionKey(): string {
    const secret = this.config.get<string>('AI_SETTINGS_ENCRYPTION_KEY') ?? '';
    if (secret.length < 32) {
      throw new BadRequestException(
        'Falta AI_SETTINGS_ENCRYPTION_KEY para cifrar la identidad.',
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
}
