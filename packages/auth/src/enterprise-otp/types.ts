// megaui-only (FS-35): Explicit server-side OTP binding and sealed-record contracts.
export interface EnterpriseOtpBinding {
  readonly scope: string;
  readonly deploymentRole: "development" | "test" | "production" | "canary";
  readonly tenantKey: string;
  readonly appId: string;
  readonly challengeId: string;
  readonly localUserId: string;
  readonly identityId: string;
  readonly identityVersion: number;
  readonly purpose: "login";
  readonly flowHash: string;
  readonly generation: number;
  readonly expiresAtMs: number;
}

export interface EnterpriseOtpCryptoConfig {
  readonly hmacKeyId: string;
  readonly hmacKey: Uint8Array;
  readonly deliveryKeyId: string;
  readonly deliveryKey: Uint8Array;
}

export interface EnterpriseOtpDigest {
  readonly codeHmac: string;
  readonly hmacKeyId: string;
}

export interface EnterpriseOtpDelivery {
  readonly encryptedPayload: string;
  readonly deliveryKeyId: string;
}

export interface EnterpriseOtpCrypto {
  readonly digest: (code: string, binding: EnterpriseOtpBinding) => EnterpriseOtpDigest;
  readonly verify: (code: unknown, binding: unknown, record: unknown) => boolean;
  readonly seal: (code: string, binding: EnterpriseOtpBinding) => EnterpriseOtpDelivery;
  readonly open: (record: unknown, binding: unknown) => string | null;
}

export interface EnterpriseOtpGrant {
  readonly kind: "accepted";
  readonly grantId: string;
  readonly challengeId: string;
  readonly localUserId: string;
  readonly identityId: string;
  readonly identityVersion: number;
  readonly authEpoch: number;
  readonly flowHash: string;
  readonly recoverUntil: Date;
}

export type EnterpriseOtpVerifyPortResult =
  | EnterpriseOtpGrant
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable" };

export type EnterpriseOtpVerifyPort = (input: {
  readonly challengeId: string;
  readonly flowHash: string;
  readonly code: unknown;
}) => Promise<EnterpriseOtpVerifyPortResult>;

// megaui-only (FS-11): structural injection keeps auth independent of engine.
export interface EnterprisePairingTransport {
  readonly peerAddress: string;
  readonly forwardedFor?: string;
}

export interface EnterprisePairingBody {
  readonly pairingId: string;
  readonly pairingToken: string;
  readonly expiresIn: 120;
  readonly resendAfter: 60;
}

export type EnterprisePairingPortResult =
  | { readonly kind: "accepted"; readonly status: 202; readonly body: EnterprisePairingBody }
  | { readonly kind: "rate-limited"; readonly status: 429; readonly code: "RATE_LIMITED" }
  | { readonly kind: "unavailable" };

export type EnterprisePairingPort = (input: {
  readonly loginName: string;
  readonly flowHash: string;
  readonly transport: EnterprisePairingTransport;
}) => Promise<EnterprisePairingPortResult>;

export interface EnterpriseFlowCookie {
  readonly name: "__Host-megaui.enterprise-flow";
  readonly value: string;
  readonly path: "/";
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: "lax";
  readonly maxAge: 600;
}

export type EnterprisePairingRequestResult =
  | { readonly kind: "accepted"; readonly status: 202; readonly body: EnterprisePairingBody; readonly cookie: EnterpriseFlowCookie }
  | Exclude<EnterprisePairingPortResult, { kind: "accepted" }>
  | { readonly kind: "invalid-input" };
