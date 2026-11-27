"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ISSUE_TYPES, MEGA_ISSUE_PRIORITIES, type IssuePropertiesInput, type IssuePropertyOptions } from "@megaui/core";
import { megaGet } from "@megaui/ui/query";
import { useTranslation } from "@/hooks/use-translation";
import { authClient } from "@/lib/auth-client";
import { PropertyPicker } from "./property-picker";
import styles from "./issue-composer.module.css";

function toggle(values: string[], id: string) {
  return values.includes(id) ? values.filter(value => value !== id) : [...values, id];
}

function namedChoices(selected: string[], options: string[] = []) {
  return [...new Set([...selected, ...options])].map(name => ({ id: name, name }));
}

export function IssueProperties({ value, onChange, disabled }: {
  value: IssuePropertiesInput; onChange: (value: IssuePropertiesInput) => void; disabled: boolean;
}) {
  const { t } = useTranslation();
  const text = t.workspace.issues.properties;
  const { data: session } = authClient.useSession();
  const options = useQuery({ queryKey: ["issue-property-options"], queryFn: () => megaGet<IssuePropertyOptions>("issues/property-options") });
  const [active, setActive] = useState<string | null>(null);
  const selected = value.assigneeIds ?? [];
  const selfId = session?.user.id;
  const members = options.data?.members ?? [];
  const change = (patch: Partial<IssuePropertiesInput>) => onChange({ ...value, ...patch });
  const popup = (key: keyof typeof text.editors) => ({
    open: !disabled && active === key, heading: text.editors[key],
    onOpenChange: (open: boolean) => setActive(current => open ? key : current === key ? null : current),
  });
  const status = options.isPending ? <p className={styles.pickerNote} role="status">{t.workspace.issues.loading}</p>
    : options.isError ? <p className={styles.pickerNote} role="alert">{text.loadError} <button type="button" onClick={() => void options.refetch()}>{text.retry}</button></p> : null;
  return <aside className={styles.sidebar} aria-label={text.title}>
    <fieldset disabled={disabled} aria-label={text.title}>
      <PropertyPicker {...popup("assignees")} title={text.assignees} placeholder={text.findMember} multiple status={status}
        summary={selected.map(id => members.find(member => member.id === id)?.displayName ?? (id === selfId ? text.self : id)).join(", ") || text.unassigned}
        shortcut={selfId && !selected.includes(selfId) && selected.length < 32 && <button type="button" className={styles.self} onClick={() => change({ assigneeIds: [...selected, selfId] })}>{text.assignSelf}</button>}
        choices={members.map(member => ({ id: member.id, name: member.displayName }))} selected={selected}
        onPick={id => change({ assigneeIds: toggle(selected, id) })} />
      <PropertyPicker {...popup("labels")} title={text.labels} placeholder={text.filterLabels} multiple allowNew status={status}
        summary={value.labels?.join(", ") || text.noLabels} choices={namedChoices(value.labels ?? [], options.data?.labels)}
        selected={value.labels ?? []} onPick={id => change({ labels: toggle(value.labels ?? [], id) })} />
      <PropertyPicker {...popup("type")} title={text.type} placeholder={text.filterTypes}
        summary={value.issueType ? text.types[value.issueType] : text.noType} selected={value.issueType ? [value.issueType] : []}
        choices={ISSUE_TYPES.map(id => ({ id, name: text.types[id], description: text.typeDescriptions[id], marker: id }))}
        onPick={id => change({ issueType: ISSUE_TYPES.find(type => type === id && type !== value.issueType) })} />
      <PropertyPicker {...popup("fields")} title={text.fields} placeholder={text.filterPriorities}
        summary={value.priority ? `${text.priority} · ${value.priority}` : ""} selected={[value.priority ?? ""]}
        choices={[{ id: "", name: `${text.defaultPriority} (P2)` }, ...namedChoices([...MEGA_ISSUE_PRIORITIES])]}
        onPick={id => change({ priority: MEGA_ISSUE_PRIORITIES.find(priority => priority === id) })} />
      <PropertyPicker {...popup("projects")} title={text.projects} placeholder={text.filterProjects} multiple allowNew status={status}
        summary={value.projects?.join(", ") || text.noProjects} choices={namedChoices(value.projects ?? [], options.data?.projects)}
        selected={value.projects ?? []} onPick={id => change({ projects: toggle(value.projects ?? [], id) })} />
      <PropertyPicker {...popup("milestone")} title={text.milestone} placeholder={text.enterMilestone} allowNew status={status}
        summary={value.milestoneTitle || text.noMilestone} selected={value.milestoneTitle ? [value.milestoneTitle] : []}
        choices={namedChoices(value.milestoneTitle ? [value.milestoneTitle] : [], options.data?.milestones)}
        onPick={id => change({ milestoneTitle: id === value.milestoneTitle ? undefined : id })} />
    </fieldset>
  </aside>;
}
