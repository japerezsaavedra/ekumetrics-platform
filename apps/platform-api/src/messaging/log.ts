import { Logger } from '@nestjs/common';

export function eventBusLog(
  logger: Logger,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  logger.log(JSON.stringify({ event, ...fields }));
}

export function eventBusWarn(
  logger: Logger,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  logger.warn(JSON.stringify({ event, ...fields }));
}

export function eventBusError(
  logger: Logger,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  logger.error(JSON.stringify({ event, ...fields }));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
