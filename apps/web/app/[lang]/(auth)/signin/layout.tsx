// megaui-only: page metadata for the sign-in route.
import type { ReactNode } from "react";

import { authPageMetadata } from "@/lib/auth-page-metadata";

export const generateMetadata = authPageMetadata("signin");

export default function SigninLayout({ children }: { children: ReactNode }) {
  return children;
}
