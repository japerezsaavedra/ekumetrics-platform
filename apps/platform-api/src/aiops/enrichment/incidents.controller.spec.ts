import { BadRequestException } from '@nestjs/common';
import { IncidentsController } from '../incidents.controller';

jest.mock('../../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

describe('IncidentsController enrichment (comportamiento existente intacto)', () => {
  const user = {
    email: 'ops@cliente',
    name: 'Ops',
    tenant: 'cliente-a',
    role: 'admin' as const,
  };
  const incident = {
    id: 'inc-1',
    tenantId: 'tenant-a',
    title: 'Degradacion',
    status: 'open',
    severity: 'warning',
  };

  const correlation = {
    list: jest.fn(),
    get: jest.fn(),
    correlate: jest.fn(),
    snapshot: jest.fn(),
    seedExample: jest.fn(),
    impact: jest.fn(),
  };
  const enrichment = {
    attachMany: jest.fn(),
    find: jest.fn(),
    applyRcaFeedback: jest.fn(),
  };
  const publisher = {
    requestMany: jest.fn(),
    request: jest.fn(),
  };

  const controller = () =>
    new IncidentsController(
      correlation as never,
      enrichment as never,
      publisher as never,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    correlation.list.mockResolvedValue([incident]);
    correlation.get.mockResolvedValue(incident);
    correlation.correlate.mockResolvedValue({
      tenant: 'cliente-a',
      created: 1,
      updated: 0,
      incidents: [incident],
    });
    enrichment.attachMany.mockImplementation(
      (_tenantId: string, rows: typeof incident[]) =>
        Promise.resolve(rows.map((row) => ({ ...row, enrichment: null }))),
    );
    enrichment.find.mockResolvedValue(null);
    publisher.requestMany.mockResolvedValue(undefined);
    publisher.request.mockResolvedValue(undefined);
  });

  it('lista incidentes y adjunta enrichment nulo sin romper el contrato Wave 1', async () => {
    const rows = await controller().list(user);
    expect(correlation.list).toHaveBeenCalledWith('cliente-a');
    expect(rows[0]).toEqual(
      expect.objectContaining({
        id: 'inc-1',
        title: 'Degradacion',
        status: 'open',
        severity: 'warning',
        enrichment: null,
      }),
    );
  });

  it('correlate no espera al worker: publica enrichment.requested y devuelve el resultado V1', async () => {
    const result = await controller().correlate(user);
    expect(result.created).toBe(1);
    expect(result.incidents[0].id).toBe('inc-1');
    expect(publisher.requestMany).toHaveBeenCalledWith([incident]);
  });

  it('rechaza feedback RCA con accion invalida', async () => {
    await expect(
      controller().rcaFeedback(user, 'inc-1', { action: 'hack' as never }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(enrichment.applyRcaFeedback).not.toHaveBeenCalled();
  });
});
