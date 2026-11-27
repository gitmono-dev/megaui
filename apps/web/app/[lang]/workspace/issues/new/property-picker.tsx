"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, Plus, Search, Settings } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@megaui/ui";
import { useTranslation } from "@/hooks/use-translation";
import styles from "./issue-composer.module.css";

export interface PropertyChoice {
  id: string;
  name: string;
  description?: string;
  marker?: string;
}

interface PropertyPickerProps {
  title: string;
  heading: string;
  placeholder: string;
  summary: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  choices: PropertyChoice[];
  selected: string[];
  onPick: (id: string) => void;
  multiple?: boolean;
  allowNew?: boolean;
  shortcut?: ReactNode;
  status?: ReactNode;
}

export function PropertyPicker({ title, heading, placeholder, summary, open, onOpenChange, choices,
  selected, onPick, multiple, allowNew, shortcut, status }: PropertyPickerProps) {
  const { t } = useTranslation();
  const labels = t.workspace.issues.properties;
  const headingId = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const name = query.trim();
  const filtered = choices.filter(choice => choice.name.toLocaleLowerCase().includes(name.toLocaleLowerCase()));
  const canCreate = allowNew && name && !choices.some(choice => choice.name === name);
  const atLimit = multiple && selected.length >= 32;

  function pick(id: string) {
    onPick(id);
    if (!multiple) onOpenChange(false);
    else if (allowNew) { setQuery(""); input.current?.focus(); }
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (event.key === "Enter" && event.target === input.current) {
      event.preventDefault();
      if (name) buttons[0]?.click();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (event.key === "ArrowUp" && index === 0) input.current?.focus();
      else if (buttons.length) buttons[event.key === "ArrowDown" ? (index + 1) % buttons.length : index < 0 ? buttons.length - 1 : index - 1]?.focus();
    }
  }

  return <section className={styles.property}>
    <Popover open={open} onOpenChange={next => { if (next) setQuery(""); onOpenChange(next); }}>
      <PopoverTrigger asChild>
        <button type="button" className={styles.trigger} data-mega-control="issue-property"><span>{title}</span><Settings size={15} aria-hidden="true" /></button>
      </PopoverTrigger>
      <PopoverContent className={styles.popup} align="end" sideOffset={4} collisionPadding={12} aria-labelledby={headingId}
        onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus(); }} onKeyDown={navigate}>
        <div className={styles.pickerHeader}>
          <h2 id={headingId}>{heading}</h2>
          <label className={styles.search}>
            <Search size={16} aria-hidden="true" />
            <input ref={input} aria-label={placeholder} placeholder={placeholder} value={query}
              maxLength={allowNew ? 80 : undefined} onChange={event => setQuery(event.target.value)} />
          </label>
        </div>
        <div className={styles.choices} ref={list}>
          {status}
          {canCreate && <button type="button" disabled={atLimit} className={styles.option} onClick={() => pick(name)}>
            <Plus size={15} aria-hidden="true" /><span>{labels.addValue.replace("{name}", name)}</span>
          </button>}
          {filtered.map(choice => {
            const checked = selected.includes(choice.id);
            return <button key={choice.id} type="button" className={styles.option} aria-pressed={checked}
              disabled={atLimit && !checked} onClick={() => pick(choice.id)}>
              <span className={styles.check}>{checked && <Check size={15} aria-hidden="true" />}</span>
              <span className={styles.optionBody}>
                <span className={styles.optionTitle}>{choice.marker && <i data-type={choice.marker} aria-hidden="true" />}{choice.name}</span>
                {choice.description && <span className={styles.description}>{choice.description}</span>}
              </span>
            </button>;
          })}
          {!status && !canCreate && !filtered.length && <p className={styles.pickerNote}>{labels.noOptions}</p>}
        </div>
      </PopoverContent>
    </Popover>
    <div className={styles.selection}>{summary}{shortcut}</div>
  </section>;
}
