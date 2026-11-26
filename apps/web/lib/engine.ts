// megaui-only (WA-04): process-wide engine domain singletons over `@megaui/database`.
//
// Diff vs upstream (GC-03):
// - upstream inlined `@libs/mega/services` module state; megaui wires
//   `createDocsDomain` / `createIssuesDomain` / `createClsDomain` once per
//   process via `getDb()` (ADR-ARCH-02 single PG dialect).

import { getDb } from "@megaui/database";
import {
  createAgentDomain,
  createChatDomain,
  createClsDomain,
  createCollabDomain,
  createDocsDomain,
  createIssuesDomain,
  createNotificationsDomain,
  createReleasesDomain,
  createSiteSettingsDomain,
  type AgentDomain,
  type ChatDomain,
  type ClsDomain,
  type CollabDomain,
  type DocsDomain,
  type IssuesDomain,
  type NotificationsDomain,
  type ReleasesDomain,
  type SiteSettingsDomain,
} from "@megaui/engine";

let docsDomain: DocsDomain | null = null;
let issuesDomain: IssuesDomain | null = null;
let clsDomain: ClsDomain | null = null;
let chatDomain: ChatDomain | null = null;
let releasesDomain: ReleasesDomain | null = null;
let notificationsDomain: NotificationsDomain | null = null;
let collabDomain: CollabDomain | null = null;
let agentDomain: AgentDomain | null = null;
let siteSettingsDomain: SiteSettingsDomain | null = null;

export function getDocsDomain(): DocsDomain {
  if (!docsDomain) {
    docsDomain = createDocsDomain(getDb());
  }
  return docsDomain;
}

export function getIssuesDomain(): IssuesDomain {
  if (!issuesDomain) {
    issuesDomain = createIssuesDomain(getDb());
  }
  return issuesDomain;
}

export function getClsDomain(): ClsDomain {
  if (!clsDomain) {
    clsDomain = createClsDomain(getDb());
  }
  return clsDomain;
}

export function getChatDomain(): ChatDomain {
  if (!chatDomain) {
    chatDomain = createChatDomain(getDb());
  }
  return chatDomain;
}

export function getReleasesDomain(): ReleasesDomain {
  if (!releasesDomain) {
    releasesDomain = createReleasesDomain(getDb());
  }
  return releasesDomain;
}

export function getNotificationsDomain(): NotificationsDomain {
  if (!notificationsDomain) {
    notificationsDomain = createNotificationsDomain(getDb());
  }
  return notificationsDomain;
}

export function getCollabDomain(): CollabDomain {
  if (!collabDomain) {
    collabDomain = createCollabDomain(getDb());
  }
  return collabDomain;
}

export function getAgentDomain(): AgentDomain {
  if (!agentDomain) {
    agentDomain = createAgentDomain(getDb());
  }
  return agentDomain;
}

export function getSiteSettingsDomain(): SiteSettingsDomain {
  if (!siteSettingsDomain) {
    siteSettingsDomain = createSiteSettingsDomain(getDb());
  }
  return siteSettingsDomain;
}

/** Test-only reset — clears lazy singletons between contract cases. */
export function resetEngineDomainsForTests(): void {
  docsDomain = null;
  issuesDomain = null;
  clsDomain = null;
  chatDomain = null;
  releasesDomain = null;
  notificationsDomain = null;
  collabDomain = null;
  agentDomain = null;
  siteSettingsDomain = null;
}
