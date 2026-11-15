import type { FormEvent } from "react";

import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

export const ISSUE_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

interface IssueCreateDialogCopy {
  readonly title: string;
  readonly titleLabel: string;
  readonly titlePlaceholder: string;
  readonly descriptionLabel: string;
  readonly descriptionPlaceholder: string;
  readonly packageLabel: string;
  readonly priorityLabel: string;
  readonly cancel: string;
  readonly submitting: string;
  readonly submit: string;
}

interface IssueCreateDialogProps {
  readonly body: string;
  readonly copy: IssueCreateDialogCopy;
  readonly isPending: boolean;
  readonly packageId: string;
  readonly priority: IssuePriority;
  readonly title: string;
  readonly onBodyChange: (value: string) => void;
  readonly onCancel: () => void;
  readonly onPackageChange: (value: string) => void;
  readonly onPriorityChange: (value: IssuePriority) => void;
  readonly onSubmit: (input: {
    readonly body?: string;
    readonly packageId: string;
    readonly priority: IssuePriority;
    readonly title: string;
  }) => void;
  readonly onTitleChange: (value: string) => void;
}

export function IssueCreateDialog({
  body,
  copy,
  isPending,
  packageId,
  priority,
  title,
  onBodyChange,
  onCancel,
  onPackageChange,
  onPriorityChange,
  onSubmit,
  onTitleChange,
}: IssueCreateDialogProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit({ body: body.trim() || undefined, packageId, priority, title: title.trim() });
  };

  return (
    <div
      data-mega-issues="new-dialog"
      role="dialog"
      style={{ background: "rgba(0,0,0,0.35)", inset: 0, position: "fixed", zIndex: 40 }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          background: MEGA_TOKENS.bg,
          borderRadius: MEGA_RADIUS_TOKENS.md,
          left: "50%",
          maxWidth: 480,
          padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
          position: "absolute",
          top: "20%",
          transform: "translateX(-50%)",
          width: "90%",
        }}
      >
        <h2 style={{ fontSize: "1.1rem", fontWeight: 700, margin: 0 }}>{copy.title}</h2>
        <label style={{ display: "block", marginTop: MEGA_SPACING_TOKENS[8] }}>
          {copy.titleLabel}
          <input
            data-mega-issues="new-title"
            onChange={(event) => onTitleChange(event.target.value)}
            placeholder={copy.titlePlaceholder}
            required
            style={{ display: "block", marginTop: MEGA_SPACING_TOKENS[4], width: "100%" }}
            value={title}
          />
        </label>
        <label style={{ display: "block", marginTop: MEGA_SPACING_TOKENS[8] }}>
          {copy.descriptionLabel}
          <textarea
            data-mega-issues="new-body"
            onChange={(event) => onBodyChange(event.target.value)}
            placeholder={copy.descriptionPlaceholder}
            rows={4}
            style={{ display: "block", marginTop: MEGA_SPACING_TOKENS[4], width: "100%" }}
            value={body}
          />
        </label>
        <label style={{ display: "block", marginTop: MEGA_SPACING_TOKENS[8] }}>
          {copy.packageLabel}
          <input
            data-mega-issues="new-package"
            onChange={(event) => onPackageChange(event.target.value)}
            style={{ display: "block", marginTop: MEGA_SPACING_TOKENS[4], width: "100%" }}
            value={packageId}
          />
        </label>
        <label style={{ display: "block", marginTop: MEGA_SPACING_TOKENS[8] }}>
          {copy.priorityLabel}
          <select
            data-mega-issues="new-priority"
            onChange={(event) => {
              const nextPriority = ISSUE_PRIORITIES.find((item) => item === event.target.value);
              if (nextPriority) onPriorityChange(nextPriority);
            }}
            style={{ display: "block", marginTop: MEGA_SPACING_TOKENS[4], width: "100%" }}
            value={priority}
          >
            {ISSUE_PRIORITIES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <div
          style={{
            display: "flex",
            gap: MEGA_SPACING_TOKENS[8],
            justifyContent: "flex-end",
            marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
          }}
        >
          <button onClick={onCancel} type="button">
            {copy.cancel}
          </button>
          <button data-mega-issues="new-submit" disabled={isPending} type="submit">
            {isPending ? copy.submitting : copy.submit}
          </button>
        </div>
      </form>
    </div>
  );
}
