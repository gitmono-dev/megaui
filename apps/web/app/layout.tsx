import type { ReactNode } from "react";

import "./globals.css";

/**
 * Root layout passthrough — html/body live in `app/[lang]/layout.tsx`
 * so `lang` can be set per locale (Next.js i18n pattern).
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
