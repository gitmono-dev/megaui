"use client";

import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Settings } from "lucide-react";
import { ISSUE_TYPES, MEGA_ISSUE_PRIORITIES, type IssuePropertiesInput, type IssuePropertyOptions } from "@megaui/core";
import { megaGet } from "@megaui/ui/query";
import { useTranslation } from "@/hooks/use-translation";
import { authClient } from "@/lib/auth-client";
import styles from "./issue-composer.module.css";

function Property({ title, summary, shortcut, children }: {
  title: string; summary: string; shortcut?: ReactNode; children: ReactNode;
}) {
  return <section className={styles.property}>
    <details name="issue-property">
      <summary><span>{title}</span><Settings size={15} aria-hidden="true" /></summary>
      <div className={styles.picker}>{children}</div>
    </details>
    <div className={styles.selection}>{summary}{shortcut}</div>
  </section>;
}

function toggle(values: string[], value: string) {
  return values.includes(value) ? values.filter(item => item !== value) : [...values, value];
}

function NamesPicker({ values, options, onChange, placeholder, add }: {
  values: string[]; options: string[]; onChange: (next: string[]) => void; placeholder: string; add: string;
}) {
  const [draft, setDraft] = useState("");
  const name = draft.trim();
  const canAdd = Boolean(name && !values.includes(name) && values.length < 32);
  function addName() {
    if (canAdd) { onChange([...values, name]); setDraft(""); }
  }
  return <>
    <div className={styles.addName}>
      <input aria-label={placeholder} placeholder={placeholder} value={draft} maxLength={80}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); addName(); } }} />
      <button type="button" onClick={addName} disabled={!canAdd}>{add}</button>
    </div>
    <div className={styles.choices}>{[...new Set([...values, ...options])].map(option => (
      <label key={option}><input type="checkbox" checked={values.includes(option)} disabled={!values.includes(option) && values.length >= 32}
        onChange={() => onChange(toggle(values, option))} />{option}</label>
    ))}</div>
  </>;
}

export function IssueProperties({ value, onChange, disabled }: {
  value: IssuePropertiesInput; onChange: (value: IssuePropertiesInput) => void; disabled: boolean;
}) {
  const { t } = useTranslation();
  const text = t.workspace.issues.properties;
  const { data: session } = authClient.useSession();
  const options = useQuery({ queryKey: ["issue-property-options"], queryFn: () => megaGet<IssuePropertyOptions>("issues/property-options") });
  const [search, setSearch] = useState("");
  const milestoneList = useId();
  const selected = value.assigneeIds ?? [];
  const selfId = session?.user.id;
  const members = options.data?.members ?? [];
  const matching = members.filter(member => member.displayName.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const change = (patch: Partial<IssuePropertiesInput>) => onChange({ ...value, ...patch });
  const loading = options.isPending && <span role="status">{t.workspace.issues.loading}</span>;
  const retry = options.isError && <div role="alert">{text.loadError} <button type="button" onClick={() => void options.refetch()}>{text.retry}</button></div>;
  return <aside className={styles.sidebar} aria-label={text.title}>
    <fieldset disabled={disabled} aria-label={text.title} onKeyDown={event => {
      if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type === "text") {
        event.preventDefault();
      }
    }}>
      <Property title={text.assignees} summary={selected.map(id => members.find(member => member.id === id)?.displayName ?? (id === selfId ? text.self : id)).join(", ") || text.unassigned}
        shortcut={selfId && !selected.includes(selfId) && selected.length < 32 && <button type="button" className={styles.self} onClick={() => change({ assigneeIds: [...selected, selfId] })}>{text.assignSelf}</button>}>
        <input aria-label={text.findMember} placeholder={text.findMember} value={search} onChange={event => setSearch(event.target.value)} />
        {loading}{retry}
        <div className={styles.choices}>{matching.map(member => <label key={member.id}>
          <input type="checkbox" checked={selected.includes(member.id)} disabled={!selected.includes(member.id) && selected.length >= 32}
            onChange={() => change({ assigneeIds: toggle(selected, member.id) })} />{member.displayName}
        </label>)}</div>
        {options.isSuccess && !matching.length && <span>{text.noMembers}</span>}
      </Property>
      <Property title={text.labels} summary={value.labels?.join(", ") || text.noLabels}>
        {loading}{retry}<NamesPicker values={value.labels ?? []} options={options.data?.labels ?? []}
          onChange={labels => change({ labels })} placeholder={text.newLabel} add={text.add} />
      </Property>
      <Property title={text.type} summary={value.issueType ? text.types[value.issueType] : text.noType}>
        <select aria-label={text.type} value={value.issueType ?? ""} onChange={event => change({ issueType: ISSUE_TYPES.find(type => type === event.target.value) })}>
          <option value="">{text.noType}</option>{ISSUE_TYPES.map(type => <option key={type} value={type}>{text.types[type]}</option>)}
        </select>
      </Property>
      <Property title={text.fields} summary={value.priority ? `${text.priority} · ${value.priority}` : ""}>
        <label>{text.priority}<select value={value.priority ?? ""} onChange={event => change({ priority: MEGA_ISSUE_PRIORITIES.find(p => p === event.target.value) })}>
          <option value="">{text.defaultPriority} (P2)</option>{MEGA_ISSUE_PRIORITIES.map(p => <option key={p}>{p}</option>)}
        </select></label>
      </Property>
      <Property title={text.projects} summary={value.projects?.join(", ") || text.noProjects}>
        {loading}{retry}<NamesPicker values={value.projects ?? []} options={options.data?.projects ?? []}
          onChange={projects => change({ projects })} placeholder={text.newProject} add={text.add} />
      </Property>
      <Property title={text.milestone} summary={value.milestoneTitle?.trim() || text.noMilestone}>
        {loading}{retry}<input aria-label={text.milestone} list={milestoneList} maxLength={80} placeholder={text.enterMilestone} value={value.milestoneTitle ?? ""}
          onChange={event => change({ milestoneTitle: event.target.value || undefined })} onBlur={event => change({ milestoneTitle: event.target.value.trim() || undefined })} />
        <datalist id={milestoneList}>{options.data?.milestones.map(name => <option value={name} key={name} />)}</datalist>
      </Property>
    </fieldset>
  </aside>;
}
