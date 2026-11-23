// megaui:apps/next-app/.../inbox/page.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-16): lean list + pane; consumes WA-05 paginated
// EngineNotification envelope (not core Notification); quick reply via issue/CL BFF.
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { NotificationListItem } from "@megaui/ui/composites";
import { MegaApiError, megaGet, megaPost, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";

type UnreadCount = { count: number };
type FilterMode = "all" | "unread";

/** WA-05 / EG-09 flat notification row (not core Notification). */
type EngineNotification = {
  id: string;
  kind: string;
  entityType: string;
  entityId: string;
  url: string;
  summary: string;
  readAt?: string;
  createdAt: string;
};

type NotificationPage = {
  items: EngineNotification[];
  total: number;
  offset: number;
  limit: number;
};

function entityNumberFrom(notification: EngineNotification): number | undefined {
  const fromId = Number(notification.entityId);
  if (Number.isInteger(fromId) && fromId > 0) return fromId;
  const match = notification.url.match(/\/(?:issues|cls)\/(\d+)/);
  return match ? Number(match[1]) : undefined;
}

function hrefFor(notification: EngineNotification, workspaceBase: string): string {
  if (notification.url.startsWith(`/${workspaceBase.split("/")[1]}/`)) return notification.url;
  if (notification.url.startsWith("/workspace/")) return `/${workspaceBase.split("/")[1]}${notification.url}`;
  if (notification.url.startsWith("/")) return `${workspaceBase}${notification.url.replace(/^\/workspace/, "")}`;
  return `${workspaceBase}/${notification.url}`;
}

export default function InboxPage() {
  const { locale, t } = useTranslation();
  const queryClient = useQueryClient();
  const inbox = t.workspace.inbox;
  const workspaceBase = `/${locale}/workspace`;
  const [filter, setFilter] = useState<FilterMode>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: megaQueryKeys.notifications(filter === "unread" ? { unreadOnly: true } : undefined),
    queryFn: () =>
      megaGet<NotificationPage>(
        "notifications",
        filter === "unread" ? { filter: JSON.stringify({ unreadOnly: true }) } : undefined,
      ),
  });

  const unreadQuery = useQuery({
    queryKey: megaQueryKeys.notificationUnreadCount(),
    queryFn: () => megaGet<UnreadCount>(["notifications", "unread-count"]),
    refetchInterval: 15_000,
  });

  const items = listQuery.data?.items ?? [];
  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId]);

  const invalidateInbox = () => {
    void queryClient.invalidateQueries({ queryKey: ["mega", "notifications"] });
    void queryClient.invalidateQueries({ queryKey: megaQueryKeys.notificationUnreadCount() });
  };

  const markReadMutation = useMutation({
    mutationFn: (id: string) => megaPost(["notifications", id, "read"]),
    onSuccess: () => invalidateInbox(),
  });

  const markAllMutation = useMutation({
    mutationFn: () => megaPost(["notifications", "mark-all-read"]),
    onSuccess: () => invalidateInbox(),
    onError: () => setToast(inbox.rail.markAllReadError),
  });

  const replyMutation = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("no selection");
      const body = reply.trim();
      if (!body) throw new Error("empty");
      const entityNumber = entityNumberFrom(selected);
      if (selected.entityType === "issue" && entityNumber) {
        return megaPost(["issues", String(entityNumber), "comments"], { body });
      }
      if (selected.entityType === "cl" && entityNumber) {
        return megaPost(["cls", String(entityNumber), "comments"], { body });
      }
      throw new MegaApiError(400, "MEGA_BAD_REQUEST", `Unsupported quick-reply target ${selected.entityType}`);
    },
    onSuccess: () => {
      setReply("");
      setToast(inbox.pane.quickReply.sent);
      if (selected && !selected.readAt) markReadMutation.mutate(selected.id);
    },
    onError: () => setToast(inbox.pane.quickReply.failed),
  });

  if (listQuery.isPending) {
    return (
      <main aria-busy="true" data-mega-inbox="page">
        <p style={{ color: MEGA_TOKENS.muted, padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>{inbox.loading}</p>
      </main>
    );
  }

  if (listQuery.isError) {
    return (
      <main data-mega-inbox="page">
        <div role="alert" style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8], padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>
          <p style={{ margin: 0 }}>{inbox.error}</p>
          <button data-mega-inbox="retry" onClick={() => void listQuery.refetch()} type="button">
            {inbox.retry}
          </button>
        </div>
      </main>
    );
  }

  const unreadCount = unreadQuery.data?.count ?? 0;
  const toastIsError =
    toast === inbox.error || toast === inbox.rail.markAllReadError || toast === inbox.pane.quickReply.failed;

  return (
    <main data-mega-inbox="page">
      <header data-mega-inbox="chrome">
        <div>
          <h1>{inbox.rail.title}</h1>
          <span data-mega-inbox="unread-count">{inbox.list.unreadSummary.replace("{count}", String(unreadCount))}</span>
        </div>
        <div data-mega-inbox="filters">
          <button data-mega-inbox="filter-all" data-active={filter === "all" ? "true" : "false"} onClick={() => setFilter("all")} type="button">
            {inbox.rail.all}
          </button>
          <button data-mega-inbox="filter-unread" data-active={filter === "unread" ? "true" : "false"} onClick={() => setFilter("unread")} type="button">
            {inbox.list.sortUnreadFirst}
          </button>
          <span style={{ flex: 1 }} />
          <button data-mega-inbox="mark-all-read" disabled={markAllMutation.isPending} onClick={() => markAllMutation.mutate()} type="button">
            {inbox.rail.markAllRead}
          </button>
        </div>
      </header>
      <div data-mega-inbox="board">
      <section>
        {items.length === 0 ? (
          <p data-mega-inbox="empty">{inbox.list.empty}</p>
        ) : (
          <ul aria-label={inbox.list.listAriaLabel} data-mega-inbox="list">
            {items.map((item) => (
              <li data-mega-inbox="row" data-read={item.readAt ? "true" : "false"} key={item.id}>
                <NotificationListItem
                  id={item.id}
                  onSelect={() => {
                    setSelectedId(item.id);
                    setReply("");
                    if (!item.readAt) markReadMutation.mutate(item.id);
                  }}
                  read={Boolean(item.readAt)}
                  timestampLabel={new Date(item.createdAt).toLocaleString()}
                  title={item.summary}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section data-mega-inbox="pane">
        {toast ? (
          <div
            data-mega-inbox="toast"
            data-mega-toast={toastIsError ? "error" : "success"}
            role="status"
            style={{
              background: toastIsError ? MEGA_TOKENS.danger : MEGA_TOKENS.success,
              borderRadius: MEGA_RADIUS_TOKENS.md,
              color: MEGA_TOKENS.accentForeground,
              marginBottom: MEGA_SPACING_TOKENS[8],
              padding: MEGA_SPACING_TOKENS[8],
            }}
          >
            {toast}
          </div>
        ) : null}
        {!selected ? (
          <p data-mega-inbox="pane-empty">{inbox.pane.emptySelection}</p>
        ) : (
          <div>
            <h2 data-mega-inbox="pane-title">{selected.summary}</h2>
            <a data-mega-inbox="pane-open" href={hrefFor(selected, workspaceBase)}>
              {inbox.pane.open[selected.kind as keyof typeof inbox.pane.open] ?? inbox.pane.open.issue}
            </a>
            {(selected.entityType === "issue" || selected.entityType === "cl") && entityNumberFrom(selected) ? (
              <form
                data-mega-inbox="quick-reply"
                onSubmit={(event) => {
                  event.preventDefault();
                  replyMutation.mutate();
                }}
                style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8], marginTop: MEGA_SPACING_TOKENS[8] }}
              >
                <input
                  data-mega-inbox="quick-reply-input"
                  onChange={(event) => setReply(event.target.value)}
                  placeholder={inbox.pane.quickReply.placeholder}
                  style={{ border: `1px solid ${MEGA_TOKENS.border}`, borderRadius: MEGA_RADIUS_TOKENS.md, flex: 1, padding: MEGA_SPACING_TOKENS[8] }}
                  value={reply}
                />
                <button data-mega-inbox="quick-reply-send" disabled={!reply.trim() || replyMutation.isPending} type="submit">
                  {inbox.pane.quickReply.sendAriaLabel}
                </button>
              </form>
            ) : null}
          </div>
        )}
      </section>
      </div>
    </main>
  );
}
