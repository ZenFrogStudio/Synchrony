// Must be set before any Date is constructed. npm on Windows runs scripts
// through cmd.exe, where an inline `TZ=... node` prefix is not valid.
process.env.TZ = 'America/New_York';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeNextRun } from '../src/recurrence';
import { DAILY, Recurrence } from '../src/types';

/**
 * These tests assume TZ=America/New_York, set by the npm test script, because
 * the DST cases need a zone that actually observes it.
 */

const daily = (timeLocal: string): Recurrence => ({ daysOfWeek: DAILY, timeLocal });
const weekly = (daysOfWeek: number[], timeLocal: string): Recurrence => ({
  daysOfWeek,
  timeLocal
});
/** A monthly rule carries no days of week — the day of the month is the rule. */
const monthly = (dayOfMonth: number, timeLocal: string): Recurrence => ({
  daysOfWeek: [],
  timeLocal,
  dayOfMonth
});

/** Local-time assertion helper — the whole point is what the wall clock reads. */
function assertLocal(actual: Date, expected: string): void {
  const pad = (n: number) => String(n).padStart(2, '0');
  const got =
    `${actual.getFullYear()}-${pad(actual.getMonth() + 1)}-${pad(actual.getDate())} ` +
    `${pad(actual.getHours())}:${pad(actual.getMinutes())}`;
  assert.equal(got, expected);
}

describe('computeNextRun', () => {
  it('should_return_today_when_the_time_has_not_yet_passed', () => {
    const after = new Date(2026, 6, 26, 8, 0);
    const next = computeNextRun(daily('09:00'), after);
    assertLocal(next, '2026-07-26 09:00');
  });

  it('should_roll_to_tomorrow_when_todays_time_has_already_passed', () => {
    const after = new Date(2026, 6, 26, 9, 30);
    const next = computeNextRun(daily('09:00'), after);
    assertLocal(next, '2026-07-27 09:00');
  });

  it('should_roll_to_tomorrow_when_the_time_is_exactly_now', () => {
    const after = new Date(2026, 6, 26, 9, 0);
    const next = computeNextRun(daily('09:00'), after);
    assertLocal(next, '2026-07-27 09:00');
  });

  it('should_wrap_from_sunday_to_the_next_matching_weekday', () => {
    // Sunday 2026-07-26. Rule fires Mon/Wed/Fri.
    const after = new Date(2026, 6, 26, 12, 0);
    const next = computeNextRun(weekly([1, 3, 5], '09:00'), after);
    assertLocal(next, '2026-07-27 09:00');
  });

  it('should_wrap_from_friday_forward_to_monday', () => {
    // Friday 2026-07-31 after the fire time; next Mon/Wed/Fri is Monday.
    const after = new Date(2026, 6, 31, 10, 0);
    const next = computeNextRun(weekly([1, 3, 5], '09:00'), after);
    assertLocal(next, '2026-08-03 09:00');
  });

  it('should_return_the_same_weekday_next_week_for_a_single_day_rule', () => {
    const after = new Date(2026, 6, 27, 10, 0); // Monday, past the time
    const next = computeNextRun(weekly([1], '09:00'), after);
    assertLocal(next, '2026-08-03 09:00');
  });

  it('should_hold_local_wall_clock_time_across_the_spring_dst_transition', () => {
    // US DST starts Sunday 2026-03-08. 09:00 must stay 09:00, not become 10:00.
    const after = new Date(2026, 2, 7, 12, 0);
    const next = computeNextRun(daily('09:00'), after);
    assertLocal(next, '2026-03-08 09:00');
  });

  it('should_hold_local_wall_clock_time_across_the_autumn_dst_transition', () => {
    // US DST ends Sunday 2026-11-01.
    const after = new Date(2026, 9, 31, 12, 0);
    const next = computeNextRun(daily('09:00'), after);
    assertLocal(next, '2026-11-01 09:00');
  });

  it('should_advance_by_exactly_one_calendar_day_across_spring_forward', () => {
    // The gap is 23 real hours, but the rule is a wall-clock rule.
    const after = new Date(2026, 2, 8, 9, 30);
    const next = computeNextRun(daily('09:00'), after);
    assertLocal(next, '2026-03-09 09:00');
  });

  it('should_throw_when_the_rule_has_no_days', () => {
    assert.throws(() => computeNextRun(weekly([], '09:00'), new Date(2026, 6, 26)));
  });

  it('should_throw_when_the_time_is_malformed', () => {
    assert.throws(() => computeNextRun(daily('not-a-time'), new Date(2026, 6, 26)));
  });
});

describe('computeNextRun — monthly rules', () => {
  it('should_return_this_months_day_when_it_has_not_yet_passed', () => {
    const after = new Date(2026, 6, 10, 12, 0);
    const next = computeNextRun(monthly(15, '09:00'), after);
    assertLocal(next, '2026-07-15 09:00');
  });

  it('should_roll_to_next_month_when_this_months_day_has_passed', () => {
    const after = new Date(2026, 6, 15, 10, 0);
    const next = computeNextRun(monthly(15, '09:00'), after);
    assertLocal(next, '2026-08-15 09:00');
  });

  it('should_clamp_the_31st_to_the_last_day_of_a_short_month', () => {
    // February 2026 has 28 days. The month must not be skipped.
    const after = new Date(2026, 1, 1, 12, 0);
    const next = computeNextRun(monthly(31, '09:00'), after);
    assertLocal(next, '2026-02-28 09:00');
  });

  it('should_clamp_the_31st_to_the_29th_in_a_leap_february', () => {
    const after = new Date(2028, 1, 1, 12, 0);
    const next = computeNextRun(monthly(31, '09:00'), after);
    assertLocal(next, '2028-02-29 09:00');
  });

  it('should_clamp_the_31st_to_the_30th_of_a_thirty_day_month', () => {
    const after = new Date(2026, 3, 1, 12, 0); // April
    const next = computeNextRun(monthly(31, '09:00'), after);
    assertLocal(next, '2026-04-30 09:00');
  });

  it('should_roll_over_the_year_from_december_to_january', () => {
    const after = new Date(2026, 11, 20, 12, 0);
    const next = computeNextRun(monthly(15, '09:00'), after);
    assertLocal(next, '2027-01-15 09:00');
  });

  it('should_not_reject_a_monthly_rule_for_having_no_days_of_week', () => {
    // The days-of-week guard runs after the monthly branch on purpose; before
    // it, every monthly rule would throw inside the scheduler's tick.
    assert.doesNotThrow(() => computeNextRun(monthly(15, '09:00'), new Date(2026, 6, 26)));
  });

  it('should_throw_when_a_monthly_rules_time_is_malformed', () => {
    assert.throws(() => computeNextRun(monthly(15, 'not-a-time'), new Date(2026, 6, 26)));
  });
});
