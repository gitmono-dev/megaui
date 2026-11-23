// megaui:libs/react-shared/components/mega/shell/rail.tsx@0ff3a9d
import type { CSSProperties, ReactNode } from "react"

import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "../tokens/mega-tokens"
import { KbdChip, ShellAvatar, StatusDot } from "./atoms"
import { type FavoriteEntry } from "./favorites"
import { ShellIcon } from "./icons"
import {
  MEGA_NAV_ITEMS,
  activeNavId,
  getInitials,
  isExactRailRoute,
  workspaceHref,
  type MegaNavId,
} from "./nav-config"
import type { RailChannel, RailPresenceStatus } from "./rail-channels"
import { selectRailChannels, selectRailDirectMessages } from "./rail-channels"
import { RailRow, type WorkspaceRailLinkRenderer } from "./rail-row"
import { RailSection } from "./rail-section"

export interface WorkspaceRailLabels {
  addChannel: string
  addChat: string
  addFavorite: string
  ariaLabel: string
  channels: string
  chat: string
  countsError: string
  currentUser: string
  openProfile: string
  favorites: string
  favoritesEmpty: string
  removeFavorite: string
  items: Record<MegaNavId, string>
  loadError: string
  loading: string
  mentions: string
  newChannel: string
  newChat: string
  noChannels: string
  noChats: string
  openChangeLists: string
  presence: Record<RailPresenceStatus, string>
  retry: string
  search: string
  searchAriaLabel: string
  unread: string
  userLoading: string
}

export interface WorkspaceRailUser {
  displayName: string
  imageUrl?: string | null
  initials?: string
}

interface WorkspaceRailBaseProps {
  currentUser?: WorkspaceRailUser
  /** Z1-01: starred pages; the section keeps its C1-05 empty state when absent. */
  favorites?: readonly FavoriteEntry[]
  favoriteActive?: boolean
  onToggleFavorite?(): void
  onRemoveFavorite?(href: string): void
  labels: WorkspaceRailLabels
  onSearch?(): void
  pathname: string
  renderLink: WorkspaceRailLinkRenderer
  userLoading?: boolean
  /** Bottom-left account control. When set, it replaces the profile link. */
  accountMenu?: ReactNode
  workspaceBase: string
}

type WorkspaceRailChannelsProps =
  | { channels?: readonly RailChannel[]; channelsState: "loading"; onRetry?: never }
  | { channels?: readonly RailChannel[]; channelsState: "error"; onRetry(): void }
  | { channels: readonly RailChannel[]; channelsState: "success"; onRetry?: never }

export type WorkspaceRailCountsProps =
  | { countsState: "loading"; inboxUnreadCount?: never; onCountsRetry?: never; openClCount?: never }
  | { countsState: "error"; inboxUnreadCount?: never; onCountsRetry(): void; openClCount?: never }
  | { countsState: "success"; inboxUnreadCount: number; onCountsRetry?: never; openClCount: number }

export type WorkspaceRailProps = WorkspaceRailBaseProps & WorkspaceRailChannelsProps & WorkspaceRailCountsProps

const hiddenStyle: CSSProperties = {
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  height: 1,
  overflow: "hidden",
  position: "absolute",
  whiteSpace: "nowrap",
  width: 1,
}

function RailSkeletonRows({ count }: { count: number }) {
  return (
    <div aria-hidden="true" data-mega-shell="rail-skeleton-group">
      {Array.from({ length: count }, (_, index) => (
        <div data-mega-shell="rail-skeleton-row" key={index}>
          <span data-mega-shell="rail-skeleton-icon" />
          <span data-mega-shell="rail-skeleton-label" />
        </div>
      ))}
    </div>
  )
}

function EmptyRailState({ children }: { children: ReactNode }) {
  return (
    <p data-mega-shell="rail-empty" style={{ color: MEGA_TOKENS.muted, fontSize: "calc(var(--mega-density-font-size) - 2px)", lineHeight: 1.4, margin: `0 calc(${MEGA_SPACING_TOKENS[8]} * 2) ${MEGA_SPACING_TOKENS[4]}` }}>
      {children}
    </p>
  )
}

