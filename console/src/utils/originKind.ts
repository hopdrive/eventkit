// A decoded origin is any registered entry point, not only a human click: an inbound
// webhook, a schedule, or a system trigger is an origin too. The kind label is derived
// entirely from the decoded object's optional `trigger` field, so eventkit stays generic
// and never assumes a specific consumer's shape. An absent or unrecognized trigger falls
// back to a neutral 'Origin'.
export function originKindLabel(origin: unknown): string {
  const trigger =
    origin && typeof origin === 'object' ? (origin as Record<string, unknown>).trigger : undefined;
  switch (trigger) {
    case 'user':
      return 'User action';
    case 'webhook':
      return 'Webhook';
    case 'schedule':
      return 'Scheduled';
    case 'system':
      return 'System';
    default:
      return 'Origin';
  }
}
