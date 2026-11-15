// megaui:libs/react-shared/components/mega/shell/rail-section.tsx@0ff3a9d
import type { ReactNode } from "react"

import { MEGA_SPACING_TOKENS } from "../tokens/mega-tokens"
import { SectionLabel } from "./atoms"

export interface RailSectionProps {
  action?: ReactNode
  children: ReactNode
  label: ReactNode
}

export function RailSection({ action, children, label }: RailSectionProps) {
  return (
    <section data-mega-shell="rail-section">
      <div style={{ padding: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[1]} + ${MEGA_SPACING_TOKENS[1]}) calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[1]} + ${MEGA_SPACING_TOKENS[1]}) ${MEGA_SPACING_TOKENS[4]}` }}>
        <SectionLabel action={action}>{label}</SectionLabel>
      </div>
      {children}
    </section>
  )
}
