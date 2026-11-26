"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect } from "react";

import { isCLPublicId, isCLReference, type CL } from "@megaui/core";
import { MegaApiError, megaGet, megaQueryKeys } from "@megaui/ui/query";
import { CLFavoriteRedirectContext } from "@megaui/ui/shell";

const CLContext = createContext<CL | null>(null);
export const CLRouteProvider = CLContext.Provider;

export function useCurrentCL(): CL {
  const cl = useContext(CLContext);
  if (!cl) throw new Error("CL detail context is required");
  return cl;
}

export function useCLDetailRoute() {
  const params = useParams<{ lang: string; n: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const resolveFavorite = useContext(CLFavoriteRedirectContext);
  const queryClient = useQueryClient();
  const routeId = params?.n ?? "";
  const validRoute = isCLReference(routeId);
  const prefix = `/${params?.lang}/workspace/cls/`;
  const routeBase = prefix + routeId;
  const tab = pathname?.slice(routeBase.length).split("/")[1];
  const overview = tab !== "files";
  const keyForView = overview ? megaQueryKeys.clOverview : megaQueryKeys.cl;
  const detailKey = keyForView(routeId);

  const clQuery = useQuery({
    queryKey: detailKey,
    queryFn: () => megaGet<CL>(["cls", routeId], overview ? { view: "overview" } : undefined),
    enabled: validRoute && Boolean(pathname),
    staleTime: 10_000,
    retry: (count, error) => !(error instanceof MegaApiError && error.status === 404) && count < 2,
    refetchInterval: ({ state: { data } }) => {
      if (!overview || !data || data.state === "merged" || data.state === "closed") return false;
      return data.ci === "queued" || data.ci === "running" ? 3000 : 10000;
    },
  });
  const cl = clQuery.data;
  const baseHref = `${prefix}${cl?.publicId ?? routeId}`;

  useEffect(() => {
    if (!cl || !isCLPublicId(cl.publicId) || routeId === cl.publicId || !pathname) return;
    if (pathname !== routeBase && !pathname.startsWith(routeBase + "/")) return;
    const { pathname: currentPath, search, hash } = window.location;
    if (currentPath !== pathname) return;
    resolveFavorite?.(routeId, cl.publicId);
    queryClient.setQueryData(keyForView(cl.publicId), cl);
    router.replace(baseHref + pathname.slice(routeBase.length) + search + hash, { scroll: false });
  }, [baseHref, cl, keyForView, pathname, queryClient, resolveFavorite, routeBase, routeId, router]);

  return { clQuery, routeId, validRoute, baseHref, detailKey };
}
