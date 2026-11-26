import type { User } from "@megaui/core";
import { getInitials } from "@megaui/ui/shell";

import { selfDisplayName, type SelfDisplayNameSource } from "@/lib/self-display-name";

export interface CLViewer extends SelfDisplayNameSource {
  id: string;
  image?: string | null;
}

export function isCLViewer(author: User, viewer: CLViewer | null | undefined): boolean {
  if (!viewer?.id) return false;
  return author.id === viewer.id || (
    Boolean(viewer.name) && author.id === `mega2:${viewer.name}` && author.username === viewer.name
  );
}

export function presentCLAuthor(author: User, viewer: CLViewer | null | undefined): User {
  if (!isCLViewer(author, viewer)) return author;
  const displayName = selfDisplayName(viewer)?.trim();
  if (!displayName) return author;
  return {
    ...author,
    displayName,
    avatarInitials: getInitials(displayName),
    avatarUrl: viewer?.image || author.avatarUrl,
  };
}
