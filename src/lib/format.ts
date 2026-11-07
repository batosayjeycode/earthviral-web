const WIB = 'Asia/Jakarta';

/** "Nov 6, 2026" in WIB. */
export function formatDateWib(isoString: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: WIB,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(isoString));
}

/** "00:00 WIB" */
export function formatTimeWib(isoString: string): string {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: WIB,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(isoString));
  return `${time} WIB`;
}

/** Build-time relative label, e.g. "5h ago" relative to the batch timestamp. */
export function hoursBefore(isoString: string, referenceIso: string): string {
  const hours = Math.max(
    0,
    Math.round((Date.parse(referenceIso) - Date.parse(isoString)) / 3_600_000),
  );
  return hours < 1 ? 'just now' : `${hours}h ago`;
}
