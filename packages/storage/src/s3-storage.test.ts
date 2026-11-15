import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { createS3Storage, type GetSignedUrlFn } from "./s3-storage";

describe("S3Storage presign + public URL (PK-08 AC1)", () => {
  const baseConfig = {
    region: "us-east-1",
    accessKeyId: "test-key",
    accessKeySecret: "test-secret",
    bucket: "test-bucket",
    publicUrl: "https://cdn.example.com/bucket",
    defaultExpiration: 600,
  };

  it("assembles a permanent public URL from publicUrl + key", () => {
    const storage = createS3Storage({ config: baseConfig });
    expect(storage.buildPublicUrl("avatars/u1/a.png")).toBe(
      "https://cdn.example.com/bucket/avatars/u1/a.png",
    );
  });

  it("percent-encodes reserved characters in public URL path segments", () => {
    const storage = createS3Storage({ config: baseConfig });
    expect(storage.buildPublicUrl("avatars/u1/face#1.jpg")).toBe(
      "https://cdn.example.com/bucket/avatars/u1/face%231.jpg",
    );
  });

  it("returns undefined public URL when publicUrl is not configured", () => {
    const { publicUrl: _omit, ...rest } = baseConfig;
    const storage = createS3Storage({ config: rest });
    expect(storage.buildPublicUrl("avatars/u1/a.png")).toBeUndefined();
  });

  it("presigns PUT with content type via the injected getSignedUrl seam", async () => {
    const getSignedUrl = vi.fn<GetSignedUrlFn>(async () =>
      "https://signed.example/put?X-Amz-Signature=abc",
    );
    const client = new S3Client({
      region: "us-east-1",
      credentials: { accessKeyId: "k", secretAccessKey: "s" },
    });
    const storage = createS3Storage({
      config: baseConfig,
      client,
      getSignedUrl,
    });

    const result = await storage.createSignedUrl({
      key: "attachments/u1/file.png",
      operation: "put",
      contentType: "image/png",
      expiresIn: 120,
    });

    expect(result.url).toContain("signed.example");
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(getSignedUrl).toHaveBeenCalledOnce();
    expect(getSignedUrl.mock.calls[0]?.[1]).toBeInstanceOf(PutObjectCommand);
    expect(getSignedUrl.mock.calls[0]?.[2]).toEqual({ expiresIn: 120 });
  });

  it("presigns GET via the injected getSignedUrl seam", async () => {
    const getSignedUrl = vi.fn<GetSignedUrlFn>(async () =>
      "https://signed.example/get?X-Amz-Signature=xyz",
    );
    const client = new S3Client({
      region: "us-east-1",
      credentials: { accessKeyId: "k", secretAccessKey: "s" },
    });
    const storage = createS3Storage({
      config: baseConfig,
      client,
      getSignedUrl,
    });

    const result = await storage.createSignedUrl({
      key: "avatars/u1/face.png",
      operation: "get",
    });

    expect(result.url).toContain("signed.example/get");
    expect(getSignedUrl.mock.calls[0]?.[1]).toBeInstanceOf(GetObjectCommand);
    expect(getSignedUrl.mock.calls[0]?.[2]).toEqual({ expiresIn: 600 });
  });

  it("fail-closes when required config fields are missing", () => {
    expect(() =>
      createS3Storage({
        config: {
          region: "",
          accessKeyId: "k",
          accessKeySecret: "s",
          bucket: "b",
        },
      }),
    ).toThrow(/region/i);
  });
});
