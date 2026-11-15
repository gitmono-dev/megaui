import { MegaApiError } from "@megaui/ui/query";

export interface MegaErrorMessages {
  readonly badRequest: string;
  readonly conflict: string;
  readonly forbidden: string;
  readonly internal: string;
  readonly notFound: string;
}

export function issueErrorMessage(
  error: unknown,
  fallback: string,
  messages: MegaErrorMessages,
): string {
  if (!(error instanceof MegaApiError)) return fallback;
  if (error.status === 403) return messages.forbidden;
  if (error.status === 404) return messages.notFound;
  if (error.status === 409) return messages.conflict;
  if (error.status === 400) return messages.badRequest;
  return messages.internal;
}
