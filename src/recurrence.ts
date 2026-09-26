import { Recurrence } from './types';

/**
 * Recurrence math. Pure — no `vscode` import — so it is directly testable.
 *
 * Occurrences are built with the local-time Date constructor rather than by
 * adding 24h to a previous instant. That is what keeps "every day at 09:00"
 * reading 09:00 on both sides of a DST boundary: the day either side of a
 * transition is 23 or 25 real hours long, but the wall clock is unchanged.
 */

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The next occurrence strictly after `after`. */
export function computeNextRun(recurrence: Recurrence, after: Date): Date {
  const match = TIME_PATTERN.exec(recurrence.timeLocal);
  if (!match) {
    throw new Error(`Invalid recurrence time: ${recurrence.timeLocal}`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  // Checked before the days-of-week guard: a monthly rule carries an empty
  // `daysOfWeek` on purpose, and would otherwise be thrown out as unusable.
  if (recurrence.dayOfMonth) {
    return nextMonthly(recurrence.dayOfMonth, hours, minutes, after);
  }

  if (!recurrence.daysOfWeek.length) {
    throw new Error('Recurrence has no days of week.');
  }

  // Today plus a full week is always enough to hit any day-of-week rule.
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(
      after.getFullYear(),
      after.getMonth(),
      after.getDate() + offset,
      hours,
      minutes,
      0,
      0
    );
    if (
      candidate.getTime() > after.getTime() &&
      recurrence.daysOfWeek.includes(candidate.getDay())
    ) {
      return candidate;
    }
  }

  throw new Error('Could not find a next occurrence within one week.');
}

/**
 * "The 15th of every month", and "the 31st" in a month that has no 31st: the
 * day clamps to the month's last one rather than the month being skipped. Built
 * with the local-time constructor for the same reason as above.
 */
function nextMonthly(dayOfMonth: number, hours: number, minutes: number, after: Date): Date {
  // Walk forward month by month. The Date constructor rolls the year over on
  // its own once the month index passes 11.
  for (let offset = 0; offset <= 12; offset++) {
    const year = after.getFullYear();
    const month = after.getMonth() + offset;
    const lastDay = new Date(year, month + 1, 0).getDate(); // day 0 of the next month
    const day = Math.min(dayOfMonth, lastDay);
    const candidate = new Date(year, month, day, hours, minutes, 0, 0);
    if (candidate.getTime() > after.getTime()) {
      return candidate;
    }
  }

  throw new Error('Could not find a next monthly occurrence within a year.');
}
