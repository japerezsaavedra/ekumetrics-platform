export class TenantScopeError extends Error {
  constructor(message = 'El registro no pertenece al tenant.') {
    super(message);
    this.name = 'TenantScopeError';
  }
}

export function assertTenantScope(
  tenantId: string,
  recordTenantId?: string,
): void {
  if (!tenantId) {
    throw new TenantScopeError('tenantId es obligatorio.');
  }
  if (recordTenantId && recordTenantId !== tenantId) {
    throw new TenantScopeError();
  }
}
