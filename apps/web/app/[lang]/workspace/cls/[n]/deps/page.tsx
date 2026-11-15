// megaui-only (WA-10): lean deps page — dynamic xyflow graph + related panels.
"use client";

import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import type { ApiChange, DepEdge, DepNode, RelatedCL, SymbolUsage } from "@megaui/core";
import { MegaApiError, megaGet, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";

const DepGraph = dynamic(() => import("../components/dep-graph"), { ssr: false });

interface DependencyGraphView {
  nodes: readonly DepNode[];
  edges: readonly DepEdge[];
  apiChanges: readonly ApiChange[];
  relatedCLs: readonly RelatedCL[];
  symbolUsage: readonly SymbolUsage[];
  cycles: readonly (readonly string[])[];
}

export default function CLDepsPage() {
  const params = useParams<{ n: string }>();
  const { t } = useTranslation();
  const depsText = t.workspace.clDetail.deps;
  const clNumber = Number(params?.n);

  const depsQuery = useQuery({
    queryKey: megaQueryKeys.clDependencyGraph(clNumber),
    queryFn: () => megaGet<DependencyGraphView>(["cls", String(clNumber), "dependency-graph"]),
    enabled: Number.isInteger(clNumber) && clNumber > 0,
    retry: (count, error) => !(error instanceof MegaApiError && error.status === 404) && count < 2,
  });

  if (depsQuery.isPending) {
    return (
      <section aria-busy="true" data-mega-cls="deps">
        <p>{depsText.loading}</p>
      </section>
    );
  }

  if (depsQuery.isError) {
    return (
      <section data-mega-cls="deps">
        <div role="alert" style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
          <p style={{ margin: 0 }}>{depsText.error}</p>
          <button data-mega-cls="retry" onClick={() => void depsQuery.refetch()} type="button">
            {depsText.retry}
          </button>
        </div>
      </section>
    );
  }

  const view = depsQuery.data;

  return (
    <section data-mega-cls="deps" style={{ display: "grid", gap: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}>
      {view.nodes.length === 0 ? (
        <p data-mega-cls="deps-empty" style={{ color: MEGA_TOKENS.muted }}>
          {depsText.graph.title}: —
        </p>
      ) : (
        <DepGraph edges={view.edges} labels={depsText.graph} nodes={view.nodes} />
      )}

      <section
        data-mega-cls="api-diff"
        style={{ border: `1px solid ${MEGA_TOKENS.border}`, borderRadius: MEGA_RADIUS_TOKENS.md, padding: MEGA_SPACING_TOKENS[8] }}
      >
        <h2 style={{ fontSize: "1rem", fontWeight: 700, margin: 0 }}>{depsText.api.title}</h2>
        {view.apiChanges.length === 0 ? (
          <p style={{ color: MEGA_TOKENS.muted }}>—</p>
        ) : (
          <ul style={{ margin: `${MEGA_SPACING_TOKENS[6]} 0 0`, paddingLeft: MEGA_SPACING_TOKENS[8] }}>
            {view.apiChanges.map((change) => (
              <li data-mega-cls="api-change" key={change.id}>
                [{change.kind}] {change.text}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        data-mega-cls="related-cls"
        style={{ border: `1px solid ${MEGA_TOKENS.border}`, borderRadius: MEGA_RADIUS_TOKENS.md, padding: MEGA_SPACING_TOKENS[8] }}
      >
        <h2 style={{ fontSize: "1rem", fontWeight: 700, margin: 0 }}>{depsText.related.title}</h2>
        {view.relatedCLs.length === 0 ? (
          <p style={{ color: MEGA_TOKENS.muted }}>—</p>
        ) : (
          <ul style={{ margin: `${MEGA_SPACING_TOKENS[6]} 0 0`, paddingLeft: MEGA_SPACING_TOKENS[8] }}>
            {view.relatedCLs.map((related) => (
              <li data-mega-cls="related-cl" key={related.id}>
                {depsText.related.relations[related.relation]} !{related.number}
                {related.note ? ` — ${related.note}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        data-mega-cls="symbol-usage"
        style={{ border: `1px solid ${MEGA_TOKENS.border}`, borderRadius: MEGA_RADIUS_TOKENS.md, padding: MEGA_SPACING_TOKENS[8] }}
      >
        <h2 style={{ fontSize: "1rem", fontWeight: 700, margin: 0 }}>{depsText.symbols.title}</h2>
        {view.symbolUsage.length === 0 ? (
          <p style={{ color: MEGA_TOKENS.muted }}>—</p>
        ) : (
          <ul style={{ margin: `${MEGA_SPACING_TOKENS[6]} 0 0`, paddingLeft: MEGA_SPACING_TOKENS[8] }}>
            {view.symbolUsage.map((symbol) => (
              <li data-mega-cls="symbol-row" key={symbol.id}>
                {symbol.symbol} ·{" "}
                {depsText.symbols.refs
                  .replace("{refs}", String(symbol.refs))
                  .replace("{files}", String(symbol.files))}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
