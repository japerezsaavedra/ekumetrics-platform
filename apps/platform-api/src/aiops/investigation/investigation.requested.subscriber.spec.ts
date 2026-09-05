import { InvestigationRequestedSubscriber } from './investigation.requested.subscriber';

describe('InvestigationRequestedSubscriber', () => {
  it('ack y no dispara investigacion si la politica es MANUAL', async () => {
    const ack = jest.fn();
    const term = jest.fn();
    const trigger = jest.fn();
    let handler: (msg: { headers: { tenantId: string }; payload: { tenantId: string; incidentId: string } }, ctrl: { ack: () => Promise<void>; term: (r: string) => Promise<void> }) => Promise<void> = async () => undefined;
    const eventBus = {
      subscribe: jest.fn(
        async (_opts: unknown, cb: typeof handler) => {
          handler = cb;
          return { unsubscribe: jest.fn() };
        },
      ),
    };
    const subscriber = new InvestigationRequestedSubscriber(
      eventBus as never,
      { trigger } as never,
      {
        resolve: jest.fn().mockResolvedValue({ mode: 'MANUAL' }),
        shouldAutoInvestigate: () => false,
      } as never,
      { find: jest.fn() } as never,
      { incident: { findFirst: jest.fn() }, tenant: { findFirst: jest.fn() } } as never,
      { build: jest.fn() } as never,
    );
    await subscriber.onModuleInit();
    await handler(
      {
        headers: { tenantId: 'tenant-a' },
        payload: { tenantId: 'tenant-a', incidentId: 'inc-1' },
      },
      { ack, term },
    );
    expect(trigger).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalled();
  });
});
