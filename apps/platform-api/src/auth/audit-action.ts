import { SetMetadata } from '@nestjs/common';

export const AUDIT_ACTION = 'auditAction';
export type AuditPolicy = { action: string; entity: string };
export const AuditAction = (action: string, entity: string) =>
  SetMetadata(AUDIT_ACTION, { action, entity } satisfies AuditPolicy);
