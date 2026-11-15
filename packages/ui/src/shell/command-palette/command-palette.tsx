/**
 * megaui:libs/react-shared/components/mega/command-palette/command-palette.tsx@0ff3a9d
 *
 * Diff vs upstream (GC-03): `results` is a generic `PaletteSearchState`
 * over `PaletteResultGroup[]` instead of the full `WorkspaceSearchResults`
 * / `WorkspaceBodyHit` shape (those need `@megaui/core`/`@megaui/engine`
 * domain types outside this card's write set — see `./items.ts` header).
 * Callers (`WA-03`/`WA-07`) map their search response into
 * `PaletteResultGroup[]`. Settings-driven CSS variable injection
 * (`toMegaSettingsCssVariables`/`useMegaSettings`) is dropped — no
 * settings provider exists in megaui yet.
 */
"use client"

import { useCallback, useEffect, useState, type ReactNode } from "react"

import { Dialog, DialogContent, DialogTitle } from "../../ui"
import { ShellIcon, type ShellIconName } from "../icons"
import { MEGA_COMMAND_OPEN_EVENT, type MegaNavId } from "../nav-config"
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "./command"
import { MEGA_NAV_ITEMS, MEGA_PALETTE_ACTIONS, workspaceHref, type MegaPaletteActionId } from "./items"

export const PALETTE_SEARCH_DEBOUNCE_MS = 150

export interface WorkspaceCommandPaletteLabels {
  actions: Record<MegaPaletteActionId, string>
  empty: string
  error: string
  groups: {
    actions: string
    navigation: string
  }
  inputPlaceholder: string
  loading: string
  nav: Record<MegaNavId, string>
  title: string
}

/** A caller-mapped search-result row (id/href/icon/label/value). */
export interface PaletteResultItem {
  href: string
  icon?: ShellIconName
  key: string
  label: ReactNode
  value: string
}

/** A caller-mapped, headed group of result rows (e.g. "Issues", "Docs"). */
export interface PaletteResultGroup {
  heading: string
  items: readonly PaletteResultItem[]
}

export type PaletteSearchState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error" }
  | { state: "success"; groups: readonly PaletteResultGroup[] }

export interface WorkspaceCommandPaletteContentProps {
  labels: WorkspaceCommandPaletteLabels
  onQueryChange(query: string): void
  onSelect(href: string): void
  query: string
  results: PaletteSearchState
  workspaceBase: string
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [delayMs, value])

  return debounced
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT"
}

function hasResults(groups: readonly PaletteResultGroup[]): boolean {
  return groups.some((group) => group.items.length > 0)
}

interface PaletteRowProps {
  href: string
  icon: ReactNode
  label: ReactNode
  onNavigate(href: string): void
  value: string
}

/** `data-mega-href` and the select callback share one derivation, so markup tests lock the route. */
function PaletteRow({ href, icon, label, onNavigate, value }: PaletteRowProps) {
  return (
    <CommandItem data-mega-href={href} data-mega-palette="item" onSelect={() => onNavigate(href)} value={value}>
      <span aria-hidden="true" data-mega-palette="item-icon">{icon}</span>
      <span data-mega-palette="item-label">{label}</span>
    </CommandItem>
  )
}

/** Pure palette body, exported separately so component tests can lock the group/route contract. */
export function WorkspaceCommandPaletteContent({
  labels,
  onQueryChange,
  onSelect,
  query,
  results,
  workspaceBase,
}: WorkspaceCommandPaletteContentProps) {
  const trimmedQuery = query.trim()
  const showBaseGroups = trimmedQuery.length === 0
  const showLoading = trimmedQuery.length > 0 && (results.state === "loading" || results.state === "idle")
  const showEmpty = trimmedQuery.length > 0 && results.state === "success" && !hasResults(results.groups)

  return (
    <Command data-mega-palette="command" label={labels.title} shouldFilter={false}>
      <CommandInput
        data-mega-palette="input"
        onValueChange={onQueryChange}
        placeholder={labels.inputPlaceholder}
        value={query}
      />
      <CommandList data-mega-palette="list">
        {showLoading ? <div aria-live="polite" data-mega-palette="status" role="status">{labels.loading}</div> : null}
        {results.state === "error" ? <div data-mega-palette="status" role="alert">{labels.error}</div> : null}
        {showEmpty ? <div data-mega-palette="empty">{labels.empty}</div> : null}

        {showBaseGroups ? (
          <>
            <CommandGroup data-mega-palette="group" heading={labels.groups.navigation}>
              {MEGA_NAV_ITEMS.map((item) => (
                <PaletteRow
                  href={workspaceHref(workspaceBase, item.path)}
                  icon={<ShellIcon name={item.icon} size={14} />}
                  key={item.id}
                  label={labels.nav[item.id]}
                  onNavigate={onSelect}
                  value={`nav-${item.id}`}
                />
              ))}
            </CommandGroup>
            <CommandGroup data-mega-palette="group" heading={labels.groups.actions}>
              {MEGA_PALETTE_ACTIONS.map((action) => (
                <PaletteRow
                  href={workspaceHref(workspaceBase, action.path)}
                  icon={<ShellIcon name={action.icon} size={14} />}
                  key={action.id}
                  label={labels.actions[action.id]}
                  onNavigate={onSelect}
                  value={`action-${action.id}`}
                />
              ))}
            </CommandGroup>
          </>
        ) : null}

        {results.state === "success" && !showBaseGroups
          ? results.groups.filter((group) => group.items.length > 0).map((group) => (
            <CommandGroup data-mega-palette="group" heading={group.heading} key={group.heading}>
              {group.items.map((item) => (
                <PaletteRow
                  href={item.href}
                  icon={item.icon ? <ShellIcon name={item.icon} size={14} /> : null}
                  key={item.key}
                  label={item.label}
                  onNavigate={onSelect}
                  value={item.value}
                />
              ))}
            </CommandGroup>
          ))
          : null}
      </CommandList>
    </Command>
  )
}

export interface WorkspaceCommandPaletteProps {
  labels: WorkspaceCommandPaletteLabels
  onNavigate(href: string): void
  /** App adapter wires the debounced query to its search backend. */
  useSearchResults(query: string): PaletteSearchState
  workspaceBase: string
}

export function WorkspaceCommandPalette({ labels, onNavigate, useSearchResults, workspaceBase }: WorkspaceCommandPaletteProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const debouncedQuery = useDebouncedValue(query.trim(), PALETTE_SEARCH_DEBOUNCE_MS)
  const results = useSearchResults(open ? debouncedQuery : "")

  useEffect(() => {
    const handleOpen = () => setOpen(true)
    const handleKeydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return
      if (isEditableTarget(event.target)) return
      event.preventDefault()
      setOpen(true)
    }

    window.addEventListener(MEGA_COMMAND_OPEN_EVENT, handleOpen)
    window.addEventListener("keydown", handleKeydown)
    return () => {
      window.removeEventListener(MEGA_COMMAND_OPEN_EVENT, handleOpen)
      window.removeEventListener("keydown", handleKeydown)
    }
  }, [])

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) setQuery("")
  }, [])

  const handleSelect = useCallback((href: string) => {
    setOpen(false)
    setQuery("")
    onNavigate(href)
  }, [onNavigate])

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="overflow-hidden p-0" data-mega-palette="root">
        <DialogTitle className="sr-only">{labels.title}</DialogTitle>
        <WorkspaceCommandPaletteContent
          labels={labels}
          onQueryChange={setQuery}
          onSelect={handleSelect}
          query={query}
          results={results}
          workspaceBase={workspaceBase}
        />
      </DialogContent>
    </Dialog>
  )
}
