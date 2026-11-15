// megaui-only (WA-19): authenticated upload endpoint (S3 via @megaui/storage).

import { NextResponse } from "next/server";

import { resolveWebActor } from "@/lib/enterprise-session";
import {
  mapUploadErrorStatus,
  uploadUserObject,
  type UploadPurpose,
} from "@/lib/upload";

export const runtime = "nodejs";

function parsePurpose(value: string | null): UploadPurpose | null {
  if (value === null || value === "attachment") return "attachment";
  if (value === "avatar") return "avatar";
  return null;
}

export async function POST(request: Request): Promise<Response> {
  const actor = await resolveWebActor(request.headers);
  if (!actor) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      { status: 401 },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: { code: "UPLOAD_NO_FILE", message: "Invalid multipart body" } },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: { code: "UPLOAD_NO_FILE", message: "file is required" } },
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  const purpose = parsePurpose(
    url.searchParams.get("purpose") ??
      (typeof formData.get("purpose") === "string" ? String(formData.get("purpose")) : null),
  );
  if (!purpose) {
    return NextResponse.json(
      { error: { code: "INVALID_PURPOSE", message: "purpose must be avatar or attachment" } },
      { status: 400 },
    );
  }

  try {
    const body = new Uint8Array(await file.arrayBuffer());
    const result = await uploadUserObject({
      userId: actor.userId,
      purpose,
      fileName: file.name || "upload.bin",
      mimeType: file.type || "application/octet-stream",
      body,
    });
    return NextResponse.json({ data: result });
  } catch (error) {
    const mapped = mapUploadErrorStatus(error);
    return NextResponse.json(
      { error: { code: mapped.code, message: mapped.message } },
      { status: mapped.status },
    );
  }
}
