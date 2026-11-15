// megaui:apps/next-app/app/[lang]/auth/layout.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-02):
// - `<Logo>` replaced with a plain text brand mark — `packages/ui` does not
//   export a `Logo` component (apps/web owns its own brand assets).
// - Uses the shared document-page surface, with a centered auth card.

import Link from "next/link";
import { use } from "react";

export default function AuthLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = use(params);

  return (
    <main data-mega-surface="auth" className="flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Link
          href={`/${lang}`}
          className="self-center text-lg font-semibold tracking-tight"
        >
          Mega
        </Link>
        {children}
      </div>
    </main>
  );
}
