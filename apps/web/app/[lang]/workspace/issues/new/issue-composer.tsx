"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Eye, Pencil } from "lucide-react";
import { useState } from "react";

import type { Issue, IssuePropertiesInput } from "@megaui/core";
import { megaPost, megaQueryKeys } from "@megaui/ui/query";
import { useTranslation } from "@/hooks/use-translation";
import { IssueProperties } from "./issue-properties";
import styles from "./issue-composer.module.css";

export function IssueComposer({ listQuery }: { listQuery: string }) {
  const { locale, t } = useTranslation();
  const router = useRouter();
  const client = useQueryClient();
  const list = `/${locale}/workspace/issues`;
  const back = listQuery ? `${list}?q=${encodeURIComponent(listQuery)}` : list;
  const labels = t.workspace.issues.create;
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [properties, setProperties] = useState<IssuePropertiesInput>({});
  const [preview, setPreview] = useState(false);
  const create = useMutation({
    mutationFn: () => megaPost<Issue>("issues", { title: title.trim(), body: body.trim() || undefined, ...properties }),
    onSuccess: (issue) => {
      void client.invalidateQueries({ queryKey: megaQueryKeys.issues() });
      void client.invalidateQueries({ queryKey: megaQueryKeys.home() });
      void client.invalidateQueries({ queryKey: ["issue-property-options"] });
      router.replace(`${list}/${issue.number}`);
    },
  });
  const saving = create.isPending || create.isSuccess;

  return (
    <main className={styles.page} data-mega-issues="create">
      <Link href={back} className={styles.back}><ChevronLeft size={16} aria-hidden="true" />{t.workspace.issues.detail.backToList}</Link>
      <h1>{labels.title}</h1>
      <form className={styles.form} onSubmit={event => {
        event.preventDefault();
        if (title.trim() && !saving) create.mutate();
      }}>
        <div className={styles.mainColumn}>
          <label htmlFor="issue-title">{labels.titleLabel}</label>
          <input id="issue-title" data-mega-issues="new-title" required value={title}
            placeholder={labels.titlePlaceholder} onChange={event => setTitle(event.target.value)} />
          <label htmlFor={preview ? undefined : "issue-description"}>{labels.descriptionLabel}</label>
          <div className={styles.editor}>
            <div className={styles.toolbar} role="group" aria-label={labels.descriptionLabel}>
              <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}><Pencil size={14} aria-hidden="true" />{labels.write}</button>
              <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}><Eye size={14} aria-hidden="true" />{labels.preview}</button>
            </div>
            {preview ? <div className={styles.preview} data-empty={!body.trim()}>{body.trim() || labels.emptyPreview}</div>
              : <textarea id="issue-description" data-mega-issues="new-body" placeholder={labels.descriptionPlaceholder}
                  value={body} onChange={event => setBody(event.target.value)} />}
          </div>
        </div>
        <IssueProperties value={properties} onChange={setProperties} disabled={saving} />
        {create.isError && <p className={styles.error} role="alert">{labels.failed}</p>}
        <div className={styles.actions}>
          <button type="button" disabled={saving} onClick={() => router.replace(back)}>{labels.cancel}</button>
          <button data-mega-issues="new-submit" disabled={saving || !title.trim()} type="submit">{saving ? labels.submitting : labels.submit}</button>
        </div>
      </form>
    </main>
  );
}
