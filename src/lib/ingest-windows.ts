// Which TMDB movies to ingest: well-known films from every year, plus a lower
// vote bar for recent releases (they haven't had time to collect votes yet).

export interface DiscoverWindow {
  /** Inclusive release-date range, YYYY-MM-DD. */
  from: string;
  to: string;
  minVotes: number;
  label: "classic" | "recent";
}

export interface WindowOptions {
  today: Date;
  startYear: number;
  minVotes: number;
  recentYears: number;
  recentMinVotes: number;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * One window per calendar year (TMDB returns at most 500 pages = 10,000 results
 * per query, so whole-history queries would be truncated). Years before the
 * recent cutoff use `minVotes`; years after it use `recentMinVotes`.
 */
export function buildWindows(o: WindowOptions): DiscoverWindow[] {
  const today = new Date(Date.UTC(o.today.getUTCFullYear(), o.today.getUTCMonth(), o.today.getUTCDate()));
  const cutoff = new Date(today);
  cutoff.setUTCFullYear(today.getUTCFullYear() - o.recentYears);

  const windows: DiscoverWindow[] = [];
  for (let year = o.startYear; year <= today.getUTCFullYear(); year++) {
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year, 11, 31));

    // Classic part of this year: [yearStart, min(yearEnd, cutoff - 1 day)]
    const classicEnd = new Date(Math.min(yearEnd.getTime(), cutoff.getTime() - 86_400_000));
    if (classicEnd >= yearStart) {
      windows.push({ from: iso(yearStart), to: iso(classicEnd), minVotes: o.minVotes, label: "classic" });
    }

    // Recent part of this year: [max(yearStart, cutoff), min(yearEnd, today)]
    const recentStart = new Date(Math.max(yearStart.getTime(), cutoff.getTime()));
    const recentEnd = new Date(Math.min(yearEnd.getTime(), today.getTime()));
    if (o.recentYears > 0 && recentEnd >= recentStart) {
      windows.push({ from: iso(recentStart), to: iso(recentEnd), minVotes: o.recentMinVotes, label: "recent" });
    }
  }
  return windows;
}
