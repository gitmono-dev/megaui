"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { megaGet } from "@megaui/ui/query";
import { useTranslation } from "@/hooks/use-translation";

interface CatalogPage { items: string[]; next: string | null }

export default function ImagesPage() {
  const { t } = useTranslation();
  const text = t.workspace.images;
  const [search, setSearch] = useState("");
  const [repository, setRepository] = useState<string | null>(null);
  const catalog = useInfiniteQuery({
    queryKey: ["mega", "images", repository, repository ? "" : search],
    initialPageParam: "",
    queryFn: ({ pageParam }) => megaGet<CatalogPage>(repository ? ["images", "tags"] : ["images"], { ...(repository ? { repository } : { q: search }), ...(pageParam ? { after: pageParam } : {}) }),
    getNextPageParam: page => page.next ?? undefined,
  });
  const items = useMemo(() => (catalog.data?.pages.flatMap(page => page.items) ?? []).filter(name => !repository || name.toLocaleLowerCase().includes(search.toLocaleLowerCase())), [catalog.data, repository, search]);
  return <main data-mega-images="page" style={{ padding: "var(--mega-page-gutter)" }}>
    {repository ? <button type="button" onClick={() => { setRepository(null); setSearch(""); }}>{text.back}</button> : null}
    <h1>{repository ?? text.title}</h1><p style={{ color: "var(--mega-muted)" }}>{repository ? text.tags : text.description}</p>
    <input aria-label={repository ? text.searchTags : text.search} placeholder={repository ? text.searchTags : text.search} value={search} onChange={event => setSearch(event.target.value)} style={{ width: "100%", margin: "20px 0", padding: 10, border: "1px solid var(--mega-border)", borderRadius: 6, background: "var(--mega-bg)" }} />
    {catalog.isPending ? <p aria-busy="true">{text.loading}</p> : catalog.isError ? <div role="alert"><p>{text.unavailable}</p><button type="button" onClick={() => void catalog.refetch()}>{text.retry}</button></div> : items.length ? <div style={{ border: "1px solid var(--mega-border)", borderRadius: 6, background: "var(--mega-bg)" }}>{items.map(name => <div key={name} style={{ padding: "16px 20px", borderBottom: "1px solid var(--mega-border)", overflowWrap: "anywhere" }}>{repository ? <strong>{name}</strong> : <button type="button" onClick={() => { setRepository(name); setSearch(""); }} style={{ border: 0, padding: 0, background: "transparent", color: "var(--mega-accent)", cursor: "pointer", font: "inherit", fontWeight: 600 }}>{name}</button>}</div>)}</div> : <p>{repository ? text.noTags : text.empty}</p>}
    {catalog.hasNextPage ? <button type="button" disabled={catalog.isFetchingNextPage} onClick={() => void catalog.fetchNextPage()}>{text.more}</button> : null}
  </main>;
}
