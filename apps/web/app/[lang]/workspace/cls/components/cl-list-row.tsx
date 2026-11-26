import Link from "next/link";
import {
  CircleCheck, CircleDashed, CircleMinus, CircleX, Clock3, Folder,
  GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, TriangleAlert,
} from "lucide-react";
import type { CL } from "@megaui/core";

import { useTranslation } from "@/hooks/use-translation";
import styles from "../cl-list.module.css";

const stateIcons = {
  ready: GitPullRequest, wip: GitPullRequestDraft, queued: Clock3,
  conflicts: TriangleAlert, merged: GitMerge, closed: GitPullRequestClosed,
};
const ciIcons = {
  passing: CircleCheck, failing: CircleX, queued: Clock3, running: CircleDashed, skipped: CircleMinus,
};

export function CLListRow({ cl, dateFormat }: { cl: CL; dateFormat: Intl.DateTimeFormat }) {
  const { locale, t } = useTranslation();
  const text = t.workspace.clsList.row;
  const StateIcon = stateIcons[cl.state];
  const CiIcon = ciIcons[cl.ci];
  const author = cl.author.displayName || cl.author.username;

  return (
    <li className={styles.row} data-mega-cls="row">
      <StateIcon className={styles.stateIcon} data-state={cl.state} aria-hidden="true" />
      <div className={styles.rowBody}>
        <Link className={styles.title} href={`/${locale}/workspace/cls/${cl.number}`}>
          {cl.title}
        </Link>
        <div className={styles.meta}>
          <span>!{cl.number}</span>
          <span>{text.states[cl.state]}</span>
          <span className={styles.author} title={author}>{author}</span>
          <time dateTime={cl.createdAt}>{text.openedOn.replace("{date}", dateFormat.format(new Date(cl.createdAt)))}</time>
          <span className={styles.repo}><Folder size={13} aria-hidden="true" />{cl.packageId}</span>
        </div>
      </div>
      <span className={styles.ci} data-ci={cl.ci} data-mega-cls="row-ci">
        <CiIcon size={14} aria-hidden="true" />
        CI · {text.ci[cl.ci]}
      </span>
      {(cl.additions > 0 || cl.deletions > 0) && (
        <span className={styles.stats}>
          <span data-kind="add">+{cl.additions}</span>
          <span data-kind="delete">−{cl.deletions}</span>
        </span>
      )}
    </li>
  );
}
