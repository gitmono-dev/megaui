const SECOND = { unit: "second", ms: 1_000 } as const;
const UNITS = [
  { unit: "year", ms: 31_536_000_000 },
  { unit: "month", ms: 2_592_000_000 },
  { unit: "week", ms: 604_800_000 },
  { unit: "day", ms: 86_400_000 },
  { unit: "hour", ms: 3_600_000 },
  { unit: "minute", ms: 60_000 },
  SECOND,
] as const;

export interface RelativeTimeProps {
  locale: string;
  now: string;
  value: string;
}

/** Compact relative timestamp for doc cards (v6 / DC-01 byline). */
export function RelativeTime({ locale, now, value }: RelativeTimeProps) {
  const delta = new Date(value).getTime() - new Date(now).getTime();
  const abs = Math.abs(delta);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  let match: (typeof UNITS)[number] = SECOND;
  for (const item of UNITS) {
    if (abs >= item.ms) {
      match = item;
      break;
    }
  }
  return <time dateTime={value}>{formatter.format(Math.round(delta / match.ms), match.unit)}</time>;
}
