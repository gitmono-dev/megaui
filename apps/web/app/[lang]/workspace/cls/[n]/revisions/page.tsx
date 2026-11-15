// megaui-only (WA-10): lean revisions page — cards + compare link + commits.
"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import type { CL } from "@megaui/core";
import { MegaApiError, megaGet, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";

interface ClCommit {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
}

export default function CLRevisionsPage() {
  const params = useParams<{ n: string }>();
  const { locale, t } = useTranslation();
  const revisionsText = t.workspace.clDetail.revisions;
  const clNumber = Number(params?.n);
  const [fromRev, setFromRev] = useState<number | "">("");
  const [toRev, setToRev] = useState<number | "">("");

  const clQuery = useQuery({
    queryKey: megaQueryKeys.cl(clNumber),
    queryFn: () => megaGet<CL>(["cls", String(clNumber)]),
    enabled: Number.isInteger(clNumber) && clNumber > 0,
    retry: (count, error) => !(error instanceof MegaApiError && error.status === 404) && count < 2,
  });

  const commitsQuery = useQuery({
    queryKey: megaQueryKeys.clCommits(clNumber),
    queryFn: () => megaGet<ClCommit[]>(["cls", String(clNumber), "commits"]),
    enabled: Number.isInteger(clNumber) && clNumber > 0 && clQuery.isSuccess,
    retry: (count, error) => !(error instanceof MegaApiError && error.status === 404) && count < 2,
  });

  const revisions = clQuery.data?.revisions ?? [];
  const compareHref = useMemo(() => {
    if (fromRev === "" || toRev === "" || fromRev >= toRev) return null;
    return `/${locale}/workspace/cls/${clNumber}/files?range=${fromRev}..${toRev}`;
  }, [clNumber, fromRev, locale, toRev]);

  if (clQuery.isPending) {
    return (
      <section aria-busy="true" data-mega-cls="revisions">
        <p>{revisionsText.loading}</p>
      </section>
    );
  }

  if (clQuery.isError) {
    return (
      <section data-mega-cls="revisions">
        <div role="alert" style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
          <p style={{ margin: 0 }}>{revisionsText.error}</p>
          <button data-mega-cls="retry" onClick={() => void clQuery.refetch()} type="button">
            {revisionsText.retry}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section data-mega-cls="revisions" style={{ display: "grid", gap: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}>
      {revisions.length === 0 ? (
        <p data-mega-cls="revisions-empty">{revisionsText.empty}</p>
      ) : (
        <>
          <div
            data-mega-cls="compare-bar"
            style={{
              alignItems: "center",
              border: `1px solid ${MEGA_TOKENS.border}`,
              borderRadius: MEGA_RADIUS_TOKENS.md,
              display: "flex",
              flexWrap: "wrap",
              gap: MEGA_SPACING_TOKENS[8],
              padding: MEGA_SPACING_TOKENS[8],
            }}
          >
            <span>{revisionsText.compareBar.compare}</span>
            <label>
              {revisionsText.compareBar.fromAriaLabel}
              <select
                aria-label={revisionsText.compareBar.fromAriaLabel}
                data-mega-cls="compare-from"
                onChange={(event) => setFromRev(event.target.value ? Number(event.target.value) : "")}
                value={fromRev === "" ? "" : String(fromRev)}
              >
                <option value="">—</option>
                {revisions.map((rev) => (
                  <option key={rev.id} value={rev.number}>
                    {revisionsText.compareBar.revChip.replace("{rev}", String(rev.number))}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {revisionsText.compareBar.toAriaLabel}
              <select
                aria-label={revisionsText.compareBar.toAriaLabel}
                data-mega-cls="compare-to"
                onChange={(event) => setToRev(event.target.value ? Number(event.target.value) : "")}
                value={toRev === "" ? "" : String(toRev)}
              >
                <option value="">—</option>
                {revisions.map((rev) => (
                  <option key={rev.id} value={rev.number}>
                    {revisionsText.compareBar.revChip.replace("{rev}", String(rev.number))}
                  </option>
                ))}
              </select>
            </label>
            {compareHref ? (
              <Link data-mega-cls="view-range-diff" href={compareHref}>
                {revisionsText.compareBar.viewRangeDiff}
              </Link>
            ) : null}
          </div>

          <ul data-mega-cls="revision-list" style={{ display: "grid", gap: MEGA_SPACING_TOKENS[8], listStyle: "none", margin: 0, padding: 0 }}>
            {revisions.map((rev, index) => (
              <li
                data-mega-cls="revision-card"
                key={rev.id}
                style={{
                  border: `1px solid ${MEGA_TOKENS.border}`,
                  borderRadius: MEGA_RADIUS_TOKENS.md,
                  padding: MEGA_SPACING_TOKENS[8],
                }}
              >
                <strong>{revisionsText.card.title.replace("{rev}", String(rev.number))}</strong>
                {index === revisions.length - 1 ? (
                  <span data-mega-cls="revision-current" style={{ color: MEGA_TOKENS.accent, marginLeft: MEGA_SPACING_TOKENS[6] }}>
                    {revisionsText.card.current}
                  </span>
                ) : null}
                {rev.forcePushed ? (
                  <span style={{ color: MEGA_TOKENS.warning, marginLeft: MEGA_SPACING_TOKENS[6] }}>
                    {revisionsText.card.forcePush}
                  </span>
                ) : null}
                <p style={{ color: MEGA_TOKENS.muted, margin: `${MEGA_SPACING_TOKENS[6]} 0 0` }}>
                  {rev.summary} · {revisionsText.card.commits.replace("{count}", String(rev.commitList.length))} ·{" "}
                  {revisionsText.card.ci.replace(
                    "{status}",
                    revisionsText.card.ciStatuses[rev.ci] ?? rev.ci,
                  )}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}

      <section data-mega-cls="cl-commits">
        <h2 style={{ fontSize: "1rem", fontWeight: 700, margin: 0 }}>{revisionsText.clCommits.title}</h2>
        {commitsQuery.isPending ? <p>{revisionsText.clCommits.loading}</p> : null}
        {commitsQuery.isError ? (
          <div role="alert" style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
            <p style={{ margin: 0 }}>{revisionsText.clCommits.error}</p>
            <button data-mega-cls="retry" onClick={() => void commitsQuery.refetch()} type="button">
              {revisionsText.clCommits.retry}
            </button>
          </div>
        ) : null}
        {commitsQuery.isSuccess && commitsQuery.data.length === 0 ? (
          <p data-mega-cls="commits-empty">{revisionsText.clCommits.empty}</p>
        ) : null}
        {commitsQuery.isSuccess && commitsQuery.data.length > 0 ? (
          <ul data-mega-cls="commits-list" style={{ listStyle: "none", margin: `${MEGA_SPACING_TOKENS[8]} 0 0`, padding: 0 }}>
            {commitsQuery.data.map((commit) => (
              <li data-mega-cls="commit-row" key={commit.sha} style={{ fontFamily: MEGA_TOKENS.fontMono, padding: `${MEGA_SPACING_TOKENS[4]} 0` }}>
                <code>{commit.sha.slice(0, 7)}</code> {commit.message}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </section>
  );
}
