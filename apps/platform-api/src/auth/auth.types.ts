export type AuthRole = 'operator' | 'admin' | 'viewer';

export type AuthUser = {
  email: string;
  name: string;
  tenant: string;
  role: AuthRole;
};

export function actingTenant(user: AuthUser, requested?: string): string {
  const next = (requested ?? '').trim();
  if (user.role === 'operator' && next) {
    return next;
  }
  return user.tenant || 'default';
}
