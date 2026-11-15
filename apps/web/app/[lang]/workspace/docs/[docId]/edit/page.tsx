// megaui-only (RO-01 / ADR-RO-01): /edit is a bookmark-compatible redirect
// onto the single writable doc page. Do not remount MegaContentEditor here.
// Full-document replace (not App Router client navigation): this route sits
// under WorkspaceShellClient, and both server `redirect()` and `router.replace`
// surface the Next "This page couldn’t load" overlay in the Playwright
// standalone server. window.location.replace matches a bookmark hit.
"use client";

import { useParams } from "next/navigation";
import { useEffect } from "react";

export default function DocEditRedirectPage() {
  const params = useParams<{ lang: string; docId: string }>();
  const lang = params?.lang;
  const docId = params?.docId;

  useEffect(() => {
    if (!lang || !docId) return;
    const decodedId = decodeURIComponent(docId);
    window.location.replace(`/${lang}/workspace/docs/${encodeURIComponent(decodedId)}`);
  }, [docId, lang]);

  return <main aria-busy="true" />;
}
