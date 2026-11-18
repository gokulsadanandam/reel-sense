import { describe, expect, it } from "vitest";
import { buildWindows } from "./ingest-windows";

describe("buildWindows", () => {
  const windows = buildWindows({
    today: new Date("2026-11-18T10:00:00Z"),
    startYear: 2023,
    minVotes: 500,
    recentYears: 2,
    recentMinVotes: 50,
  });

  it("uses the high bar before the cutoff and the low bar after it", () => {
    expect(windows).toEqual([
      { from: "2023-01-01", to: "2023-12-31", minVotes: 500, label: "classic" },
      { from: "2024-01-01", to: "2024-11-17", minVotes: 500, label: "classic" },
      { from: "2024-11-18", to: "2024-12-31", minVotes: 50, label: "recent" },
      { from: "2025-01-01", to: "2025-12-31", minVotes: 50, label: "recent" },
      { from: "2026-01-01", to: "2026-11-18", minVotes: 50, label: "recent" },
    ]);
  });

  it("has no gaps or overlaps between consecutive windows", () => {
    for (let i = 1; i < windows.length; i++) {
      const prevEnd = new Date(windows[i - 1]!.to).getTime();
      const start = new Date(windows[i]!.from).getTime();
      expect(start - prevEnd).toBe(86_400_000);
    }
  });

  it("uses only the classic bar when recentYears is 0", () => {
    const w = buildWindows({ today: new Date("2026-11-18"), startYear: 2026, minVotes: 500, recentYears: 0, recentMinVotes: 50 });
    expect(w.every((x) => x.label === "classic")).toBe(true);
    expect(w.at(-1)!.to).toBe("2026-11-17");
  });
});
