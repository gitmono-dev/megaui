/**
 * WA-19 upload contract tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "../../app/api/upload/route";
import {
  assertUploadKeyOwned,
  setUploadStorageForTests,
  uploadUserObject,
} from "../../lib/upload";

vi.mock("@/lib/auth", () => ({
  getAuth: () => ({
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const cookie = headers.get("cookie") ?? "";
        if (!cookie.includes("session=ok")) return null;
        return {
          user: { id: "user_a", email: "a@example.com" },
          session: { id: "upload-session" },
        };
      },
    },
  }),
}));

function authedRequest(body: FormData, purpose?: string): Request {
  const url = purpose
    ? `http://127.0.0.1:3000/api/upload?purpose=${purpose}`
    : "http://127.0.0.1:3000/api/upload";
  return new Request(url, {
    method: "POST",
    headers: { cookie: "session=ok" },
    body,
  });
}

describe("WA-19 /api/upload contract", () => {
  const putObject = vi.fn(async () => undefined);
  const deleteObject = vi.fn(async () => undefined);
  const buildPublicUrl = vi.fn((key: string) => `https://cdn.example/${key}`);

  beforeEach(() => {
    putObject.mockReset();
    deleteObject.mockReset();
    buildPublicUrl.mockClear();
    putObject.mockResolvedValue(undefined);
    deleteObject.mockResolvedValue(undefined);
    setUploadStorageForTests({ putObject, deleteObject, buildPublicUrl });
  });

  it("returns 401 when unauthenticated", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
    const response = await POST(
      new Request("http://127.0.0.1:3000/api/upload", { method: "POST", body: form }),
    );
    expect(response.status).toBe(401);
  });

  it("returns 413 when avatar exceeds 1MB", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array(1 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }),
    );
    const response = await POST(authedRequest(form, "avatar"));
    expect(response.status).toBe(413);
    const json = (await response.json()) as { error: { code: string } };
    expect(json.error.code).toBe("UPLOAD_FILE_TOO_LARGE");
  });

  it("returns 415 for illegal attachment MIME", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array([1])], "notes.txt", { type: "text/plain" }),
    );
    const response = await POST(authedRequest(form, "attachment"));
    expect(response.status).toBe(415);
    const json = (await response.json()) as { error: { code: string } };
    expect(json.error.code).toBe("UPLOAD_INVALID_TYPE");
  });

  it("returns public URL on success", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array([9, 9, 9])], "avatar.png", { type: "image/png" }),
    );
    const response = await POST(authedRequest(form, "avatar"));
    expect(response.status).toBe(200);
    const json = (await response.json()) as { data: { url: string; key: string } };
    expect(json.data.url).toMatch(/^https:\/\/cdn\.example\/avatars\/user_a\//);
    expect(json.data.key.startsWith("avatars/user_a/")).toBe(true);
    expect(putObject).toHaveBeenCalledOnce();
  });

  it("rejects cross-user key ownership (GC-07)", () => {
    expect(() =>
      assertUploadKeyOwned("user_a", "avatar", "avatars/user_b/evil.png"),
    ).toThrow(/owned prefix/);
  });

  it("deletes the object when putObject fails (GC-08)", async () => {
    putObject.mockRejectedValueOnce(new Error("s3 down"));
    await expect(
      uploadUserObject({
        userId: "user_a",
        purpose: "avatar",
        fileName: "x.png",
        mimeType: "image/png",
        body: new Uint8Array([1]),
      }),
    ).rejects.toThrow(/s3 down/);
    expect(deleteObject).toHaveBeenCalledOnce();
  });
});