export function WorkspaceRail(props: WorkspaceRailProps) {
  const {
    channels = [],
    channelsState,
    countsState,
    accountMenu,
    currentUser,
    labels,
    onSearch,
    pathname,
    renderLink,
    userLoading = false,
    workspaceBase,
  } = props
  const selectedNavId = activeNavId(pathname, workspaceBase)
  const railChannels = selectRailChannels(channels)
  const directMessages = selectRailDirectMessages(channels)
  const displayName = currentUser?.displayName.trim() || labels.currentUser
  const initials = currentUser?.initials?.trim() || getInitials(displayName)
  const profileHref = workspaceHref(workspaceBase, "settings")
  const profileActive = isExactRailRoute(pathname, profileHref)

  return (
    <aside
      data-mega-shell="workspace-rail"
      style={{ background: MEGA_TOKENS.bg, borderRight: `1px solid ${MEGA_TOKENS.border}`, color: MEGA_TOKENS.text, display: "flex", flexDirection: "column", flexShrink: 0, height: "100%", maxWidth: 220, minWidth: 220, overflow: "hidden", width: 220 }}
    >
      <nav aria-busy={channelsState === "loading" || countsState === "loading" || undefined} aria-label={labels.ariaLabel} style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div data-mega-shell="rail-search-wrap" style={{ padding: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[1]} + ${MEGA_SPACING_TOKENS[1]}) calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[1]} + ${MEGA_SPACING_TOKENS[1]}) ${MEGA_SPACING_TOKENS[8]}` }}>
          <button
            aria-haspopup="dialog"
            aria-label={labels.searchAriaLabel}
            data-mega-shell="rail-search"
            onClick={onSearch}
            style={{ alignItems: "center", borderRadius: MEGA_RADIUS_TOKENS.md, color: MEGA_TOKENS.muted, cursor: "pointer", display: "flex", fontSize: "calc(var(--mega-density-font-size) - 1.5px)", gap: MEGA_SPACING_TOKENS[6], height: 26, padding: `0 ${MEGA_SPACING_TOKENS[8]}`, textAlign: "left", width: "100%" }}
            type="button"
          >
            <ShellIcon aria-hidden="true" name="search" size={12} />
            <span style={{ flex: 1 }}>{labels.search}</span>
            <KbdChip>⌘K</KbdChip>
          </button>
        </div>

        <div data-mega-shell="rail-main-nav" style={{ padding: `calc(${MEGA_SPACING_TOKENS[1]} + ${MEGA_SPACING_TOKENS[1]}) 0 ${MEGA_SPACING_TOKENS[6]}` }}>
          {MEGA_NAV_ITEMS.map((item) => {
            const count = countsState === "success"
              ? item.id === "inbox" ? props.inboxUnreadCount : item.id === "cls" ? props.openClCount : 0
              : 0
            return (
              <RailRow
                active={item.id === selectedNavId}
                count={count}
                countAriaLabel={count > 0 ? `${count} ${item.id === "cls" ? labels.openChangeLists : labels.unread}` : undefined}
                href={workspaceHref(workspaceBase, item.path)}
                icon={<ShellIcon name={item.icon} size={14} />}
                key={item.id}
                label={labels.items[item.id]}
                renderLink={renderLink}
              />
            )
          })}
          {countsState === "error" ? (
            <div data-mega-shell="rail-error" data-scope="counts" role="alert" style={{ border: `1px solid ${MEGA_TOKENS.border}`, borderRadius: MEGA_RADIUS_TOKENS.md, margin: `${MEGA_SPACING_TOKENS[6]} ${MEGA_SPACING_TOKENS[8]} 0`, padding: MEGA_SPACING_TOKENS[8] }}>
              <p style={{ color: MEGA_TOKENS.muted, fontSize: "calc(var(--mega-density-font-size) - 1px)", margin: 0 }}>{labels.countsError}</p>
              <code style={{ color: MEGA_TOKENS.muted, fontFamily: MEGA_TOKENS.fontMono, fontSize: "calc(var(--mega-density-font-size) - 3px)" }}>MEGA-NAV-COUNTS</code>
              <button data-mega-shell="rail-retry" data-scope="counts" onClick={props.onCountsRetry} type="button">{labels.retry}</button>
            </div>
          ) : null}
        </div>

        <RailSection
          action={props.onToggleFavorite ? (
            <button
              aria-label={labels.addFavorite}
              aria-pressed={props.favoriteActive ?? false}
              data-mega-shell="favorite-toggle"
              onClick={props.onToggleFavorite}
              style={{ alignItems: "center", background: "transparent", border: "none", color: props.favoriteActive ? MEGA_TOKENS.warning : "inherit", cursor: "pointer", display: "inline-flex", padding: 0 }}
              type="button"
            >
              <ShellIcon aria-hidden="true" color="currentColor" name="star" size={12} />
            </button>
          ) : (
            <span aria-hidden="true" style={{ alignItems: "center", display: "inline-flex" }}><ShellIcon name="plus" size={12} /></span>
          )}
          label={labels.favorites}
        >
          {(props.favorites?.length ?? 0) === 0 ? (
            <EmptyRailState>{labels.favoritesEmpty}</EmptyRailState>
          ) : (
            props.favorites?.map((favorite) => (
              <div data-mega-shell="favorite-row" key={favorite.href} style={{ alignItems: "center", display: "flex", minHeight: "var(--mega-density-row-height)", padding: "0 var(--mega-density-row-padding-x)" }}>
                {renderLink({
                  children: (
                    <span style={{ alignItems: "center", display: "inline-flex", gap: MEGA_SPACING_TOKENS[6], minWidth: 0 }}>
                      <ShellIcon aria-hidden="true" name={favorite.icon} size={13} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{favorite.title}</span>
                    </span>
                  ),
                  href: favorite.href,
                  style: { alignItems: "center", color: isExactRailRoute(pathname, favorite.href) ? MEGA_TOKENS.activeFg : MEGA_TOKENS.text, display: "flex", flex: 1, fontSize: "var(--mega-density-font-size)", minWidth: 0, textDecoration: "none" },
                })}
                {props.onRemoveFavorite ? (
                  <button
                    aria-label={labels.removeFavorite.replace("{title}", favorite.title)}
                    data-mega-shell="favorite-remove"
                    onClick={() => props.onRemoveFavorite?.(favorite.href)}
                    style={{ alignItems: "center", background: "transparent", border: "none", color: MEGA_TOKENS.muted, cursor: "pointer", display: "inline-flex", padding: MEGA_SPACING_TOKENS[1] }}
                    type="button"
                  >
                    <ShellIcon aria-hidden="true" name="x" size={11} />
                  </button>
                ) : null}
              </div>
            ))
          )}
        </RailSection>

        {channelsState === "error" ? (
          <div data-mega-shell="rail-error" role="alert" style={{ border: `1px solid ${MEGA_TOKENS.border}`, borderRadius: MEGA_RADIUS_TOKENS.md, margin: `${MEGA_SPACING_TOKENS[6]} ${MEGA_SPACING_TOKENS[8]}`, padding: MEGA_SPACING_TOKENS[8] }}>
            <p style={{ color: MEGA_TOKENS.muted, fontSize: "calc(var(--mega-density-font-size) - 1px)", margin: 0 }}>{labels.loadError}</p>
            <code style={{ color: MEGA_TOKENS.muted, fontFamily: MEGA_TOKENS.fontMono, fontSize: "calc(var(--mega-density-font-size) - 3px)" }}>MEGA-NAV-LOAD</code>
            <button data-mega-shell="rail-retry" onClick={props.onRetry} type="button">{labels.retry}</button>
          </div>
        ) : null}

        <RailSection
          action={renderLink({
            "aria-label": labels.addChannel,
            children: <ShellIcon aria-hidden="true" name="plus" size={12} />,
            className: "mega-rail-section-action",
            href: workspaceHref(workspaceBase, "channels/new"),
          })}
          label={labels.channels}
        >
          {channelsState === "loading" ? (
            <>
              <span style={hiddenStyle}>{labels.loading}</span>
              <RailSkeletonRows count={6} />
            </>
          ) : channelsState === "success" ? (
            <>
              {railChannels.length === 0 ? <EmptyRailState>{labels.noChannels}</EmptyRailState> : null}
              {railChannels.map((channel) => (
                <RailRow
                  active={isExactRailRoute(pathname, workspaceHref(workspaceBase, `channels/${encodeURIComponent(channel.id)}`))}
                  count={channel.unreadCount}
                  countAriaLabel={channel.unreadCount > 0
                    ? `${channel.unreadCount} ${labels.unread}${channel.mentionCount > 0 ? ` · ${channel.mentionCount} ${labels.mentions}` : ""}`
                    : undefined}
                  href={workspaceHref(workspaceBase, `channels/${encodeURIComponent(channel.id)}`)}
                  icon={<ShellIcon name="hash" size={13} />}
                  key={channel.id}
                  label={channel.name}
                  mention={channel.mentionCount > 0}
                  renderLink={renderLink}
                />
              ))}
              <RailRow href={workspaceHref(workspaceBase, "channels/new")} icon={<ShellIcon name="plus" size={13} />} label={labels.newChannel} renderLink={renderLink} />
            </>
          ) : null}
        </RailSection>

        <RailSection
          action={renderLink({
            "aria-label": labels.addChat,
            children: <ShellIcon aria-hidden="true" name="plus" size={12} />,
            className: "mega-rail-section-action",
            href: workspaceHref(workspaceBase, "dm/new"),
          })}
          label={labels.chat}
        >
          {channelsState === "loading" ? <RailSkeletonRows count={3} /> : channelsState === "success" ? (
            <>
              {directMessages.length === 0 ? <EmptyRailState>{labels.noChats}</EmptyRailState> : null}
              {directMessages.map((channel) => {
                const href = workspaceHref(workspaceBase, `dm/${encodeURIComponent(channel.participant.username)}`)
                const status = channel.participant.status
                return (
                  <RailRow
                    active={isExactRailRoute(pathname, href)}
                    count={channel.unreadCount}
                    countAriaLabel={channel.unreadCount > 0
                      ? `${channel.unreadCount} ${labels.unread}${channel.mentionCount > 0 ? ` · ${channel.mentionCount} ${labels.mentions}` : ""}`
                      : undefined}
                    href={href}
                    icon={(
                      <span style={{ display: "inline-flex", position: "relative" }}>
                        <ShellAvatar size={16} user={channel.participant} />
                        {status ? (
                          <span style={{ bottom: -1, display: "inline-flex", position: "absolute", right: -1 }}>
                            <StatusDot ariaLabel={labels.presence[status]} size={6} status={status} />
                          </span>
                        ) : null}
                      </span>
                    )}
                    key={channel.id}
                    label={channel.name}
                    mention={channel.mentionCount > 0}
                    renderLink={renderLink}
                  />
                )
              })}
              <RailRow href={workspaceHref(workspaceBase, "dm/new")} icon={<ShellIcon name="plus" size={13} />} label={labels.newChat} renderLink={renderLink} />
            </>
          ) : null}
        </RailSection>
      </nav>

      <footer aria-label={labels.currentUser} data-mega-shell="rail-footer" style={{ alignItems: "center", borderTop: `1px solid ${MEGA_TOKENS.border}`, display: "flex", flexShrink: 0, gap: MEGA_SPACING_TOKENS[8], padding: `${MEGA_SPACING_TOKENS[8]} calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[1]} + ${MEGA_SPACING_TOKENS[1]})` }}>
        {userLoading ? (
          <>
            <span aria-hidden="true" data-mega-shell="rail-user-skeleton" />
            <span style={{ flex: 1, fontSize: "calc(var(--mega-density-font-size) - 1.5px)", fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {labels.userLoading}
            </span>
          </>
        ) : accountMenu ? (
          <div data-mega-shell="rail-account" style={{ display: "flex", flex: 1, minWidth: 0 }}>{accountMenu}</div>
        ) : renderLink({
          "aria-current": profileActive ? "page" : undefined,
          "aria-label": labels.openProfile,
          "data-mega-shell": "rail-profile-link",
          href: profileHref,
          style: {
            alignItems: "center",
            color: "inherit",
            display: "flex",
            flex: 1,
            gap: MEGA_SPACING_TOKENS[8],
            minWidth: 0,
            textDecoration: "none",
          },
          children: (
            <>
              <ShellAvatar image={currentUser?.imageUrl} initials={initials} size={20} />
              <span style={{ flex: 1, fontSize: "calc(var(--mega-density-font-size) - 1.5px)", fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {displayName}
              </span>
            </>
          ),
        })}
        <ShellIcon aria-hidden="true" color={MEGA_TOKENS.muted} name="sparkle" size={14} />
        <ShellIcon aria-hidden="true" color={MEGA_TOKENS.muted} name="more" size={14} />
      </footer>
    </aside>
  )
}
