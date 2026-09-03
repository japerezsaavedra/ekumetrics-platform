import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  catchError,
  from,
  mergeMap,
  Observable,
  switchMap,
  throwError,
} from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from './auth.types';
import { AUDIT_ACTION, type AuditPolicy } from './audit-action';

type AuditedRequest = {
  method: string;
  route?: { path?: string };
  params?: Record<string, string | undefined>;
  query?: Record<string, string | undefined>;
  body?: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  user?: AuthUser;
};

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const policy = this.reflector.getAllAndOverride<AuditPolicy>(AUDIT_ACTION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!policy) return next.handle();

    const request = context.switchToHttp().getRequest<AuditedRequest>();
    return from(this.start(request, policy)).pipe(
      switchMap((auditId) =>
        next.handle().pipe(
          mergeMap((value: unknown) =>
            from(this.complete(auditId, policy.action, value)).pipe(
              mergeMap(() => [value]),
            ),
          ),
          catchError((error: unknown) =>
            from(this.fail(auditId, policy.action, error)).pipe(
              switchMap(() => throwError(() => error)),
            ),
          ),
        ),
      ),
    );
  }

  private async start(request: AuditedRequest, policy: AuditPolicy) {
    const actor = request.user;
    if (!actor)
      throw new Error('No se puede auditar una acción sin actor autenticado.');
    const requestedTenant = this.targetTenant(request, actor);
    const targetTenant =
      actor.role !== 'operator' || policy.action === 'tenant.deleted'
        ? actor.tenant
        : requestedTenant;
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: targetTenant },
      select: { id: true },
    });
    const fallback = tenant
      ? null
      : await this.prisma.tenant.findUnique({
          where: { slug: actor.tenant },
          select: { id: true },
        });
    const tenantId = tenant?.id ?? fallback?.id;
    if (!tenantId)
      throw new Error('No se encontró el tenant para registrar auditoría.');
    const entityId =
      request.params?.['id'] ??
      request.params?.['siteId'] ??
      request.params?.['slug'] ??
      null;
    return (
      await this.prisma.auditLog.create({
        data: {
          tenantId,
          actor: actor.email,
          action: `${policy.action}.requested`,
          entity: policy.entity,
          entityId,
          metadata: {
            method: request.method,
            route: request.route?.path ?? '',
            targetTenant: requestedTenant,
          },
        },
        select: { id: true },
      })
    ).id;
  }

  private async complete(auditId: string, action: string, value: unknown) {
    const id = this.responseId(value);
    await this.prisma.auditLog.update({
      where: { id: auditId },
      data: {
        action: `${action}.succeeded`,
        ...(id ? { entityId: id } : {}),
      },
    });
  }

  private async fail(auditId: string, action: string, error: unknown) {
    const status =
      typeof error === 'object' && error && 'status' in error
        ? String(error.status)
        : '500';
    await this.prisma.auditLog.update({
      where: { id: auditId },
      data: { action: `${action}.failed`, metadata: { status } },
    });
  }

  private targetTenant(request: AuditedRequest, actor: AuthUser) {
    const header = request.headers['x-eku-tenant'];
    const headerTenant = Array.isArray(header) ? header[0] : header;
    const bodyTenant = request.body?.['tenantSlug'] ?? request.body?.['tenant'];
    return (
      request.params?.['slug'] ||
      (typeof bodyTenant === 'string' ? bodyTenant : '') ||
      request.query?.['as'] ||
      headerTenant ||
      actor.tenant
    ).trim();
  }

  private responseId(value: unknown) {
    if (!value || typeof value !== 'object' || !('id' in value)) return '';
    return typeof value.id === 'string' ? value.id : '';
  }
}
