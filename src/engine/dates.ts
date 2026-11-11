// ISO-date (YYYY-MM-DD) helpers. All maths in UTC so DST never shifts a day.
const DAY = 86400000;
export const toMs = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
export const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => fromMs(toMs(iso) + n * DAY);
export const diffDays = (a: string, b: string) => Math.round((toMs(a) - toMs(b)) / DAY);
/** Monday = 0 .. Sunday = 6 */
export const dow = (iso: string) => (new Date(toMs(iso)).getUTCDay() + 6) % 7;
export const mondayOf = (iso: string) => addDays(iso, -dow(iso));
export function localToday(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
