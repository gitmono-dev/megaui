// megaui-only: page metadata for the sign-up route.
import type { ReactNode } from "react";

import { authPageMetadata } from "@/lib/auth-page-metadata";

export const generateMetadata = authPageMetadata("signup");

export default function SignupLayout({ children }: { children: ReactNode }) {
  return children;
}
