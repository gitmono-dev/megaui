import { Skeleton } from "@megaui/ui";
import { WorkspaceShell } from "@megaui/ui/shell";

import styles from "./workspace-loading.module.css";

function LoadingRows({ count = 3 }: { count?: number }) {
  return Array.from({ length: count }, (_, index) => (
    <div className={styles.row} key={index}>
      <Skeleton className={styles.dot} />
      <div className={styles.lines}>
        <Skeleton className={styles.line} />
        <Skeleton className={styles.caption} />
      </div>
    </div>
  ));
}

export function WorkspaceLoading({ label, variant = "rows" }: {
  label: string;
  variant?: "page" | "detail" | "rows" | "files";
}) {
  const showHeader = variant === "page" || variant === "detail";
  return (
    <div className={styles.loading} data-loading-view={variant} role="status" aria-label={label}>
      <div aria-hidden="true">
        {showHeader && (
          <div className={styles.header}>
            <Skeleton className={styles.caption} />
            <Skeleton className={styles.title} />
            {variant === "detail" && <Skeleton className={styles.meta} />}
          </div>
        )}
        {variant === "detail" && (
          <div className={styles.tabs}>
            {[0, 1, 2, 3, 4].map(tab => <Skeleton className={styles.tab} key={tab} />)}
          </div>
        )}
        <div className={styles.panels}>
          {variant === "files" && <div className={styles.tree}><LoadingRows /></div>}
          <div className={styles.panel}><LoadingRows count={variant === "rows" ? 2 : 3} /></div>
        </div>
      </div>
    </div>
  );
}

export function WorkspaceSessionLoading({ label }: { label: string }) {
  const rail = (
    <div aria-hidden="true" className={styles.rail} data-mega-shell="workspace-rail">
      <Skeleton className={styles.search} />
      <LoadingRows count={7} />
    </div>
  );
  return (
    <WorkspaceShell rail={rail}>
      <main aria-busy="true" data-mega-shell="session-loading">
        <WorkspaceLoading label={label} variant="page" />
      </main>
    </WorkspaceShell>
  );
}
