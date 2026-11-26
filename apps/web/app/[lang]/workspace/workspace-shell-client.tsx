// megaui:apps/next-app/app/[lang]/workspace/workspace-shell-client.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-07):
// - Wires `@megaui/ui/shell` composition (rail + palette as props).
// - Palette maps BFF search hits to PaletteResultGroup[].
// - SEARCH_CJK_SCALE_EXCEEDED sets palette labels.error to the i18n key text.
"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import type { Channel, CL } from "@megaui/core";
import { isOpenCLState } from "@megaui/core";
import { megaGet, megaQueryKeys, MegaApiError } from "@megaui/ui/query";
import {
  deriveFavorite,
  getInitials,
  MEGA_COMMAND_OPEN_EVENT,
  useFavorites,
  WorkspaceRail,
  WorkspaceShellClient as UiWorkspaceShellClient,
  type PaletteResultGroup,
  type PaletteSearchState,
  type RailChannel,
  type WorkspaceRailCountsProps,
  type WorkspaceRailLinkProps,
} from "@megaui/ui/shell";

import { accountAvatarName } from "@/app/[lang]/workspace/account-avatar-name";
import { AccountMenu } from "@/app/[lang]/workspace/account-menu";
import { useTranslation } from "@/hooks/use-translation";
import { authClient } from "@/lib/auth-client";
import { selfDisplayName } from "@/lib/self-display-name";
import type { WorkspaceSearchResults } from "@/lib/adapter/search-workspace";

interface UnreadCountResponse {
  count: number;
}

export function sessionDisplayName(
  name: string | null | undefined,
  email: string | null | undefined,
  fallback: string,
): string {
  const normalizedName = name?.trim();
  if (normalizedName) return normalizedName;
  const emailLocalPart = email?.split("@", 1)[0]?.trim();
  return emailLocalPart || fallback;
}

function NextWorkspaceLink({ children, href, ...props }: WorkspaceRailLinkProps) {
  return (
    <Link {...props} href={href} prefetch>
      {children}
    </Link>
  );
}

function renderWorkspaceLink(props: WorkspaceRailLinkProps) {
  return <NextWorkspaceLink {...props} />;
}

function mapSearchToGroups(
  data: WorkspaceSearchResults,
  workspaceBase: string,
  groupLabels: { issues: string; cls: string; docs: string },
): PaletteResultGroup[] {
  const groups: PaletteResultGroup[] = [];
  if (data.issues.length > 0) {
    groups.push({
      heading: groupLabels.issues,
      items: data.issues.map((issue) => ({
        key: `issue-${issue.id}`,
        href: `${workspaceBase}/issues/${issue.number}`,
        icon: "bug" as const,
        label: `#${issue.number} ${issue.title}`,
        value: `issue-${issue.number}`,
      })),
    });
  }
  if (data.cls.length > 0) {
    groups.push({
      heading: groupLabels.cls,
      items: data.cls.map((cl) => ({
        key: `cl-${cl.id}`,
        href: `${workspaceBase}/cls/${cl.publicId}`,
        icon: "git-pull" as const,
        label: `${cl.publicId} ${cl.title}`,
        value: `cl-${cl.publicId}`,
      })),
    });
  }
  if (data.docs.length > 0) {
    groups.push({
      heading: groupLabels.docs,
      items: data.docs.map((doc) => ({
        key: `doc-${doc.id}`,
        href: `${workspaceBase}/docs/${doc.id}`,
        icon: "file" as const,
        label: doc.title,
        value: `doc-${doc.id}`,
      })),
    });
  }
  return groups;
}

const searchErrorListeners = new Set<(code: string | null) => void>();

function notifySearchError(code: string | null): void {
  for (const listener of searchErrorListeners) listener(code);
}

