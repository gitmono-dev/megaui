// megaui-only: page metadata for the forgot-password route.
//
// The dictionary names this page `forgotPassword` under `auth.metadata`, but
// `forgetPassword` under the form copy (`auth.forgetPassword`); both spellings
// are existing keys, so this layout uses the metadata one.
import type { ReactNode } from "react";

import { authPageMetadata } from "@/lib/auth-page-metadata";

export const generateMetadata = authPageMetadata("forgotPassword");

export default function ForgotPasswordLayout({ children }: { children: ReactNode }) {
  return children;
}
