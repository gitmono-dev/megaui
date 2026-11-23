"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@megaui/ui";
import { ShellAvatar } from "@megaui/ui/shell";

import { useTranslation } from "@/hooks/use-translation";
import { authClient } from "@/lib/auth-client";
import { useMegaSettingsOptional } from "@/lib/mega-settings/provider";

const triggerStyle = {
  alignItems: "center",
  background: "transparent",
  border: 0,
  color: "inherit",
  cursor: "pointer",
  display: "flex",
  flex: 1,
  font: "inherit",
  gap: 8,
  minWidth: 0,
  padding: 0,
  textAlign: "left",
  width: "100%",
} as const;

export function AccountMenu({
  displayName,
  imageUrl,
  initials,
  settingsHref,
}: {
  displayName: string;
  imageUrl?: string | null;
  initials: string;
  settingsHref: string;
}) {
  const router = useRouter();
  const { locale, t } = useTranslation();
  const mega = useMegaSettingsOptional();
  const appearance = t.workspace.settings.appearance;
  const [pending, setPending] = useState(false);
  const mode = mega?.settings.mode ?? "light";

  const chooseTheme = (value: string) => {
    if (value !== "light" && value !== "dark" && value !== "system") return;
    mega?.updateSettings({ mode: value });
  };

  const logout = async () => {
    setPending(true);
    const { error } = await authClient.signOut();
    if (error) {
      setPending(false);
      return;
    }
    router.replace(`/${locale}/signin`);
    router.refresh();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={t.workspace.nav.accountMenu}
          data-mega-shell="rail-profile-link"
          style={triggerStyle}
          type="button"
        >
          <ShellAvatar image={imageUrl} initials={initials} size={20} />
          <span style={{ flex: 1, fontSize: "calc(var(--mega-density-font-size) - 1.5px)", fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {displayName}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-mega-shell="account-menu" side="top">
        <DropdownMenuItem asChild>
          <Link data-mega-shell="account-menu-settings" href={settingsHref}>
            {t.common.settings}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-mega-shell="account-menu-theme">
            {appearance.theme}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup onValueChange={chooseTheme} value={mode}>
              <DropdownMenuRadioItem value="light">{appearance.modeLight}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">{appearance.modeDark}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">{appearance.modeSystem}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-mega-shell="account-menu-logout"
          disabled={pending}
          onSelect={() => void logout()}
          variant="destructive"
        >
          {t.common.logout}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