function useWorkspaceSearchResults(query: string): PaletteSearchState {
  const { locale, t } = useTranslation();
  const workspaceBase = `/${locale}/workspace`;
  const enabled = query.length > 0;
  const searchQuery = useQuery({
    queryKey: megaQueryKeys.search(query),
    queryFn: async () => {
      const params = new URLSearchParams({ q: query });
      const response = await fetch(`/api/mega/search?${params.toString()}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const payload: unknown = await response.json().catch(() => undefined);
      const code =
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        payload.error &&
        typeof payload.error === "object" &&
        "code" in payload.error
          ? String((payload.error as { code: unknown }).code)
          : null;
      if (code === "SEARCH_CJK_SCALE_EXCEEDED") {
        notifySearchError(code);
        throw new MegaApiError(503, code, t.errors.search.cjkScaleExceeded);
      }
      notifySearchError(null);
      if (!response.ok) {
        throw new MegaApiError(response.status, code ?? "MEGA_REQUEST_FAILED", "Search failed");
      }
      if (
        !payload ||
        typeof payload !== "object" ||
        !("data" in payload)
      ) {
        throw new MegaApiError(response.status, "MEGA_INVALID_RESPONSE", "Search failed");
      }
      return (payload as { data: WorkspaceSearchResults }).data;
    },
    enabled,
    retry: false,
  });

  if (!enabled) return { state: "idle" };
  if (searchQuery.isPending) return { state: "loading" };
  if (searchQuery.isError) return { state: "error" };
  return {
    state: "success",
    groups: mapSearchToGroups(searchQuery.data, workspaceBase, {
      issues: t.workspace.palette.groups.issues,
      cls: t.workspace.palette.groups.cls,
      docs: t.workspace.palette.groups.docs,
    }),
  };
}

function toRailChannels(channels: readonly Channel[]): RailChannel[] {
  return channels.map((channel) => {
    if (channel.kind === "dm") {
      return {
        kind: "dm" as const,
        id: channel.id,
        name: channel.name,
        unreadCount: channel.unreadCount,
        mentionCount: channel.mentionCount,
        participant: {
          username: channel.participant.username,
          displayName: channel.participant.displayName,
          avatarUrl: channel.participant.avatarUrl,
          avatarInitials: channel.participant.avatarInitials,
        },
      };
    }
    return {
      kind: "channel" as const,
      id: channel.id,
      name: channel.name,
      unreadCount: channel.unreadCount,
      mentionCount: channel.mentionCount,
    };
  });
}

export function WorkspaceShellClient({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const { locale, t } = useTranslation();
  const { data: session, isPending: userLoading } = authClient.useSession();
  const workspaceBase = `/${locale}/workspace`;
  const [searchErrorCode, setSearchErrorCode] = useState<string | null>(null);

  useEffect(() => {
    searchErrorListeners.add(setSearchErrorCode);
    return () => {
      searchErrorListeners.delete(setSearchErrorCode);
    };
  }, []);

  const sessionReady = !userLoading;
  const isAuthenticated = Boolean(session?.user);
  const railQueriesEnabled = sessionReady && isAuthenticated;

  const inboxQuery = useQuery({
    queryKey: megaQueryKeys.notificationUnreadCount(),
    queryFn: () => megaGet<UnreadCountResponse>(["notifications", "unread-count"]),
    enabled: railQueriesEnabled,
  });
  const clsQuery = useQuery({
    queryKey: megaQueryKeys.cls(),
    queryFn: () => megaGet<CL[]>("cls"),
    enabled: railQueriesEnabled,
  });
  const { favorites, toggle, remove } = useFavorites(clsQuery.data);
  const channelsQuery = useQuery({
    queryKey: megaQueryKeys.channels(),
    queryFn: () => megaGet<Channel[]>("channels"),
    enabled: railQueriesEnabled,
  });
  const profilePrefsQuery = useQuery({
    queryKey: ["mega", "profile-prefs"],
    queryFn: () => megaGet<{ username?: string }>("profile-prefs"),
    enabled: railQueriesEnabled,
  });

  const countsProps: WorkspaceRailCountsProps =
    inboxQuery.isPending || clsQuery.isPending
      ? { countsState: "loading" }
      : inboxQuery.isError || clsQuery.isError
        ? {
            countsState: "error",
            onCountsRetry: () => {
              if (inboxQuery.isError) void inboxQuery.refetch();
              if (clsQuery.isError) void clsQuery.refetch();
            },
          }
        : {
            countsState: "success",
            inboxUnreadCount: inboxQuery.data?.count ?? 0,
            openClCount: (clsQuery.data ?? []).filter((cl) => isOpenCLState(cl.state)).length,
          };

  const nav = t.workspace.nav;
  const palette = t.workspace.palette;
  // FSL-182: the own name is read only through `selfDisplayName` (Feishu projection
  // `displayName`, legacy `name`); the formatting and fallback are unchanged.
  const displayName = sessionDisplayName(
    selfDisplayName(session?.user),
    undefined,
    profilePrefsQuery.data?.username ?? nav.currentUser,
  );
  const favorite = deriveFavorite(pathname, workspaceBase, nav.items);
  const favoriteActive = favorite
    ? favorites.some((entry) => entry.href === favorite.href)
    : false;

  const onSearch = useCallback(() => {
    window.dispatchEvent(new Event(MEGA_COMMAND_OPEN_EVENT));
  }, []);

  const railCommon = {
    ...countsProps,
    currentUser: {
      displayName,
      imageUrl: session?.user?.image,
      initials: getInitials(displayName),
    },
    favoriteActive,
    favorites,
    labels: {
      addChannel: nav.addChannel,
      addChat: nav.addChat,
      addFavorite: nav.addFavorite,
      ariaLabel: nav.ariaLabel,
      channels: nav.channels,
      chat: nav.chat,
      countsError: nav.countsError,
      currentUser: nav.currentUser,
      openProfile: nav.openProfile,
      favorites: nav.favorites,
      favoritesEmpty: nav.favoritesEmpty,
      removeFavorite: nav.removeFavorite,
      items: nav.items,
      loadError: nav.loadError,
      loading: nav.loading,
      mentions: nav.mentions,
      newChannel: nav.newChannel,
      newChat: nav.newChat,
      noChannels: nav.noChannels,
      noChats: nav.noChats,
      openChangeLists: nav.openChangeLists,
      presence: nav.presence,
      retry: nav.retry,
      search: nav.search,
      searchAriaLabel: nav.searchAriaLabel,
      unread: nav.unread,
      userLoading: nav.userLoading,
    },
    onRemoveFavorite: remove,
    onSearch,
    onToggleFavorite: favorite ? () => toggle(favorite) : undefined,
    pathname,
    renderLink: renderWorkspaceLink,
    userLoading,
    workspaceBase,
    accountMenu: userLoading ? undefined : (
      <AccountMenu
        displayName={displayName}
        imageUrl={session?.user?.image}
        initials={accountAvatarName(displayName)}
        settingsHref={`${workspaceBase}/settings`}
      />
    ),
  };

  const rail = channelsQuery.isPending ? (
    <WorkspaceRail {...railCommon} channelsState="loading" />
  ) : channelsQuery.isError ? (
    <WorkspaceRail
      {...railCommon}
      channelsState="error"
      onRetry={() => void channelsQuery.refetch()}
    />
  ) : (
    <WorkspaceRail
      {...railCommon}
      channels={toRailChannels(channelsQuery.data ?? [])}
      channelsState="success"
    />
  );

  const paletteError =
    searchErrorCode === "SEARCH_CJK_SCALE_EXCEEDED"
      ? t.errors.search.cjkScaleExceeded
      : palette.error;

  // Wait for Better Auth session resolution before mounting SessionGuard —
  // otherwise `isAuthenticated=false` during the initial pending state
  // redirects signed-in users to signin (Codex R51 P1).
  if (!sessionReady) {
    return (
      <p aria-busy="true" aria-live="polite" data-mega-shell="session-loading" role="status">
        {nav.loading}
      </p>
    );
  }

  return (
    <UiWorkspaceShellClient
      isAuthenticated={isAuthenticated}
      onNavigate={(href) => router.push(href)}
      onRedirect={(href) => router.replace(href)}
      paletteLabels={{
        actions: palette.actions,
        empty: palette.empty,
        error: paletteError,
        groups: {
          actions: palette.groups.actions,
          navigation: palette.groups.navigation,
        },
        inputPlaceholder: palette.inputPlaceholder,
        loading: palette.loading,
        nav: nav.items,
        title: palette.title,
      }}
      rail={rail}
      sessionGuardLabels={{ redirecting: nav.loading }}
      signinHref={`/${locale}/signin`}
      useSearchResults={useWorkspaceSearchResults}
      workspaceBase={workspaceBase}
    >
      {children}
    </UiWorkspaceShellClient>
  );
}
