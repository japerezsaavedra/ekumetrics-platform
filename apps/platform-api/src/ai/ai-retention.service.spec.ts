import { ConfigService } from '@nestjs/config';

jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { AiRetentionService } from './ai-retention.service';

describe('AiRetentionService', () => {
  it('elimina solo sesiones vencidas y consultas heredadas vencidas', async () => {
    type ConversationFindInput = { where: { expiresAt: { lt: Date } } };
    type InquiryFindInput = {
      where: { conversationId: null; retentionUntil: { lt: Date } };
    };
    let conversationInput: ConversationFindInput | undefined;
    let inquiryInput: InquiryFindInput | undefined;
    const prisma = {
      aiConversation: {
        findMany: jest
          .fn()
          .mockImplementation((input: ConversationFindInput) => {
            conversationInput = input;
            return Promise.resolve([{ id: 'expired-session' }]);
          }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      aiInquiry: {
        findMany: jest.fn().mockImplementation((input: InquiryFindInput) => {
          inquiryInput = input;
          return Promise.resolve([{ id: 'legacy-inquiry' }]);
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn((key: string) =>
        key === 'AI_INQUIRY_RETENTION_BATCH_SIZE' ? '100' : undefined,
      ),
    } as unknown as ConfigService;
    const service = new AiRetentionService(config, prisma as never);

    await expect(service.purge()).resolves.toBe(2);
    expect(conversationInput?.where.expiresAt.lt).toBeInstanceOf(Date);
    expect(inquiryInput?.where.conversationId).toBeNull();
    expect(inquiryInput?.where.retentionUntil.lt).toBeInstanceOf(Date);
  });
});
