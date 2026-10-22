import { BOOK_CATALOGS } from '../data/bookPools';
import { DailyDrop, BookQuote } from '../types';

export function getFormattedDateLabel(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).toUpperCase();
}

export function getDateId(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Calculates elapsed days since launch date (Oct 21, 2026).
 * Safely normalized to local midnight boundaries.
 */
export function getRealWorldDayOffset(): number {
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const launchMidnight = new Date(2026, 9, 21).getTime(); // Oct 21, 2026
  const diffTime = todayMidnight - launchMidnight;
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
}

/**
 * Computes all daily drops from launch date (Oct 21, 2026) up to current day offset.
 * NEVER repeats quotes: sequentially consumes quotes from each catalog.
 * When all quotes for a book are exhausted, flags `isCompleted: true` so
 * "all big ideas have been identified" is displayed.
 */
export function generateDailyDrops(dayOffset: number = 0): DailyDrop[] {
  const safeOffset = Math.max(0, dayOffset);
  const drops: DailyDrop[] = [];

  for (let i = safeOffset; i >= 0; i--) {
    const dropDate = new Date(2026, 9, 21);
    dropDate.setDate(dropDate.getDate() + i);

    const quotes: BookQuote[] = BOOK_CATALOGS.map((catalog) => {
      // Non-repeating sequential consumption
      if (i < catalog.quotes.length) {
        const q = catalog.quotes[i];
        return {
          bookId: catalog.id,
          title: catalog.title,
          author: catalog.author,
          year: catalog.year,
          page: q.page,
          quote: q.quote,
          strategicDirection: q.strategicDirection,
          realWorldContext: q.realWorldContext,
          isCompleted: false,
        };
      } else {
        // All big ideas have been exhausted for this book
        return {
          bookId: catalog.id,
          title: catalog.title,
          author: catalog.author,
          year: catalog.year,
          isCompleted: true,
        };
      }
    });

    drops.push({
      dateId: getDateId(dropDate),
      dateLabel: getFormattedDateLabel(dropDate),
      isToday: i === safeOffset,
      quotes,
    });
  }

  return drops;
}
