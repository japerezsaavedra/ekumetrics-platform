import {
  BadGatewayException,
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type AlertmanagerMatcher = {
  name?: string;
  value?: string;
  isRegex?: boolean;
  isEqual?: boolean;
};

type AlertmanagerAlert = {
  annotations?: Record<string, string>;
  endsAt?: string;
  fingerprint?: string;
  generatorURL?: string;
  labels?: Record<string, string>;
  startsAt?: string;
  status?: {
    inhibitedBy?: string[];
    silencedBy?: string[];
    state?: string;
  };
  updatedAt?: string;
};

type AlertmanagerSilence = {
  comment?: string;
  createdBy?: string;
  endsAt?: string;
  id?: string;
  matchers?: AlertmanagerMatcher[];
  startsAt?: string;
  status?: { state?: string };
  updatedAt?: string;
};

@Injectable()
export class AlertmanagerService {
  constructor(private readonly config: ConfigService) {}

  async overview(tenantSlug: string, includePlatform = false) {
    const [alerts, silences] = await Promise.all([
      this.request<AlertmanagerAlert[]>('/api/v2/alerts'),
      this.request<AlertmanagerSilence[]>('/api/v2/silences'),
    ]);
    if (!Array.isArray(alerts) || !Array.isArray(silences)) {
      throw new BadGatewayException(
        'El servicio de alertas devolvió una respuesta incompatible.',
      );
    }
    return {
      tenant: tenantSlug,
      alerts: alerts
        .filter((alert) =>
          this.belongsToTenant(alert.labels, tenantSlug, includePlatform),
        )
        .map((alert) => this.presentAlert(alert)),
      silences: silences
        .filter((silence) =>
          this.silenceBelongsToTenant(silence, tenantSlug, includePlatform),
        )
        .map((silence) => this.presentSilence(silence)),
      updatedAt: new Date().toISOString(),
    };
  }

  async createSilence(
    actor: string,
    tenantSlug: string,
    input: {
      comment?: string;
      durationMinutes?: number;
      matchers?: AlertmanagerMatcher[];
    },
  ) {
    const durationMinutes = Number(input.durationMinutes);
    if (
      !Number.isInteger(durationMinutes) ||
      durationMinutes < 5 ||
      durationMinutes > 10_080
    ) {
      throw new BadRequestException(
        'La duración del silencio debe estar entre 5 minutos y 7 días.',
      );
    }
    const comment = (input.comment ?? '').trim();
    if (comment.length < 5 || comment.length > 500) {
      throw new BadRequestException(
        'Documente el motivo del silencio entre 5 y 500 caracteres.',
      );
    }
    const matchers = this.withTenant(
      this.validateMatchers(input.matchers),
      tenantSlug,
    );
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
    const result = await this.request<{ silenceID?: string }>(
      '/api/v2/silences',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matchers,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          createdBy: actor,
          comment,
        }),
      },
    );
    if (!result.silenceID) {
      throw new BadGatewayException(
        'El servicio de alertas no confirmó la creación del silencio.',
      );
    }
    return { id: result.silenceID, startsAt, endsAt };
  }

  async expireSilence(
    idInput: string | undefined,
    tenantSlug: string,
    includePlatform = false,
  ) {
    const id = (idInput ?? '').trim();
    if (!/^[a-zA-Z0-9-]{8,128}$/.test(id)) {
      throw new BadRequestException(
        'El identificador del silencio no es válido.',
      );
    }
    const silence = await this.request<AlertmanagerSilence>(
      `/api/v2/silence/${encodeURIComponent(id)}`,
    );
    if (!this.silenceBelongsToTenant(silence, tenantSlug, includePlatform)) {
      throw new BadRequestException(
        'El silencio no pertenece al tenant actual.',
      );
    }
    await this.request<unknown>(`/api/v2/silence/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return { id, expired: true };
  }

  private belongsToTenant(
    labels: Record<string, string> | undefined,
    tenantSlug: string,
    includePlatform: boolean,
  ): boolean {
    const value = labels?.tenant_id || labels?.tenant || '';
    if (value) return value === tenantSlug;
    return includePlatform;
  }

  private silenceBelongsToTenant(
    silence: AlertmanagerSilence,
    tenantSlug: string,
    includePlatform: boolean,
  ): boolean {
    const tenant = (silence.matchers ?? []).find(
      (matcher) => matcher.name === 'tenant_id' || matcher.name === 'tenant',
    );
    if (tenant?.value) return tenant.value === tenantSlug;
    return includePlatform;
  }

  private withTenant(
    matchers: Array<{
      name: string;
      value: string;
      isRegex: boolean;
      isEqual: boolean;
    }>,
    tenantSlug: string,
  ) {
    const current = matchers.find(
      (matcher) => matcher.name === 'tenant_id' || matcher.name === 'tenant',
    );
    if (current && current.value !== tenantSlug) {
      throw new BadRequestException(
        'El silencio no puede cruzar el límite del tenant.',
      );
    }
    if (current) return matchers;
    return [
      ...matchers,
      { name: 'tenant_id', value: tenantSlug, isRegex: false, isEqual: true },
    ];
  }

  private validateMatchers(input?: AlertmanagerMatcher[]) {
    if (!Array.isArray(input) || input.length < 1 || input.length > 12) {
      throw new BadRequestException('Incluya entre 1 y 12 filtros de alerta.');
    }
    const matchers = input.map((matcher) => {
      const name = (matcher.name ?? '').trim();
      const value = (matcher.value ?? '').trim();
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        throw new BadRequestException('El nombre de un filtro no es válido.');
      }
      if (!value || value.length > 512) {
        throw new BadRequestException('El valor de un filtro no es válido.');
      }
      if (matcher.isRegex || matcher.isEqual === false) {
        throw new BadRequestException(
          'Los silencios creados desde el portal solo admiten igualdades exactas.',
        );
      }
      return { name, value, isRegex: false, isEqual: true };
    });
    if (!matchers.some((matcher) => matcher.name === 'alertname')) {
      throw new BadRequestException(
        'El silencio debe quedar limitado por el nombre de la alerta.',
      );
    }
    return matchers;
  }

  private presentAlert(alert: AlertmanagerAlert) {
    const labels = this.strings(alert.labels);
    return {
      fingerprint: alert.fingerprint ?? '',
      name: labels['alertname'] ?? 'Alerta sin nombre',
      severity: labels['severity'] ?? 'unknown',
      labels,
      annotations: this.strings(alert.annotations),
      startsAt: alert.startsAt ?? null,
      endsAt: alert.endsAt ?? null,
      updatedAt: alert.updatedAt ?? null,
      generatorUrl: alert.generatorURL ?? '',
      state: alert.status?.state ?? 'active',
      silencedBy: alert.status?.silencedBy ?? [],
      inhibitedBy: alert.status?.inhibitedBy ?? [],
    };
  }

  private presentSilence(silence: AlertmanagerSilence) {
    return {
      id: silence.id ?? '',
      status: silence.status?.state ?? 'unknown',
      startsAt: silence.startsAt ?? null,
      endsAt: silence.endsAt ?? null,
      updatedAt: silence.updatedAt ?? null,
      createdBy: silence.createdBy ?? '',
      comment: silence.comment ?? '',
      matchers: (silence.matchers ?? []).map((matcher) => ({
        name: matcher.name ?? '',
        value: matcher.value ?? '',
        isRegex: matcher.isRegex === true,
        isEqual: matcher.isEqual !== false,
      })),
    };
  }

  private strings(value?: Record<string, string>) {
    if (!value) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, item]) =>
            key.length <= 128 &&
            typeof item === 'string' &&
            item.length <= 4_096,
        )
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    try {
      const response = await fetch(`${this.baseUrl()}${path}`, {
        ...init,
        headers: { Accept: 'application/json', ...init?.headers },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      throw new BadGatewayException(
        `El servicio de alertas no está disponible (${error instanceof Error ? error.message : 'error de conexión'}).`,
      );
    }
  }

  private baseUrl() {
    return (
      this.config.get<string>('ALERTMANAGER_URL') ?? 'http://127.0.0.1:9093'
    ).replace(/\/$/, '');
  }
}
