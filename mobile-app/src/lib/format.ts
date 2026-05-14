// Time-format helpers, matching the PWA's formatTime / dayLabel / formatClock.

const ONE_DAY = 86400000;

export function formatTime(ts: number | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  if (sameDay(d, now)) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const yest = new Date(now.getTime() - ONE_DAY);
  if (sameDay(d, yest)) return "Yesterday";
  const diff = (now.getTime() - d.getTime()) / ONE_DAY;
  if (diff < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}

export function dayLabel(ts: number | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  if (sameDay(d, now)) return "Today";
  const yest = new Date(now.getTime() - ONE_DAY);
  if (sameDay(d, yest)) return "Yesterday";
  return d.toLocaleDateString([], {
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatClock(ts: number | undefined): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

export function prettyStatus(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}
