import { handleInternalNotificationEmail } from "@/lib/internal/notifications-email";

/**
 * Internal product-notification email API for mega2.
 * Auth: Authorization Bearer (MEGA2_INTERNAL_MAIL_BEARER). Not Better Auth.
 */
export async function POST(request: Request): Promise<Response> {
  return handleInternalNotificationEmail(request);
}
