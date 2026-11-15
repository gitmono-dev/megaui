// megaui:libs/storage/providers/s3.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the PK-08 task card):
// - S3-compatible path only — no OSS/COS/R2 factory helpers (ADR-ARCH-05).
// - Config is explicit (`S3StorageConfig`); no `@config` / env singleton.
// - Public surface focused on presigned PUT/GET + public URL assembly
//   (PK-08 ACs); direct `uploadFile`/`listFiles` left for WA-19 if needed.
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl as awsGetSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  S3StorageConfig,
  SignedUrlParams,
  SignedUrlResult,
} from "./types";

export type GetSignedUrlFn = (
  client: S3Client,
  command: GetObjectCommand | PutObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;

export interface PutObjectParams {
  key: string;
  body: Uint8Array;
  contentType: string;
  metadata?: Record<string, string>;
}

export interface DeleteObjectParams {
  key: string;
}

export interface CreateS3StorageOptions {
  config: S3StorageConfig;
  /** Test seam — defaults to AWS SDK `getSignedUrl`. */
  getSignedUrl?: GetSignedUrlFn;
  /** Test seam — defaults to a real `S3Client`. */
  client?: S3Client;
}

function requireNonEmpty(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `[@megaui/storage] ${name} is required (GC-07 fail-closed — no implicit fallback)`,
    );
  }
  return value;
}

export class S3Storage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string | undefined;
  private readonly defaultExpiration: number;
  private readonly getSignedUrl: GetSignedUrlFn;

  constructor(options: CreateS3StorageOptions) {
    const cfg = options.config;
    requireNonEmpty(cfg.region, "region");
    requireNonEmpty(cfg.accessKeyId, "accessKeyId");
    requireNonEmpty(cfg.accessKeySecret, "accessKeySecret");
    this.bucket = requireNonEmpty(cfg.bucket, "bucket");
    this.publicUrl = cfg.publicUrl?.replace(/\/+$/, "") || undefined;
    this.defaultExpiration = cfg.defaultExpiration ?? 3600;
    this.getSignedUrl = options.getSignedUrl ?? awsGetSignedUrl;

    if (options.client) {
      this.client = options.client;
    } else {
      const clientConfig: S3ClientConfig = {
        region: cfg.region,
        credentials: {
          accessKeyId: cfg.accessKeyId,
          secretAccessKey: cfg.accessKeySecret,
        },
        endpoint: cfg.endpoint,
        forcePathStyle: cfg.forcePathStyle ?? false,
      };
      this.client = new S3Client(clientConfig);
    }
  }

  /** Assemble a permanent public read URL when `publicUrl` is configured. */
  buildPublicUrl(key: string): string | undefined {
    if (!this.publicUrl) return undefined;
    const normalizedKey = key.replace(/^\/+/, "");
    const encoded = normalizedKey
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `${this.publicUrl}/${encoded}`;
  }

  async createSignedUrl(params: SignedUrlParams): Promise<SignedUrlResult> {
    const expiresIn = params.expiresIn ?? this.defaultExpiration;
    const operation = params.operation ?? "get";

    let command: GetObjectCommand | PutObjectCommand;
    if (operation === "get") {
      command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: params.key,
      });
    } else if (operation === "put") {
      command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: params.key,
        ContentType: params.contentType || "application/octet-stream",
      });
    } else {
      throw new Error(`[@megaui/storage] unsupported signed-url operation: ${operation}`);
    }

    const url = await this.getSignedUrl(this.client, command, { expiresIn });
    return {
      url,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  /** Upload an object directly through the configured S3-compatible client. */
  async putObject(params: PutObjectParams): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: params.key,
        Body: params.body,
        ContentType: params.contentType,
        Metadata: params.metadata,
      }),
    );
  }

  /** Delete an object as a compensating action after a failed upload flow. */
  async deleteObject(params: DeleteObjectParams): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: params.key,
      }),
    );
  }
}

export function createS3Storage(options: CreateS3StorageOptions): S3Storage {
  return new S3Storage(options);
}
