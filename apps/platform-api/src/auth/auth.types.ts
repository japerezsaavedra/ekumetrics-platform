export type AuthRole = 'operator' | 'admin' | 'viewer' | 'kiosk';

export type AuthUser = {
  email: string;
  name: string;
  tenant: string;
  role: AuthRole;
  deviceId?: string;
  site?: string;
  dashboard?: string;
};

export function actingTenant(user: AuthUser, requested?: string): string {
  const next = (requested ?? '').trim();
  if (user.role === 'operator' && next) {
    return next;
  }
  return user.tenant || 'default';
}
