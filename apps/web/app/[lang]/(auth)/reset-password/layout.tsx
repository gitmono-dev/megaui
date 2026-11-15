// megaui-only: page metadata for the reset-password route.
import type { ReactNode } from "react";

import { authPageMetadata } from "@/lib/auth-page-metadata";

export const generateMetadata = authPageMetadata("resetPassword");

export default function ResetPasswordLayout({ children }: { children: ReactNode }) {
  return children;
}
