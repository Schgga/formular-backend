// Single source of truth for turning a plan's base monthly price into any
// billing cadence's price. Used by both the pricing-preview endpoint and
// the real /upgrade charge — so a user can never see one number and get
// charged a different one.
export function calculateCadencePrice(monthlyPriceCents, unit, interval) {
  const perWeek = monthlyPriceCents / 4.33;
  switch (unit) {
    case 'week':
      return Math.round(perWeek * 1.15 * interval);
    case 'month':
      if (interval === 1) return monthlyPriceCents;
      if (interval === 3) return Math.round(monthlyPriceCents * 3 * 0.95);
      if (interval === 6) return Math.round(monthlyPriceCents * 6 * 0.90);
      if (interval === 12) return Math.round(monthlyPriceCents * 12 * 0.80);
      return Math.round(monthlyPriceCents * interval); // no discount for an unlisted interval
    default:
      return monthlyPriceCents;
  }
}

export const CADENCE_OPTIONS = [
  { label: 'Weekly', unit: 'week', interval: 1 },
  { label: 'Monthly', unit: 'month', interval: 1 },
  { label: '3 Months', unit: 'month', interval: 3 },
  { label: '6 Months', unit: 'month', interval: 6 },
  { label: 'Yearly', unit: 'month', interval: 12 }
];

// Days a chosen cadence actually covers — used both to set the real renewal
// date, and to calculate how much of a still-active OLD plan is unused.
export function cadenceDays(unit, interval) {
  if (unit === 'week') return 7 * interval;
  return 30 * interval; // a simple, consistent 30-day month for all proration math
}