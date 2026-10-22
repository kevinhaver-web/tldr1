/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { CHOSEN_BOOKS } from './data/initialBooks';
import { generateDailyDrops, getRealWorldDayOffset } from './utils/dropsEngine';
import { getTimeUntilMidnight } from './utils/time';

const STORAGE_KEY = 'tldr_book_order_preference';
const EMAIL_STORAGE_KEY = 'tldr_email_subscription';

interface EmailSubscription {
  email: string;
  frequency: 'daily' | 'weekdays' | 'weekly';
  bookIds: string[];
  timezone?: string;
  sendHour?: number;
}

function getStoredSubscription(): EmailSubscription | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(EMAIL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.email === 'string') {
        return {
          email: parsed.email,
          frequency: parsed.frequency || 'daily',
          bookIds: Array.isArray(parsed.bookIds) && parsed.bookIds.length > 0
            ? parsed.bookIds
            : [CHOSEN_BOOKS[0].id],
          timezone: parsed.timezone || (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC'),
          sendHour: parsed.sendHour ?? 9,
        };
      }
    }
  } catch {
    // storage unavailable
  }
  return null;
}

function getInitialBookOrder() {
  if (typeof window === 'undefined') return CHOSEN_BOOKS;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const ids: string[] = JSON.parse(stored);
      if (Array.isArray(ids) && ids.length > 0) {
        const bookMap = new Map(CHOSEN_BOOKS.map((b) => [b.id, b]));
        const reordered: typeof CHOSEN_BOOKS = [];
        for (const id of ids) {
          const found = bookMap.get(id);
          if (found) {
            reordered.push(found);
            bookMap.delete(id);
          }
        }
        for (const remaining of bookMap.values()) {
          reordered.push(remaining);
        }
        return reordered;
      }
    }
  } catch {
    // fallback to default catalog order
  }
  return CHOSEN_BOOKS;
}

