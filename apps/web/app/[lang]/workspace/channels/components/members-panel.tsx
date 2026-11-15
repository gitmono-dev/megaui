"use client";

import { useState } from "react";

import type { ChannelMember } from "@megaui/core";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

export function MembersPanel({
  canInvite,
  closeLabel,
  emptyLabel,
  errorMessage,
  inviteButtonLabel,
  inviteError,
  inviteHeading,
  invitePlaceholder,
  leaveLabel,
  loading,
  loadingLabel,
  members,
  onClose,
  onInvite,
  onLeave,
  onRemove,
  onRetry,
  removeLabel,
  retryLabel,
  roleAdminLabel,
  roleMemberLabel,
  selfUserId,
  title,
}: {
  canInvite: boolean;
  closeLabel: string;
  emptyLabel: string;
  errorMessage?: string | null;
  inviteButtonLabel: string;
  inviteError?: string | null;
  inviteHeading: string;
  invitePlaceholder: string;
  leaveLabel: string;
  loading?: boolean;
  loadingLabel?: string;
  members: readonly ChannelMember[];
  onClose: () => void;
  onInvite: (userId: string) => void | Promise<void>;
  onLeave: () => void | Promise<void>;
  onRemove: (userId: string) => void | Promise<void>;
  onRetry?: () => void;
  removeLabel: string;
  retryLabel?: string;
  roleAdminLabel: string;
  roleMemberLabel: string;
  selfUserId?: string;
  title: string;
}) {
  const [inviteUserId, setInviteUserId] = useState("");

  return (
    <aside
      data-mega-chat="members-panel"
      style={{
        borderLeft: `1px solid ${MEGA_TOKENS.border}`,
        display: "flex",
        flexDirection: "column",
        gap: MEGA_SPACING_TOKENS[8],
        maxWidth: 320,
        minWidth: 260,
        padding: MEGA_SPACING_TOKENS[8],
      }}
    >
      <header style={{ alignItems: "center", display: "flex", justifyContent: "space-between" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 700, margin: 0 }}>{title}</h2>
        <button data-mega-chat="members-close" onClick={onClose} type="button">
          {closeLabel}
        </button>
      </header>

      {loading ? <p data-mega-chat="members-loading">{loadingLabel}</p> : null}

      {errorMessage ? (
        <div data-mega-chat="members-error" role="alert" style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
          <p style={{ margin: 0 }}>{errorMessage}</p>
          {onRetry && retryLabel ? (
            <button data-mega-chat="members-retry" onClick={onRetry} type="button">
              {retryLabel}
            </button>
          ) : null}
        </div>
      ) : null}

      {!loading && !errorMessage && canInvite ? (
        <form
          data-mega-chat="invite-form"
          onSubmit={(event) => {
            event.preventDefault();
            const userId = inviteUserId.trim();
            if (!userId) return;
            void Promise.resolve(onInvite(userId)).then(() => setInviteUserId(""));
          }}
          style={{ display: "flex", flexDirection: "column", gap: MEGA_SPACING_TOKENS[8] }}
        >
          <strong>{inviteHeading}</strong>
          <input
            data-mega-chat="invite-user-id"
            onChange={(event) => setInviteUserId(event.target.value)}
            placeholder={invitePlaceholder}
            style={{
              border: `1px solid ${MEGA_TOKENS.border}`,
              borderRadius: MEGA_RADIUS_TOKENS.md,
              padding: MEGA_SPACING_TOKENS[8],
            }}
            value={inviteUserId}
          />
          <button data-mega-chat="invite-submit" disabled={!inviteUserId.trim()} type="submit">
            {inviteButtonLabel}
          </button>
          {inviteError ? (
            <p data-mega-chat="invite-error" role="alert" style={{ color: MEGA_TOKENS.danger, margin: 0 }}>
              {inviteError}
            </p>
          ) : null}
        </form>
      ) : null}

      {!loading && !errorMessage ? (
        <ul data-mega-chat="members-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {members.length === 0 ? (
            <li data-mega-chat="members-empty">{emptyLabel}</li>
          ) : (
            members.map((member) => (
              <li
                data-mega-chat="member-row"
                data-role={member.role}
                key={member.id}
                style={{
                  alignItems: "center",
                  display: "flex",
                  gap: MEGA_SPACING_TOKENS[8],
                  padding: `${MEGA_SPACING_TOKENS[8]} 0`,
                }}
              >
                <span style={{ flex: 1 }}>
                  {member.user.displayName}{" "}
                  <span style={{ color: MEGA_TOKENS.muted }}>
                    ({member.role === "admin" ? roleAdminLabel : roleMemberLabel})
                  </span>
                </span>
                {canInvite && member.userId !== selfUserId ? (
                  <button data-mega-chat="member-remove" onClick={() => void onRemove(member.userId)} type="button">
                    {removeLabel}
                  </button>
                ) : null}
                {member.userId === selfUserId ? (
                  <button data-mega-chat="member-leave" onClick={() => void onLeave()} type="button">
                    {leaveLabel}
                  </button>
                ) : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </aside>
  );
}
