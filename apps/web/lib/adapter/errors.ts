// megaui:apps/next-app/lib/mega-api.ts@0ff3a9d (megaErrorResponse)
//
// Diff vs upstream (GC-03 / DEBT-03 / WA-03):
// - Single exit for Mega/mega2/zod → HTTP status + JSON envelope + i18n
//   messageKey (GC-04). upstream mapped errors inline in mega-api.ts.
// - Unknown/internal errors never leak cause messages (GC-07 / ER-11).

import {
  MEGA_ERROR_CODES,
  MegaBadRequestError,
  MegaConflictError,
  MegaError,
  MegaForbiddenError,
  MegaInternalError,
  MegaNotFoundError,
  MegaTitleConflictError,
  MegaUnauthorizedError,
  SearchCjkScaleExceededError,
  serializeMegaError,
} from "@megaui/engine";
import { getTranslation, resolveApiLocale, type SupportedLocale } from "@megaui/i18n";
import { z } from "zod";

import type { MegaHttpFailureBody } from "./envelope";

export class MegaApiInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MegaApiInputError";
  }
}

const MEGA_ERROR_MESSAGE_KEYS: Record<string, string> = {
  [MEGA_ERROR_CODES.UNAUTHORIZED]: "errors.auth.unauthorized",
  [MEGA_ERROR_CODES.BAD_REQUEST]: "errors.mega.badRequest",
  [MEGA_ERROR_CODES.NOT_FOUND]: "errors.mega.notFound",
  [MEGA_ERROR_CODES.FORBIDDEN]: "errors.mega.forbidden",
  [MEGA_ERROR_CODES.CONFLICT]: "errors.mega.conflict",
  [MEGA_ERROR_CODES.TITLE_CONFLICT]: "errors.mega.titleConflict",
  [MEGA_ERROR_CODES.INTERNAL]: "errors.mega.internal",
  [MEGA_ERROR_CODES.SEARCH_CJK_SCALE_EXCEEDED]: "errors.search.cjkScaleExceeded",
};

function resolveMessageKey(code: string): string {
  return MEGA_ERROR_MESSAGE_KEYS[code] ?? "errors.mega.internal";
}

function readNestedMessage(
  t: ReturnType<typeof getTranslation>,
  messageKey: string,
): string {
  const segments = messageKey.split(".");
  let current: unknown = t;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null || !(segment in current)) {
      return getTranslation("en").errors.mega.internal;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" ? current : getTranslation("en").errors.mega.internal;
}

function localizeFailure(
  code: string,
  fallbackMessage: string,
  locale: SupportedLocale,
): MegaHttpFailureBody["error"] {
  const messageKey = resolveMessageKey(code);
  const localized = readNestedMessage(getTranslation(locale), messageKey);
  return {
    code,
    messageKey,
    message: localized || fallbackMessage,
  };
}

export function mapMegaErrorToHttpResponse(
  error: unknown,
  request?: Request,
): { status: number; body: MegaHttpFailureBody } {
  const locale = request ? resolveApiLocale(request) : ("en" as SupportedLocale);
  const serialized = serializeMegaError(error);
  const code = serialized.error.code;

  if (error instanceof MegaApiInputError || error instanceof z.ZodError) {
    const message =
      error instanceof MegaApiInputError
        ? error.message
        : "Invalid Mega API input";
    return {
      status: 400,
      body: {
        error: localizeFailure(MEGA_ERROR_CODES.BAD_REQUEST, message, locale),
      },
    };
  }

  if (error instanceof MegaUnauthorizedError) {
    return {
      status: 401,
      body: {
        error: localizeFailure(code, serialized.error.message, locale),
      },
    };
  }

  if (error instanceof MegaForbiddenError) {
    return {
      status: 403,
      body: {
        error: localizeFailure(code, serialized.error.message, locale),
      },
    };
  }

  if (error instanceof MegaNotFoundError) {
    return {
      status: 404,
      body: {
        error: localizeFailure(code, serialized.error.message, locale),
      },
    };
  }

  if (
    error instanceof MegaTitleConflictError ||
    error instanceof MegaConflictError
  ) {
    return {
      status: 409,
      body: {
        error: localizeFailure(code, serialized.error.message, locale),
      },
    };
  }

  if (error instanceof MegaBadRequestError) {
    return {
      status: 400,
      body: {
        error: localizeFailure(code, serialized.error.message, locale),
      },
    };
  }

  if (error instanceof SearchCjkScaleExceededError) {
    const body = {
      error: {
        code: MEGA_ERROR_CODES.SEARCH_CJK_SCALE_EXCEEDED,
        messageKey: "errors.search.cjkScaleExceeded",
      },
    } as MegaHttpFailureBody;
    return { status: 503, body };
  }

  if (error instanceof MegaInternalError || !(error instanceof MegaError)) {
    return {
      status: 500,
      body: {
        error: localizeFailure(
          MEGA_ERROR_CODES.INTERNAL,
          serialized.error.message,
          locale,
        ),
      },
    };
  }

  return {
    status: 500,
    body: {
      error: localizeFailure(code, serialized.error.message, locale),
    },
  };
}

export function unauthorizedMegaResponse(request: Request): {
  status: number;
  body: MegaHttpFailureBody;
} {
  return mapMegaErrorToHttpResponse(new MegaUnauthorizedError("Unauthorized"), request);
}