export default function App() {
  // Saved device order of books
  const [booksList, setBooksList] = useState<typeof CHOSEN_BOOKS>(getInitialBookOrder);
  const [isEditingOrder, setIsEditingOrder] = useState<boolean>(false);
  const [draftBooks, setDraftBooks] = useState<typeof CHOSEN_BOOKS>(booksList);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  // Naturally tracks elapsed days from real system time
  const [dayOffset, setDayOffset] = useState<number>(getRealWorldDayOffset);

  const allDrops = useMemo(() => generateDailyDrops(dayOffset), [dayOffset]);
  const todayDrop = allDrops[0];

  const [selectedDateId, setSelectedDateId] = useState<string>(todayDrop.dateId);
  const [selectedBookId, setSelectedBookId] = useState<string>(() => booksList[0]?.id || CHOSEN_BOOKS[0].id);
  const [showArchive, setShowArchive] = useState<boolean>(false);
  const [countdown, setCountdown] = useState(getTimeUntilMidnight());

  // Keep selectedDateId updated if day advances naturally
  useEffect(() => {
    setSelectedDateId(todayDrop.dateId);
  }, [todayDrop.dateId]);

  // Live countdown ticker & natural midnight rollover
  useEffect(() => {
    let lastDate = new Date().getDate();
    const timer = setInterval(() => {
      setCountdown(getTimeUntilMidnight());

      // Naturally roll over when midnight passes
      const currentDate = new Date().getDate();
      if (currentDate !== lastDate) {
        lastDate = currentDate;
        setDayOffset(getRealWorldDayOffset());
      }
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const handleStartEdit = () => {
    setDraftBooks([...booksList]);
    setIsEditingOrder(true);
  };

  const handleMove = (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= draftBooks.length) return;
    setDraftBooks((prev) => {
      const updated = [...prev];
      const temp = updated[index];
      updated[index] = updated[targetIndex];
      updated[targetIndex] = temp;
      return updated;
    });
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === targetIndex) return;
    setDraftBooks((prev) => {
      const updated = [...prev];
      const [removed] = updated.splice(draggedIndex, 1);
      updated.splice(targetIndex, 0, removed);
      return updated;
    });
    setDraggedIndex(null);
  };

  const handleSaveOrder = () => {
    setBooksList(draftBooks);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(draftBooks.map((b) => b.id)));
    } catch {
      // storage quota or private mode
    }
    setIsEditingOrder(false);
  };

  const handleCancelOrder = () => {
    setDraftBooks(booksList);
    setIsEditingOrder(false);
  };

  // Email dispatch subscription state
  const [subscription, setSubscription] = useState<EmailSubscription | null>(getStoredSubscription);
  const [showEmailForm, setShowEmailForm] = useState<boolean>(false);
  const [emailInput, setEmailInput] = useState<string>(() => subscription?.email || '');
  const [frequency, setFrequency] = useState<'daily' | 'weekdays' | 'weekly'>(
    () => subscription?.frequency || 'daily'
  );
  const [isSendingTest, setIsSendingTest] = useState<boolean>(false);
  const [testStatusMessage, setTestStatusMessage] = useState<string | null>(null);
  const [showDigestManager, setShowDigestManager] = useState<boolean>(false);

  const currentDrop = allDrops.find((d) => d.dateId === selectedDateId) || todayDrop;
  const isViewingToday = currentDrop.dateId === todayDrop.dateId;

  // Selected quote for currently active date
  const currentQuote =
    currentDrop.quotes.find((q) => q.bookId === selectedBookId) || currentDrop.quotes[0];

  // Total quotes in archive across all dates
  const totalArchiveQuotes = allDrops.length * booksList.length;

  const handleSaveSubscription = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = emailInput.trim();
    if (!clean || !clean.includes('@')) return;

    const userTimezone =
      typeof Intl !== 'undefined' && Intl.DateTimeFormat
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : 'UTC';

    const isFirstTime = !subscription;

    const currentBookIds = subscription?.bookIds?.length
      ? (subscription.bookIds.includes(currentQuote.bookId)
          ? subscription.bookIds
          : [...subscription.bookIds, currentQuote.bookId])
      : [currentQuote.bookId];

    const updated: EmailSubscription = {
      email: clean,
      frequency,
      bookIds: currentBookIds,
      timezone: userTimezone,
      sendHour: 9,
    };
    setSubscription(updated);
    try {
      localStorage.setItem(EMAIL_STORAGE_KEY, JSON.stringify(updated));
    } catch {
      // storage quota or private browsing
    }

    setTestStatusMessage(
      isFirstTime
        ? "Subscribing & dispatching today's reading..."
        : "Updating digest preferences..."
    );

    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...updated,
          timezone: userTimezone,
          sendHour: 9,
          sendImmediate: isFirstTime,
        }),
      });
      const data = await res.json();
      if (data.immediateSent) {
        setTestStatusMessage(
          `✓ Subscribed! Today's digest dispatched to ${clean}. Tomorrow & following days arrive daily at 9:00 AM.`
        );
      } else {
        setTestStatusMessage(
          `✓ Digest updated. Delivers ${frequency} at 9:00 AM.`
        );
      }
    } catch {
      setTestStatusMessage('✓ Saved preferences.');
    }

    setTimeout(() => {
      setTestStatusMessage((prev) => (prev?.startsWith('Subscribing') ? null : prev));
    }, 7000);

    setShowEmailForm(false);
  };

  const handleAddCurrentBookToDigest = () => {
    if (!subscription) {
      setShowEmailForm(true);
      return;
    }
    if (subscription.bookIds.includes(currentQuote.bookId)) return;
    const nextBookIds = [...subscription.bookIds, currentQuote.bookId];
    const userTimezone =
      typeof Intl !== 'undefined' && Intl.DateTimeFormat
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : (subscription.timezone || 'UTC');

    const updated: EmailSubscription = {
      ...subscription,
      bookIds: nextBookIds,
      timezone: userTimezone,
      sendHour: 9,
    };
    setSubscription(updated);
    try {
      localStorage.setItem(EMAIL_STORAGE_KEY, JSON.stringify(updated));
    } catch {}
    fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...updated,
        timezone: userTimezone,
        sendHour: 9,
        sendImmediate: false,
      }),
    }).catch(() => {});
    setTestStatusMessage(`Added "${currentQuote.title}" to digest (${nextBookIds.length} books in 1 email)`);
    setTimeout(() => setTestStatusMessage(null), 5000);
  };

  const handleRemoveCurrentBookFromDigest = () => {
    if (!subscription) return;
    const nextBookIds = subscription.bookIds.filter((id) => id !== currentQuote.bookId);
    if (nextBookIds.length === 0) {
      handleUnsubscribe();
      return;
    }
    const userTimezone =
      typeof Intl !== 'undefined' && Intl.DateTimeFormat
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : (subscription.timezone || 'UTC');

    const updated: EmailSubscription = {
      ...subscription,
      bookIds: nextBookIds,
      timezone: userTimezone,
      sendHour: 9,
    };
    setSubscription(updated);
    try {
      localStorage.setItem(EMAIL_STORAGE_KEY, JSON.stringify(updated));
    } catch {}
    fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...updated,
        timezone: userTimezone,
        sendHour: 9,
        sendImmediate: false,
      }),
    }).catch(() => {});
    setTestStatusMessage(`Removed from digest (${nextBookIds.length} books remaining)`);
    setTimeout(() => setTestStatusMessage(null), 4000);
  };

  const handleRemoveBookId = (bookIdToRemove: string) => {
    if (!subscription) return;
    const nextBookIds = subscription.bookIds.filter((id) => id !== bookIdToRemove);
    if (nextBookIds.length === 0) {
      handleUnsubscribe();
      return;
    }
    const userTimezone =
      typeof Intl !== 'undefined' && Intl.DateTimeFormat
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : (subscription.timezone || 'UTC');

    const updated: EmailSubscription = {
      ...subscription,
      bookIds: nextBookIds,
      timezone: userTimezone,
      sendHour: 9,
    };
    setSubscription(updated);
    try {
      localStorage.setItem(EMAIL_STORAGE_KEY, JSON.stringify(updated));
    } catch {}
    fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...updated,
        timezone: userTimezone,
        sendHour: 9,
        sendImmediate: false,
      }),
    }).catch(() => {});
  };

  const handleUnsubscribe = () => {
    const prevEmail = subscription?.email;
    setSubscription(null);
    try {
      localStorage.removeItem(EMAIL_STORAGE_KEY);
    } catch {}
    if (prevEmail) {
      fetch('/api/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: prevEmail }),
      }).catch(() => {});
    }
    setShowEmailForm(false);
    setTestStatusMessage(null);
  };

  const handleSendTestDigest = async () => {
    if (!subscription) return;
    setIsSendingTest(true);
    setTestStatusMessage('Sending combined test email via Resend...');

    const quotesToSend = subscription.bookIds
      .map((bId) => todayDrop.quotes.find((q) => q.bookId === bId))
      .filter(Boolean);

    try {
      const res = await fetch('/api/send-digest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: subscription.email,
          frequency: subscription.frequency,
          quotes: quotesToSend,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setTestStatusMessage(
          `✓ Sent 1 email with ${quotesToSend.length} ${quotesToSend.length === 1 ? 'reading' : 'readings'} to ${subscription.email}`
        );
      } else if (data.missingApiKey) {
        setTestStatusMessage(
          `✓ Combined digest ready (${quotesToSend.length} books in 1 email). Add RESEND_API_KEY in .env to deliver live.`
        );
      } else {
        setTestStatusMessage(`Resend response: ${data.error || 'Failed to dispatch'}`);
      }
    } catch (err: any) {
      setTestStatusMessage(`Error: ${err.message || 'Network request failed'}`);
    } finally {
      setIsSendingTest(false);
      setTimeout(() => {
        setTestStatusMessage((prev) => (prev?.startsWith('Sending') ? null : prev));
      }, 7000);
    }
  };

  return (
    <div className="min-h-screen bg-[#ffffff] text-[#111111] px-6 py-8 md:px-12 md:py-16 selection:bg-[#111111] selection:text-[#ffffff]">
      <div className="max-w-5xl mx-auto flex flex-col md:flex-row gap-12 md:gap-20 items-start">
        {/* Left Column: Narrow column for wordmark, reading list, archive by date, and bio */}
        <aside className="w-full md:w-72 lg:w-80 shrink-0 flex flex-col justify-between min-h-[calc(100vh-8rem)]">
          <div>
            {/* Wordmark (24-32px, regular weight) */}
            <h1 className="text-[26px] md:text-[28px] tracking-tight font-normal text-[#111111] leading-none mb-2">
              Too Long Didn't Read
            </h1>

            {/* Muted time till next update (10-12px) */}
            <div className="text-[11px] text-[#777777] mb-8 font-normal space-y-1">
              <p>next update in {countdown.hours}:{countdown.minutes}:{countdown.seconds}</p>
              {!isViewingToday && (
                <button
                  onClick={() => setSelectedDateId(todayDrop.dateId)}
                  className="text-[#111111] underline underline-offset-2 hover:opacity-75 transition-opacity block pt-1"
                >
                  ← back to today ({todayDrop.dateLabel.toLowerCase()})
                </button>
              )}
            </div>

            {/* When editing order, show the header bar right above the list */}
            {isEditingOrder && (
              <div className="mb-3 flex items-baseline justify-between text-[11px] md:text-[12px] pb-1.5 border-b border-[#eeeeee]">
                <span className="text-[#888888] font-mono lowercase tracking-wide">
                  edit order
                </span>
                <div className="flex items-center space-x-3 text-[11px]">
                  <button
                    type="button"
                    onClick={handleSaveOrder}
                    className="text-[#111111] underline underline-offset-2 hover:opacity-70 cursor-pointer lowercase"
                  >
                    save
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelOrder}
                    className="text-[#888888] hover:text-[#111111] cursor-pointer lowercase"
                  >
                    cancel
                  </button>
                </div>
              </div>
            )}

            <nav className="space-y-3.5">
              {/* Reading list */}
              {isEditingOrder ? (
                <div className="space-y-2">
                  {draftBooks.map((book, idx) => (
                    <div
                      key={book.id}
                      draggable
                      onDragStart={(e) => handleDragStart(e, idx)}
                      onDragOver={handleDragOver}
                      onDrop={(e) => handleDrop(e, idx)}
                      className="flex items-center justify-between text-[13px] md:text-[14px] leading-snug py-0.5 border-b border-transparent hover:border-[#f2f2f2]"
                    >
                      <div className="truncate pr-2 cursor-grab active:cursor-grabbing select-none">
                        <span className="text-[#222222]">{book.title}</span>
                        <span className="text-[#888888] text-[12px] ml-1.5">— {book.author}</span>
                      </div>
                      <div className="flex items-center space-x-1 shrink-0 font-mono text-[11px] text-[#777777]">
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => handleMove(idx, -1)}
                          className={`px-1 py-0.5 select-none ${
                            idx === 0 ? 'opacity-20 cursor-default' : 'hover:text-[#111111] cursor-pointer'
                          }`}
                          title="Move up"
                          aria-label={`Move ${book.title} up`}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={idx === draftBooks.length - 1}
                          onClick={() => handleMove(idx, 1)}
                          className={`px-1 py-0.5 select-none ${
                            idx === draftBooks.length - 1 ? 'opacity-20 cursor-default' : 'hover:text-[#111111] cursor-pointer'
                          }`}
                          title="Move down"
                          aria-label={`Move ${book.title} down`}
                        >
                          ↓
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-3.5">
                  {booksList.map((book, idx) => {
                    const isSelected = book.id === selectedBookId;
                    return (
                      <div key={book.id} className="relative">
                        {idx === 0 && (
                          <button
                            type="button"
                            onClick={handleStartEdit}
                            className="absolute -left-5 md:-left-6 top-[2px] w-4 h-4 flex items-center justify-center text-[13px] text-[#777777] hover:text-[#111111] leading-none select-none cursor-pointer p-0 m-0 border-0 bg-transparent"
                            title="Edit reading list order"
                            aria-label="Edit order"
                          >
                            ↕
                          </button>
                        )}
                        <button
                          onClick={() => setSelectedBookId(book.id)}
                          className={`text-left text-[14px] md:text-[15px] leading-snug transition-colors block w-full ${
                            isSelected
                              ? 'text-[#111111] font-medium'
                              : 'text-[#777777] hover:text-[#111111]'
                          }`}
                        >
                          <span className={isSelected ? 'underline underline-offset-4 decoration-1' : ''}>
                            {book.title}
                          </span>
                          <span className="text-[#888888] font-normal ml-1.5">
                            — {book.author}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Archive separated by date, not by quote or book */}
              <div className="pt-5">
                <button
                  onClick={() => setShowArchive(!showArchive)}
                  className={`text-left text-[11px] md:text-[12px] leading-snug transition-colors block uppercase tracking-wider ${
                    showArchive ? 'text-[#111111] font-medium mb-3' : 'text-[#777777] hover:text-[#111111]'
                  }`}
                >
                  archive ({totalArchiveQuotes}) {showArchive ? '—' : '+'}
                </button>

                {showArchive && (
                  <div className="space-y-2.5 pl-3 border-l border-[#eeeeee]">
                    {allDrops.map((drop) => {
                      const isDateSelected = drop.dateId === selectedDateId;
                      const isToday = drop.dateId === todayDrop.dateId;
                      return (
                        <div key={drop.dateId}>
                          <button
                            onClick={() => setSelectedDateId(drop.dateId)}
                            className={`text-left text-[13px] md:text-[14px] leading-snug transition-colors block w-full ${
                              isDateSelected
                                ? 'text-[#111111] underline underline-offset-4 decoration-1 font-medium'
                                : 'text-[#777777] hover:text-[#111111]'
                            }`}
                          >
                            <span>{drop.dateLabel.toLowerCase()}</span>
                            {isToday && (
                              <span className="text-[10px] text-[#999999] ml-2">today</span>
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </nav>
          </div>

          {/* Short bio at the very bottom of the left column in small muted text */}
          <div className="mt-16 md:mt-24 pt-6 text-[11px] leading-relaxed text-[#777777] max-w-[260px]">
            Kevin Haver. Content and Comms Strategist at DEPT®, studying communication science at UVA.
          </div>
        </aside>

        {/* Right Column: Left-aligned, narrow reading column for the selected book of the selected date */}
        <main className="w-full max-w-[560px] pt-1">
          {/* Date (10-12px, muted grey #777) */}
          <div className="text-[11px] text-[#777777] tracking-wider mb-2 font-normal">
            {currentDrop.dateLabel}
          </div>

          {/* Book Title (22-26px, near-black #111) */}
          <h2 className="text-[24px] md:text-[26px] font-normal text-[#111111] leading-tight mb-1">
            {currentQuote.title}
          </h2>

          {/* Author (14-15px, muted grey #777) */}
          <p className="text-[14px] text-[#777777] font-normal mb-10">
            {currentQuote.author} {currentQuote.year && `(${currentQuote.year})`}
          </p>

          {currentQuote.isCompleted ? (
            <div className="pt-2 pb-12">
              <p className="text-[15px] md:text-[16px] text-[#777777] font-normal leading-relaxed">
                all big ideas have been identified
              </p>
            </div>
          ) : (
            <>
              {/* The Quote (18-20px, near-black #111) */}
              <div className="mb-10">
                <p className="text-[18px] md:text-[20px] text-[#111111] leading-relaxed font-normal">
                  “{currentQuote.quote}”
                </p>
                {currentQuote.page && (
                  <p className="text-[11px] text-[#777777] font-normal mt-2">
                    p. {currentQuote.page}
                  </p>
                )}
              </div>

              {/* Real World Context (clean, no brackets, less is more) */}
              <div className="mb-8">
                <div className="text-[11px] uppercase tracking-wider text-[#777777] mb-1.5 font-normal">
                  real world context
                </div>
                <p className="text-[13px] md:text-[14px] leading-relaxed text-[#444444] font-normal">
                  {currentQuote.realWorldContext}
                </p>
              </div>

              {/* Strategic Direction (short, terse) */}
              <div className="mb-10">
                <div className="text-[11px] uppercase tracking-wider text-[#777777] mb-1.5 font-normal">
                  strategic direction
                </div>
                <p className="text-[14px] md:text-[15px] leading-relaxed text-[#222222] font-normal">
                  {currentQuote.strategicDirection}
                </p>
              </div>

              {/* Email dispatch signup */}
              <div className="mt-16 md:mt-24 mb-12">
                {!showEmailForm && !subscription && (
                  <button
                    type="button"
                    onClick={() => setShowEmailForm(true)}
                    className="text-[12px] md:text-[13px] text-[#777777] hover:text-[#111111] cursor-pointer transition-none"
                  >
                    Email me
                  </button>
                )}

                {!showEmailForm && subscription && (
                  <div className="space-y-2.5 text-[12px] md:text-[13px]">
                    {/* If current book is NOT yet in the combined digest */}
                    {!subscription.bookIds.includes(currentQuote.bookId) ? (
                      <div className="space-y-1.5">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <button
                            type="button"
                            onClick={handleAddCurrentBookToDigest}
                            className="text-[#111111] hover:opacity-70 cursor-pointer font-normal"
                          >
                            + add this book to your email digest
                          </button>
                          <span className="text-[#888888] text-[11px]">
                            ({subscription.bookIds.length} {subscription.bookIds.length === 1 ? 'book' : 'books'} currently in 1 email)
                          </span>
                        </div>
                        <div className="text-[11px] text-[#777777] flex flex-wrap items-baseline gap-2">
                          <span className="font-mono text-[#444444]">{subscription.email}</span>
                          <span className="text-[#cccccc]">·</span>
                          <span>{subscription.frequency} · 9:00 am</span>
                          <span className="text-[#cccccc]">·</span>
                          <button
                            type="button"
                            onClick={handleSendTestDigest}
                            disabled={isSendingTest}
                            className="text-[#111111] hover:underline cursor-pointer disabled:opacity-50"
                          >
                            {isSendingTest ? 'sending...' : 'send test digest'}
                          </button>
                          <span className="text-[#cccccc]">·</span>
                          <button
                            type="button"
                            onClick={() => setShowDigestManager(!showDigestManager)}
                            className="text-[#777777] hover:text-[#111111] cursor-pointer"
                          >
                            {showDigestManager ? 'hide list' : `view digest list (${subscription.bookIds.length})`}
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* Current book IS in the combined digest */
                      <div className="space-y-1.5">
                        <div className="text-[#777777] flex flex-wrap items-baseline gap-2">
                          <span className="text-[#111111] font-normal">email digest:</span>
                          <span className="font-mono text-[#111111]">{subscription.email}</span>
                          <span className="text-[#888888]">
                            ({subscription.frequency} · 9:00 am · {subscription.bookIds.length}{' '}
                            {subscription.bookIds.length === 1 ? 'book' : 'books'} in 1 email)
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2.5 text-[11px] text-[#777777]">
                          <button
                            type="button"
                            onClick={handleSendTestDigest}
                            disabled={isSendingTest}
                            className="text-[#111111] hover:underline cursor-pointer disabled:opacity-50 font-mono"
                          >
                            {isSendingTest ? 'sending...' : 'send test digest now'}
                          </button>
                          <span className="text-[#dddddd]">/</span>
                          <button
                            type="button"
                            onClick={() => setShowDigestManager(!showDigestManager)}
                            className="text-[#777777] hover:text-[#111111] cursor-pointer"
                          >
                            {showDigestManager ? 'hide list' : `view digest list (${subscription.bookIds.length})`}
                          </button>
                          <span className="text-[#dddddd]">/</span>
                          <button
                            type="button"
                            onClick={() => {
                              setEmailInput(subscription.email);
                              setFrequency(subscription.frequency);
                              setShowEmailForm(true);
                            }}
                            className="text-[#777777] hover:text-[#111111] cursor-pointer"
                          >
                            edit
                          </button>
                          <span className="text-[#dddddd]">/</span>
                          {subscription.bookIds.length > 1 ? (
                            <button
                              type="button"
                              onClick={handleRemoveCurrentBookFromDigest}
                              className="text-[#888888] hover:text-[#111111] cursor-pointer"
                            >
                              remove this book
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={handleUnsubscribe}
                              className="text-[#888888] hover:text-[#111111] cursor-pointer"
                            >
                              cancel
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Digest Manager book list */}
                    {showDigestManager && (
                      <div className="pt-2.5 pl-3 border-l border-[#eeeeee] space-y-1.5 text-[11px] max-w-md">
                        <div className="text-[#888888] uppercase tracking-wider text-[10px]">
                          Books combined into 1 daily email:
                        </div>
                        {subscription.bookIds.map((bId) => {
                          const bookObj = CHOSEN_BOOKS.find((b) => b.id === bId);
                          const isCurrent = bId === currentQuote.bookId;
                          return (
                            <div
                              key={bId}
                              className="flex items-center justify-between text-[#333333] py-0.5"
                            >
                              <span className={isCurrent ? 'font-medium text-[#111111]' : ''}>
                                {bookObj?.title || bId}
                                {isCurrent && (
                                  <span className="text-[10px] text-[#999999] ml-1.5 font-normal">
                                    (current)
                                  </span>
                                )}
                              </span>
                              {subscription.bookIds.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => handleRemoveBookId(bId)}
                                  className="text-[#aaaaaa] hover:text-[#111111] cursor-pointer ml-3 font-mono text-[12px]"
                                  title={`Remove ${bookObj?.title || bId} from digest`}
                                >
                                  ×
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Feedback / status message */}
                    {testStatusMessage && (
                      <div className="text-[11px] font-mono text-[#111111] pt-1">
                        {testStatusMessage}
                      </div>
                    )}
                  </div>
                )}

                {showEmailForm && (
                  <form onSubmit={handleSaveSubscription} className="space-y-3">
                    <div className="flex flex-wrap items-baseline gap-2 text-[12px] md:text-[13px]">
                      <span className="text-[#111111] font-medium">Email me</span>
                      <span className="text-[#888888]">—</span>
                      <label htmlFor="email-input" className="text-[#777777]">email:</label>
                      <input
                        id="email-input"
                        type="email"
                        required
                        value={emailInput}
                        onChange={(e) => setEmailInput(e.target.value)}
                        placeholder="your@email.com"
                        className="bg-transparent border-0 border-b border-[#111111] rounded-none px-0 py-0.5 text-[13px] text-[#111111] placeholder:text-[#aaaaaa] focus:outline-none focus:border-[#000000] w-52 md:w-60 font-mono transition-none"
                        autoFocus
                      />
                      <div className="flex items-center space-x-2 pl-1">
                        <button
                          type="submit"
                          className="text-[#111111] underline underline-offset-2 hover:opacity-70 cursor-pointer text-[12px]"
                        >
                          save
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowEmailForm(false)}
                          className="text-[#888888] hover:text-[#111111] cursor-pointer text-[12px]"
                        >
                          cancel
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 text-[11px] md:text-[12px] text-[#777777]">
                      <span>frequency:</span>
                      <div className="flex items-center space-x-2.5 font-mono text-[11px]">
                        {(['daily', 'weekdays', 'weekly'] as const).map((opt) => (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => setFrequency(opt)}
                            className={`cursor-pointer transition-none ${
                              frequency === opt
                                ? 'text-[#111111] underline underline-offset-4 decoration-1 font-medium'
                                : 'text-[#888888] hover:text-[#111111]'
                            }`}
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                      <span className="text-[#aaaaaa] text-[10px]">
                        (combines all added books into 1 email)
                      </span>
                    </div>

                    <div className="text-[11px] text-[#888888] font-normal pt-0.5">
                      Sends immediately on the day you sign up; subsequent digests arrive daily at 9:00 AM.
                    </div>
                  </form>
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
