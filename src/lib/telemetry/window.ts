export interface TelemetryWindow {
  start: Date;
  end: Date;
  previousStart: Date;
  previousEnd: Date;
  days: number;
}

const JST = 'Asia/Tokyo';
const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: JST, year: 'numeric', month: 'numeric', day: 'numeric',
});

function dateParts(date: Date): { year: number; month: number; day: number } {
  const parts = Object.fromEntries(partsFormatter.formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
  return parts as { year: number; month: number; day: number };
}

export function resolveTelemetryWindow(days = 30, now = new Date()): TelemetryWindow {
  const count = Math.min(365, Math.max(1, Math.floor(days)));
  const local = dateParts(now);
  const start = new Date(Date.UTC(local.year, local.month - 1, local.day) - 9 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + count * 86_400_000);
  const previousStart = new Date(start.getTime() - count * 86_400_000);
  return { start, end, previousStart, previousEnd: start, days: count };
}
