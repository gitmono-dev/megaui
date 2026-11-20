// megaui-only (FS-12): application-bot direct-message delivery.
/**
 * FS-12：通过应用机器人向已绑定的 open_id 投递登录验证码。
 *
 * The caller supplies the server-side binding and a stable delivery UUID. The
 * client never accepts a provider target or a recipient from the browser, and
 * it never logs the message body. The fixed-origin transport owns retrying the
 * same POST, so every retry carries the same UUID and payload.
 */
import { FeishuTransport, FeishuTransportError } from "./http";
import { FeishuTokenManager, type FeishuTokenRequestOptions } from "./token";
import type { FeishuTenantCredentials } from "./types";

/** The only provider route used for enterprise login messages. */
export const FEISHU_MESSAGE_PATH = "/open-apis/im/v1/messages?receive_id_type=open_id";

const FEISHU_MESSAGE_TYPE = "text" as const;
const DEFAULT_APPLICATION_NAME = "MegaUI";
const DEFAULT_LOGIN_PURPOSE = "企业登录";

export interface FeishuMessageClientOptions {
  /** The fixed-origin transport selected by FS-87. */
  readonly transport: FeishuTransport;
  /** Server-held tenant/app credentials; never derived from request input. */
  readonly credentials: FeishuTenantCredentials;
  /** Reuses the process token cache and single-flight refresh layer. */
  readonly tokenManager?: FeishuTokenManager;
  /** Test/assembly seam; production uses tokenManager. */
  readonly getToken?: FeishuMessageGetToken;
  /** Server-configured site where the user must enter the code. */
  readonly trustedSiteUrl: string;
  /** Optional fixed product label used in the human-facing message. */
  readonly applicationName?: string;
  /** Optional fixed purpose; callers cannot supply arbitrary message text. */
  readonly purpose?: string;
}

/** The token source of the client: the token manager, or a test/assembly seam. */
export type FeishuMessageGetToken = (
  credentials: FeishuTenantCredentials,
  options?: FeishuTokenRequestOptions,
) => Promise<string>;

/** FSL-160: the options of one `send` call. */
export interface FeishuMessageSendOptions {
  /** A token the caller already holds; the token source is then not asked. */
  readonly token?: string;
  /** The absolute deadline of the call, on the clock of the transport. */
  readonly deadline?: number;
}

export interface FeishuLoginMessageInput {
  /** The open_id read from the server-side enterprise identity binding. */
  readonly boundOpenId: string;
  /** The already-generated, server-side OTP. */
  readonly code: string;
  /** The delivery UUID persisted with the challenge/outbox row. */
  readonly uuid: string;
}

export type FeishuMessageResult =
  | {
      readonly kind: "accepted";
      readonly uuid: string;
      readonly messageId: string;
    }
  | {
      readonly kind: "unknown";
      readonly uuid: string;
      readonly stage: "token" | "message";
      readonly reason: "timeout" | "transient" | "unavailable";
    }
  | {
      readonly kind: "rejected";
      readonly uuid: string;
      /**
       * `deadline` (FSL-160): the caller's deadline passed before the request was started,
       * so nothing reached the provider.
       */
      readonly reason: "permission" | "provider" | "invalid_response" | "deadline";
      readonly status?: number;
      readonly businessCode?: number;
    };

interface ProviderMessageEnvelope {
  readonly code?: unknown;
  readonly msg?: unknown;
  readonly data?: unknown;
}

/**
 * The fields of a successful send that the client reads (FSL-165 Q4).
 *
 * The real response has no `receive_id` and carries the text under
 * `body.content`, re-serialized by the provider, so neither is compared.
 */
interface ProviderMessageData {
  readonly message_id?: unknown;
  readonly msg_type?: unknown;
}

/**
 * Sends a login code through the application-bot IM v1 endpoint.
 *
 * A single call constructs one payload and gives it to FeishuTransport. The
 * transport may retry a transient request, but it serializes this same body,
 * including the same UUID, on every attempt. A timeout or connection failure
 * is deliberately reported as unknown: the provider may have accepted the
 * message, so a caller must not manufacture a second code.
 *
 * FSL-160: `send` takes optional call options. `token` is used as it is
 * instead of asking the token source; `deadline` (absolute milliseconds on the
 * transport clock) is handed unchanged to the token source and the transport.
 * A deadline that passed before the request left is reported as `rejected`
 * with reason `deadline`: nothing reached the provider. Without options nothing
 * changes.
 */
export class FeishuMessageClient {
  readonly tenantKey: string;
  readonly appId: string;

  private readonly transport: FeishuTransport;
  private readonly credentials: FeishuTenantCredentials;
  private readonly getToken: FeishuMessageGetToken;
  private readonly trustedSiteUrl: string;
  private readonly applicationName: string;
  private readonly purpose: string;

  constructor(options: FeishuMessageClientOptions) {
    if (
      !options ||
      !options.transport ||
      typeof options.transport.request !== "function" ||
      !options.credentials ||
      !isNonBlankText(options.credentials.tenantKey) ||
      !isNonBlankText(options.credentials.appId) ||
      !isNonBlankText(options.credentials.appSecret) ||
      (!options.tokenManager && typeof options.getToken !== "function") ||
      (options.tokenManager && options.getToken) ||
      !isTrustedSiteUrl(options.trustedSiteUrl) ||
      (options.applicationName !== undefined && !isNonBlankText(options.applicationName)) ||
      (options.purpose !== undefined && !isNonBlankText(options.purpose))
    ) {
      throw new Error("INVALID_FEISHU_MESSAGE_CLIENT_CONFIG");
    }

    this.transport = options.transport;
    this.credentials = Object.freeze({ ...options.credentials });
    this.tenantKey = this.credentials.tenantKey;
    this.appId = this.credentials.appId;
    this.getToken = options.tokenManager
      ? (credentials, tokenOptions) => options.tokenManager!.getToken(credentials, tokenOptions)
      : options.getToken!;
    this.trustedSiteUrl = options.trustedSiteUrl;
    this.applicationName = options.applicationName ?? DEFAULT_APPLICATION_NAME;
    this.purpose = options.purpose ?? DEFAULT_LOGIN_PURPOSE;
  }

