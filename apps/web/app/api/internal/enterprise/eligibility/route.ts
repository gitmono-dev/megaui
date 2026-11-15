import { handleEnterpriseIntrospection } from "@/lib/enterprise-introspection";

export async function POST(request: Request): Promise<Response> {
  return handleEnterpriseIntrospection(request);
}

export async function GET(): Promise<Response> {
  return Response.json({ error: { code: "METHOD_NOT_ALLOWED" } }, { status: 405 });
}
