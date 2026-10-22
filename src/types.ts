export interface BookQuote {
  bookId: string;
  title: string;
  author: string;
  year?: string;
  page?: number | string;
  quote?: string;
  strategicDirection?: string;
  realWorldContext?: string;
  isCompleted?: boolean;
}

export interface DailyDrop {
  dateId: string;
  dateLabel: string;
  isToday?: boolean;
  quotes: BookQuote[];
}
