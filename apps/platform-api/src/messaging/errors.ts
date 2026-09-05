export class EventBusUnavailableError extends Error {
  readonly code = 'EVENT_BUS_UNAVAILABLE';

  constructor(message = 'event bus unavailable') {
    super(message);
    this.name = 'EventBusUnavailableError';
  }
}

export class EventBusValidationError extends Error {
  readonly code = 'EVENT_BUS_VALIDATION';

  constructor(message: string) {
    super(message);
    this.name = 'EventBusValidationError';
  }
}

export class EventBusTimeoutError extends Error {
  readonly code = 'EVENT_BUS_TIMEOUT';

  constructor(message = 'event bus request timed out') {
    super(message);
    this.name = 'EventBusTimeoutError';
  }
}
