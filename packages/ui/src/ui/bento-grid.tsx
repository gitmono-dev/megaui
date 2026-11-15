// megaui:libs/react-shared/components/magicui/bento-grid.tsx@0ff3a9d
//
// Deviation from upstream (registered on plan UI-10 card): upstream imports
// `Button` from `../../ui/button` (UI-02's write set) and `ArrowRightIcon`
// from `@radix-ui/react-icons` (not a `@megaui/ui` dependency). UI-10's
// write set must stay independent of the concurrent UI-02 card (plan
// concurrency group `{UI-02, UI-03, UI-04, UI-10, UI-11}`), so the CTA link
// is inlined here with the same visual treatment as the upstream
// `Button variant="ghost" size="sm" asChild` instead of importing it, and
// the arrow glyph uses `lucide-react` (already a `@megaui/ui` dependency)
// in place of `@radix-ui/react-icons`.
import { ArrowRight } from "lucide-react"
import type { ComponentPropsWithoutRef, ReactNode } from "react"

import { cn } from "../lib/cn"

interface BentoGridProps extends ComponentPropsWithoutRef<"div"> {
  children: ReactNode
  className?: string
}

interface BentoCardProps extends ComponentPropsWithoutRef<"div"> {
  name: string
  className: string
  background: ReactNode
  Icon: React.ElementType
  description: string
  href: string
  cta: string
}

const BentoGrid = ({ children, className, ...props }: BentoGridProps) => {
  return (
    <div
      className={cn(
        "grid w-full auto-rows-[22rem] grid-cols-3 gap-4",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

const BentoCard = ({
  name,
  className,
  background,
  Icon,
  description,
  href,
  cta,
  ...props
}: BentoCardProps) => (
  <div
    key={name}
    className={cn(
      "group relative col-span-3 flex flex-col justify-between overflow-hidden rounded-xl h-full",
      // light styles
      "bg-background [box-shadow:0_0_0_1px_rgba(0,0,0,.03),0_2px_4px_rgba(0,0,0,.05),0_12px_24px_rgba(0,0,0,.05)]",
      // dark styles
      "transform-gpu dark:bg-background dark:[border:1px_solid_rgba(255,255,255,.1)] dark:[box-shadow:0_-20px_80px_-20px_#ffffff1f_inset]",
      className
    )}
    {...props}
  >
    <div>{background}</div>
    <div className="pointer-events-none z-10 flex transform-gpu flex-col gap-3 p-6 transition-all duration-300 group-hover:-translate-y-8 flex-1">
      <Icon className="h-10 w-10 origin-left transform-gpu text-slate-700 dark:text-slate-300 transition-all duration-300 ease-in-out group-hover:scale-75 flex-shrink-0" />
      <div className="flex flex-col gap-2 flex-1">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-white leading-tight">
          {name}
        </h3>
        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed line-clamp-3">
          {description}
        </p>
      </div>
    </div>

    <div className="pointer-events-none absolute bottom-0 flex w-full translate-y-10 transform-gpu flex-row items-center p-4 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100">
      <a
        href={href}
        className="pointer-events-auto inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium text-slate-700 transition-all hover:bg-accent hover:text-slate-900 dark:text-slate-300 dark:hover:bg-accent/50 dark:hover:text-white"
      >
        {cta}
        <ArrowRight className="ms-2 h-4 w-4 rtl:rotate-180" />
      </a>
    </div>
    <div className="pointer-events-none absolute inset-0 transform-gpu transition-all duration-300 group-hover:bg-black/[.03] group-hover:dark:bg-neutral-800/10" />
  </div>
)

export { BentoCard, BentoGrid }
