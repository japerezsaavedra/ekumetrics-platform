export const RCA_FEEDBACK_ACTIONS = [
  'CONFIRM',
  'REJECT',
  'SELECT_ALTERNATIVE',
  'ADD_NOTE',
] as const;

export type RcaFeedbackAction = (typeof RCA_FEEDBACK_ACTIONS)[number];

export type RcaFeedbackRecord = {
  tenantId: string;
  incidentId: string;
  action: RcaFeedbackAction;
  selectedEntityId?: string;
  note?: string;
  userId?: string;
  createdAt?: Date;
};

export function isRcaFeedbackAction(
  value: string,
): value is RcaFeedbackAction {
  return (RCA_FEEDBACK_ACTIONS as readonly string[]).includes(value);
}

const FEEDBACK_ALIASES: Record<string, RcaFeedbackAction> = {
  CONFIRM: 'CONFIRM',
  REJECT: 'REJECT',
  SELECT_ALTERNATIVE: 'SELECT_ALTERNATIVE',
  ADD_NOTE: 'ADD_NOTE',
  confirm: 'CONFIRM',
  reject: 'REJECT',
  select_alternative: 'SELECT_ALTERNATIVE',
  add_note: 'ADD_NOTE',
};

/**
 * Canonical domain values are UPPERCASE. HTTP may still send Wave 2 lowercase
 * aliases; they are normalized here and never stored as a second vocabulary.
 */
export function parseRcaFeedbackAction(
  value: unknown,
): RcaFeedbackAction | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return (
    FEEDBACK_ALIASES[trimmed] ??
    FEEDBACK_ALIASES[trimmed.toUpperCase()] ??
    null
  );
}
