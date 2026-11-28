"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bold, Check, ChevronDown, ChevronLeft, Circle, CircleDashed, CircleDot, CircleGauge, Code, Eye, Heading, Italic, Link as LinkIcon, List, ListChecks, ListOrdered, Paperclip, Pencil, Quote } from "lucide-react";
import { useRef, useState } from "react";

import { ISSUE_WORKFLOW_STATUSES, type Issue, type IssuePropertiesInput } from "@megaui/core";
import { Popover, PopoverContent, PopoverTrigger } from "@megaui/ui";
import { megaPost, megaQueryKeys } from "@megaui/ui/query";
import { useTranslation } from "@/hooks/use-translation";
import { IssueProperties } from "./issue-properties";
import { IssueMarkdown } from "../components/issue-markdown";
import styles from "./issue-composer.module.css";

const STATUS_ICONS = { backlog: CircleDot, todo: CircleDashed, in_progress: Circle, in_review: CircleGauge };

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
  const [createMore, setCreateMore] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const StatusIcon = STATUS_ICONS[properties.workflowStatus ?? "backlog"];
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  function insert(before: string, after = "") {
    const field = textarea.current;
    if (!field) return;
    const start = field.selectionStart, end = field.selectionEnd;
    const selected = body.slice(start, end);
    setBody(body.slice(0, start) + before + selected + after + body.slice(end));
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(start + before.length, end + before.length); });
  }
  async function uploadFiles(files: FileList | File[]) {
    if (!files.length || uploading) return;
    setUploading(true); setUploadError(false);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData(); form.set("file", file);
        const response = await fetch("/api/upload?purpose=attachment", { method: "POST", body: form });
        if (!response.ok) throw new Error("upload failed");
        const result = await response.json() as { data?: { url?: string } };
        if (!result.data?.url || !/^https?:\/\//i.test(result.data.url)) throw new Error("invalid upload response");
        const name = file.name.replaceAll("[", " ").replaceAll("]", " ").replace(/[\\\n\r]/g, " ");
        const item = `${file.type.startsWith("image/") ? "!" : ""}[${name}](${encodeURI(result.data.url).replace(/[()]/g, c => c === "(" ? "%28" : "%29")})`;
        setBody(current => `${current}${current && !current.endsWith("\n") ? "\n" : ""}${item}\n`);
      }
    } catch { setUploadError(true); } finally { setUploading(false); if (fileInput.current) fileInput.current.value = ""; }
  }
  const create = useMutation({
    mutationFn: () => megaPost<Issue>("issues", { title: title.trim(), body: body.trim() || undefined, ...properties }),
    onSuccess: (issue) => {
      void client.invalidateQueries({ queryKey: megaQueryKeys.issues() });
      void client.invalidateQueries({ queryKey: megaQueryKeys.home() });
      void client.invalidateQueries({ queryKey: ["issue-property-options"] });
      if (createMore) {
        setTitle(""); setBody(""); setProperties({}); setPreview(false); create.reset();
      } else router.replace(`${list}/${issue.publicId ?? issue.number}`);
    },
  });
  const saving = create.isPending || create.isSuccess || uploading;

  return (
    <main className={styles.page} data-mega-issues="create">
      <Link href={back} className={styles.back}><ChevronLeft size={16} aria-hidden="true" />{t.workspace.issues.detail.backToList}</Link>
      <h1>{labels.title}</h1>
      <form className={styles.form} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && title.trim() && !saving) { event.preventDefault(); create.mutate(); } }} onSubmit={event => {
        event.preventDefault();
        if (title.trim() && !saving) create.mutate();
      }}>
        <div className={styles.mainColumn}>
          <label htmlFor="issue-title">{labels.titleLabel}</label>
          <div className={styles.titleInput}>
            <Popover open={statusOpen} onOpenChange={setStatusOpen}>
              <PopoverTrigger asChild><button className={styles.statusTrigger} type="button" aria-label={`${labels.status}: ${labels.statuses[properties.workflowStatus ?? "backlog"]}`} disabled={saving}><StatusIcon size={17} aria-hidden="true" /><ChevronDown size={14} aria-hidden="true" /></button></PopoverTrigger>
              <PopoverContent className={styles.statusPopup} align="start">
                <h2>{labels.status}</h2>
                {ISSUE_WORKFLOW_STATUSES.map(status => { const Icon = STATUS_ICONS[status]; return <button key={status} type="button" onClick={() => { setProperties({ ...properties, workflowStatus: status }); setStatusOpen(false); }} aria-pressed={(properties.workflowStatus ?? "backlog") === status}>
                  <span className={styles.statusCheck}>{(properties.workflowStatus ?? "backlog") === status && <Check size={15} aria-hidden="true" />}</span><Icon size={16} className={styles.statusIcon} aria-hidden="true" />{labels.statuses[status]}
                </button>; })}
              </PopoverContent>
            </Popover>
            <input id="issue-title" data-mega-issues="new-title" required value={title}
              placeholder={labels.titlePlaceholder} onChange={event => setTitle(event.target.value)} />
          </div>
          <label htmlFor={preview ? undefined : "issue-description"}>{labels.descriptionLabel}</label>
          <div className={styles.editor}>
            <div className={styles.toolbar} role="group" aria-label={labels.descriptionLabel}>
              <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}><Pencil size={14} aria-hidden="true" />{labels.write}</button>
              <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}><Eye size={14} aria-hidden="true" />{labels.preview}</button>
              {!preview && <div className={styles.formatting} role="group" aria-label={labels.formatting}>
                {([
                  ["heading", Heading, "## ", ""], ["bold", Bold, "**", "**"], ["italic", Italic, "*", "*"],
                  ["quote", Quote, "> ", ""], ["code", Code, "`", "`"], ["link", LinkIcon, "[", "](https://)"],
                  ["bullets", List, "- ", ""], ["numbered", ListOrdered, "1. ", ""], ["task", ListChecks, "- [ ] ", ""],
                ] as const).map(([key, Icon, before, after]) => <button key={key} type="button" title={labels.tools[key]} aria-label={labels.tools[key]} onClick={() => insert(before, after)}><Icon size={16} aria-hidden="true" /></button>)}
              </div>}
            </div>
            {preview ? <div className={styles.preview} data-empty={!body.trim()}>{body.trim() ? <IssueMarkdown text={body} /> : labels.emptyPreview}</div>
              : <textarea ref={textarea} id="issue-description" data-mega-issues="new-body" placeholder={labels.descriptionPlaceholder}
                  onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); void uploadFiles(event.clipboardData.files); } }}
                  onDragOver={event => event.preventDefault()} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void uploadFiles(event.dataTransfer.files); } }}
                  value={body} onChange={event => setBody(event.target.value)} />}
            <div className={styles.attachment}>
              <input ref={fileInput} type="file" multiple hidden onChange={event => { if (event.target.files) void uploadFiles(event.target.files); }} />
              <button type="button" onClick={() => fileInput.current?.click()} disabled={saving}><Paperclip size={15} />{uploading ? labels.uploading : labels.attach}</button>
              {uploadError && <span role="alert" className={styles.error}>{labels.uploadFailed}</span>}
            </div>
          </div>
        </div>
        <IssueProperties value={properties} onChange={setProperties} disabled={saving} />
        {create.isError && <p className={styles.error} role="alert">{labels.failed}</p>}
        <div className={styles.actions}>
          <label className={styles.createMore}><input type="checkbox" checked={createMore} onChange={event => setCreateMore(event.target.checked)} />{labels.createMore}</label>
          <button type="button" disabled={saving} onClick={() => router.replace(back)}>{labels.cancel}</button>
          <button data-mega-issues="new-submit" disabled={saving || !title.trim()} type="submit">{saving ? labels.submitting : labels.submit}</button>
        </div>
      </form>
    </main>
  );
}