  /** Sends one server-bound login code; no raw message text is logged. */
  async send(
    input: FeishuLoginMessageInput,
    options: FeishuMessageSendOptions = {},
  ): Promise<FeishuMessageResult> {
    if (
      !input ||
      !isNonBlankText(input.boundOpenId) ||
      !isNonBlankText(input.code) ||
      !isNonBlankText(input.uuid)
    ) {
      throw new Error("INVALID_FEISHU_MESSAGE_INPUT");
    }

    const { deadline } = options;
    let token: string;
    try {
      // An explicit token is used as it is (FSL-160); otherwise the token source is asked,
      // with the deadline when there is one.
      token =
        options.token !== undefined
          ? options.token
          : deadline === undefined
            ? await this.getToken(this.credentials)
            : await this.getToken(this.credentials, { deadline });
    } catch (error) {
      return tokenFailure(input.uuid, error);
    }
    if (!isNonBlankText(token)) {
      return {
        kind: "rejected",
        uuid: input.uuid,
        reason: "invalid_response",
      };
    }

    const content = JSON.stringify({
      text: `${this.applicationName} ${this.purpose}验证码：${input.code}\n请仅在可信站点 ${this.trustedSiteUrl} 输入此验证码。\n此验证码仅用于${this.purpose}，请勿转发。`,
    });
    try {
      const envelope = await this.transport.request<ProviderMessageEnvelope>(
        FEISHU_MESSAGE_PATH,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          // Keep the exact provider shape and the stable UUID on all retries.
          json: {
            receive_id: input.boundOpenId,
            msg_type: FEISHU_MESSAGE_TYPE,
            content,
            uuid: input.uuid,
          },
          ...(deadline === undefined ? {} : { deadline }),
        },
      );
      const message = readMessageResponse(envelope);
      if (!message) {
        return {
          kind: "rejected",
          uuid: input.uuid,
          reason: "invalid_response",
        };
      }
      return { kind: "accepted", uuid: input.uuid, messageId: message.messageId };
    } catch (error) {
      return messageFailure(input.uuid, error);
    }
  }

  /** Alias used by delivery workers that call the operation `sendCode`. */
  async sendCode(
    input: FeishuLoginMessageInput,
    options: FeishuMessageSendOptions = {},
  ): Promise<FeishuMessageResult> {
    return this.send(input, options);
  }
}

/** Factory form for service assembly code. */
export function createFeishuMessageClient(
  options: FeishuMessageClientOptions,
): FeishuMessageClient {
  return new FeishuMessageClient(options);
}

/**
 * Reads an HTTP 200 answer the transport let through (ADR-FSL-11, FSL-165 Q4).
 *
 * The three conditions are sufficient: `code` is the number 0, `message_id`
 * is non-blank text and `msg_type` is `text`. A non-zero numeric `code` never
 * reaches this point, because the transport throws for it; a missing or
 * non-numeric `code` does, and is an invalid response.
 */
function readMessageResponse(
  envelope: ProviderMessageEnvelope,
): { messageId: string } | undefined {
  if (!isRecord(envelope) || envelope.code !== 0 || !isRecord(envelope.data)) {
    return undefined;
  }
  const data = envelope.data as ProviderMessageData;
  if (!isNonBlankText(data.message_id) || data.msg_type !== FEISHU_MESSAGE_TYPE) {
    return undefined;
  }
  return { messageId: data.message_id };
}

function tokenFailure(uuid: string, error: unknown): FeishuMessageResult {
  if (error instanceof FeishuTransportError) {
    if (error.code === "transport_deadline") return { kind: "rejected", uuid, reason: "deadline" };
    if (error.code === "transport_permanent" || error.code === "transport_redirect") {
      return {
        kind: "rejected",
        uuid,
        reason: error.status === 401 || error.status === 403 ? "permission" : "provider",
        status: error.status,
        businessCode: error.businessCode,
      };
    }
    return {
      kind: "unknown",
      uuid,
      stage: "token",
      reason: error.code === "transport_timeout" ? "timeout" : "transient",
    };
  }
  return { kind: "unknown", uuid, stage: "token", reason: "unavailable" };
}

function messageFailure(uuid: string, error: unknown): FeishuMessageResult {
  if (!(error instanceof FeishuTransportError)) {
    return { kind: "unknown", uuid, stage: "message", reason: "unavailable" };
  }
  // The transport refuses before the request leaves: the provider never saw it.
  if (error.code === "transport_deadline") return { kind: "rejected", uuid, reason: "deadline" };
  if (error.code === "transport_permanent" || error.code === "transport_redirect") {
    return {
      kind: "rejected",
      uuid,
      reason: error.status === 401 || error.status === 403 ? "permission" : "provider",
      status: error.status,
      businessCode: error.businessCode,
    };
  }
  return {
    kind: "unknown",
    uuid,
    stage: "message",
    reason: error.code === "transport_timeout" ? "timeout" : "transient",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isTrustedSiteUrl(value: unknown): value is string {
  if (!isNonBlankText(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}
