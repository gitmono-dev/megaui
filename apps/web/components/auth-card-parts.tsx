// megaui-only: presentational pieces repeated across the sign-in / sign-up cards.
import { SocialAuth } from "@/components/social-auth";

import type { SocialProvider } from "@megaui/ui";

/** Horizontal rule with a centred caption, used between OAuth buttons and a form. */
export function OrDivider({ label }: { label: string }) {
  return (
    <div className="relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-t after:border-border">
      <span className="relative z-10 bg-card px-2 text-muted-foreground">{label}</span>
    </div>
  );
}

/** OAuth buttons followed by a divider; renders nothing when no provider is configured. */
export function SocialSection({ providers, dividerLabel }: { providers: SocialProvider[]; dividerLabel: string }) {
  if (providers.length === 0) return null;
  return (
    <>
      <SocialAuth providers={providers} />
      <OrDivider label={dividerLabel} />
    </>
  );
}

type LegalNoticeProps = {
  lead: string;
  and: string;
  termsLabel: string;
  privacyLabel: string;
};

/** "By continuing you accept our Terms and Privacy Policy" footer line. */
export function LegalNotice({ lead, and, termsLabel, privacyLabel }: LegalNoticeProps) {
  return (
    <p className="text-balance text-center text-xs text-muted-foreground *:[a]:underline *:[a]:underline-offset-4 *:[a]:hover:text-primary">
      {lead} <a href="#">{termsLabel}</a> {and} <a href="#">{privacyLabel}</a>.
    </p>
  );
}
