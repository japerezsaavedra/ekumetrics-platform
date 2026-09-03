jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { entraAlias, requiredActionsFor } from './keycloak-admin';

describe('Keycloak production MFA policy', () => {
  it('names the Entra ID provider per tenant', () => {
    expect(entraAlias('Acme Norte')).toBe('eku-entra-acmenorte');
  });

  it('does not force Keycloak required actions so the portal can complete login', () => {
    expect(requiredActionsFor('production')).toEqual([]);
    expect(requiredActionsFor('local')).toEqual([]);
  });
});
