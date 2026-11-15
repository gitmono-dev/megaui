# workspace-docs-outdent-focus e2e catalog

> Specification: Roam-style Shift+Tab focus regression
> Provenance: user manual screenshot, 2026-09-19

## Purpose

Keep the editing caret in the moved block when Shift+Tab outdents it, rather than letting the browser move keyboard focus to a toolbar button.

## Scenario

| ID | Name | Assertions |
|---|---|---|
| S-01 | Outdent keeps editing focus | A nested block becomes a root sibling; the contenteditable remains focused and its selection remains inside the editor. |

Run against the rebuilt `mega2/docker-compose.test.yml` web profile with a stubbed document payload and a real headed browser.
