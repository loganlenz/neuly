import * as cheerio from 'cheerio';
import { BaseCrawler, CrawlResult, parseDate, cleanText, extractNumber } from '../core/BaseCrawler.js';
import {
  Event,
  EventSchema
} from '../models/types.js';
import { logger } from '../utils/logger.js';

/**
 * A recurring event template. Rather than hard-coding a fixed calendar year
 * (which silently goes stale and disappears from the site once the date
 * passes), each conference is described by *when in the year* it recurs.
 * The crawler computes the next upcoming edition on every run, so the events
 * list stays current without manual date edits.
 */
interface RecurringEventTemplate {
  /** Base title without the year; the year is appended automatically. */
  baseTitle: string;
  type: NonNullable<Event['type']>;
  format: NonNullable<Event['format']>;
  /** Month the event starts, 1-12. */
  startMonth: number;
  /** Day of month the event starts (approximate for future editions). */
  startDay: number;
  /** Length of the event in days (1 = single day). */
  durationDays: number;
  /**
   * Cadence in years (1 = annual, 2 = biennial). For non-annual events,
   * `anchorYear` fixes which years an edition lands on.
   */
  everyYears?: number;
  anchorYear?: number;
  location?: Event['location'];
  organizer?: string;
  description?: string;
  topics?: string[];
  price?: Event['price'];
  expectedAttendees?: number;
  website?: string;
  registrationUrl?: string;
  source: string;
}

/**
 * Crawler for psychedelic medicine events, conferences, and webinars.
 * Recurring conferences are defined once and projected forward to their
 * next upcoming edition on every crawl, so the calendar never empties out.
 */
export class EventCrawler extends BaseCrawler<Event> {
  // Recurring psychedelic-medicine events. Dates are projected to the next
  // upcoming edition at crawl time (see generateUpcomingEvents).
  private static readonly RECURRING_EVENTS: RecurringEventTemplate[] = [
    {
      baseTitle: 'Psychedelic Science',
      type: 'Conference',
      format: 'In-Person',
      startMonth: 6, startDay: 16, durationDays: 5,
      everyYears: 2, anchorYear: 2025,
      location: { venue: 'Colorado Convention Center', city: 'Denver', state: 'CO', country: 'United States' },
      organizer: 'MAPS',
      description: 'The world\'s largest psychedelic research conference, bringing together scientists, therapists, policy experts, and advocates from around the globe.',
      topics: ['Research', 'Therapy', 'Policy', 'Integration'],
      expectedAttendees: 12000,
      website: 'https://psychedelicscience.org',
      registrationUrl: 'https://psychedelicscience.org',
      source: 'MAPS'
    },
    {
      baseTitle: 'ICPR - Interdisciplinary Conference on Psychedelic Research',
      type: 'Conference',
      format: 'Hybrid',
      startMonth: 6, startDay: 5, durationDays: 3,
      everyYears: 2, anchorYear: 2024,
      location: { city: 'Haarlem', country: 'Netherlands' },
      organizer: 'OPEN Foundation',
      description: 'Europe\'s premier psychedelic research conference featuring cutting-edge science and clinical research.',
      topics: ['Neuroscience', 'Clinical Research', 'Philosophy', 'Anthropology'],
      website: 'https://icpr-conference.com',
      source: 'OPEN Foundation'
    },
    {
      baseTitle: 'Breaking Convention',
      type: 'Conference',
      format: 'In-Person',
      startMonth: 7, startDay: 11, durationDays: 3,
      everyYears: 2, anchorYear: 2025,
      location: { city: 'Exeter', country: 'United Kingdom' },
      organizer: 'Breaking Convention',
      description: 'A multidisciplinary conference on psychedelic consciousness, featuring academic research alongside art and culture.',
      topics: ['Consciousness', 'Art', 'Culture', 'Science'],
      website: 'https://breakingconvention.co.uk',
      source: 'Breaking Convention'
    },
    {
      baseTitle: 'Horizons: Perspectives on Psychedelics',
      type: 'Conference',
      format: 'In-Person',
      startMonth: 10, startDay: 10, durationDays: 3,
      location: { city: 'New York', state: 'NY', country: 'United States' },
      organizer: 'Horizons Media',
      description: 'Annual gathering exploring the role of psychedelics in medicine, science, culture, and spirituality.',
      topics: ['Medicine', 'Culture', 'Spirituality', 'Business'],
      website: 'https://horizonsnyc.com',
      source: 'Horizons Media'
    },
    {
      baseTitle: 'Wonderland: Miami',
      type: 'Summit',
      format: 'In-Person',
      startMonth: 11, startDay: 8, durationDays: 3,
      location: { city: 'Miami', state: 'FL', country: 'United States' },
      organizer: 'Microdose',
      description: 'A leading business and investment summit for the psychedelic medicine industry, connecting founders, investors, and clinicians.',
      topics: ['Business', 'Investment', 'Drug Development', 'Policy'],
      website: 'https://wonderlandmiami.com',
      source: 'Microdose'
    },
    {
      baseTitle: 'INSIGHT Conference',
      type: 'Conference',
      format: 'In-Person',
      startMonth: 9, startDay: 5, durationDays: 4,
      everyYears: 2, anchorYear: 2025,
      location: { city: 'Berlin', country: 'Germany' },
      organizer: 'MIND Foundation',
      description: 'The MIND Foundation\'s biennial scientific conference on psychedelic research, therapy, and integration in Europe.',
      topics: ['Research', 'Therapy', 'Neuroscience', 'Integration'],
      website: 'https://insight.mind-foundation.org',
      source: 'MIND Foundation'
    },
    {
      baseTitle: 'Interdisciplinary Psychedelic Medicine Conference',
      type: 'Conference',
      format: 'In-Person',
      startMonth: 3, startDay: 20, durationDays: 3,
      location: { city: 'Las Vegas', state: 'NV', country: 'United States' },
      organizer: 'Psychedelic Medicine Association',
      description: 'Clinical conference for healthcare providers on ketamine- and psychedelic-assisted therapy, best practices, and the latest research.',
      topics: ['Ketamine', 'Clinical Practice', 'Depression', 'Research'],
      website: 'https://psychedelicmedicineassociation.org',
      source: 'PMA'
    },
    {
      baseTitle: 'Psychedelic Science Funders Collaborative Summit',
      type: 'Summit',
      format: 'In-Person',
      startMonth: 5, startDay: 15, durationDays: 2,
      location: { city: 'San Francisco', state: 'CA', country: 'United States' },
      organizer: 'Psychedelic Science Funders Collaborative',
      description: 'A gathering of philanthropists, investors, and executives shaping the funding landscape of psychedelic medicine.',
      topics: ['Investment', 'Philanthropy', 'Business', 'Policy'],
      source: 'PSFC'
    },
    {
      baseTitle: 'Women in Psychedelics Summit',
      type: 'Summit',
      format: 'Hybrid',
      startMonth: 3, startDay: 8, durationDays: 2,
      location: { city: 'San Francisco', state: 'CA', country: 'United States' },
      organizer: 'Women In Psychedelics',
      description: 'Celebrating and empowering women leaders in the psychedelic science and medicine space.',
      topics: ['Leadership', 'Equity', 'Research', 'Business'],
      website: 'https://womeninpsychedelics.org',
      source: 'Women In Psychedelics'
    },
    {
      baseTitle: 'Spirit Pharmacology Conference',
      type: 'Conference',
      format: 'In-Person',
      startMonth: 9, startDay: 12, durationDays: 3,
      everyYears: 2, anchorYear: 2025,
      location: { city: 'Basel', country: 'Switzerland' },
      organizer: 'Spirit Foundation',
      description: 'Academic conference on the pharmacology and therapeutic potential of psychoactive substances.',
      topics: ['Pharmacology', 'Chemistry', 'Neuroscience', 'History'],
      website: 'https://spirit-pharmacology.org',
      source: 'Spirit Foundation'
    }
  ];

  constructor() {
    super({
      name: 'EventCrawler',
      baseUrl: '',
      rateLimit: 2,
      concurrency: 3,
      retries: 3,
      timeout: 30000
    });
  }

  /**
   * Main crawl method - fetches events from known sources
   */
  async crawl(query?: string): Promise<CrawlResult<Event>> {
    const events: Event[] = [];
    const errors: string[] = [];
    const startTime = Date.now();

    logger.info(`[EventCrawler] Starting event crawl`);

    // Project each recurring conference forward to its next upcoming edition.
    const upcoming = EventCrawler.generateUpcomingEvents(new Date());
    for (const knownEvent of upcoming) {
      try {
        const eventData: Partial<Event> = {
          ...knownEvent,
          id: this.generateId('evt', this.slugify(knownEvent.title || '')),
          crawledAt: this.getTimestamp()
        };

        const validated = this.validate(eventData);
        if (validated) {
          events.push(validated);
        }
      } catch (error) {
        errors.push(`Failed to process event ${knownEvent.title}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Filter by query if provided
    let filteredEvents = events;
    if (query) {
      const queryLower = query.toLowerCase();
      filteredEvents = events.filter(event =>
        event.title.toLowerCase().includes(queryLower) ||
        event.description?.toLowerCase().includes(queryLower) ||
        event.topics?.some(t => t.toLowerCase().includes(queryLower)) ||
        event.organizer?.toLowerCase().includes(queryLower)
      );
    }

    // Sort by date (upcoming first)
    filteredEvents.sort((a, b) => {
      const dateA = new Date(a.startDate);
      const dateB = new Date(b.startDate);
      return dateA.getTime() - dateB.getTime();
    });

    // Filter out past events
    const now = new Date();
    const upcomingEvents = filteredEvents.filter(event => {
      const endDate = new Date(event.endDate || event.startDate);
      return endDate >= now;
    });

    logger.info(`[EventCrawler] Found ${upcomingEvents.length} upcoming events`);

    return {
      success: errors.length === 0,
      data: upcomingEvents,
      errors: errors.length > 0 ? errors : undefined,
      stats: {
        total: upcomingEvents.length + errors.length,
        successful: upcomingEvents.length,
        failed: errors.length,
        duration: Date.now() - startTime
      }
    };
  }

  /**
   * Transform raw data to our schema
   */
  transform(rawData: unknown): Partial<Event> {
    return rawData as Partial<Event>;
  }

  /**
   * Validate data against Zod schema
   */
  validate(data: unknown): Event | null {
    try {
      return EventSchema.parse(data);
    } catch (error) {
      logger.warn(`[EventCrawler] Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  /**
   * Create URL-friendly slug from text
   */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
  }

  /**
   * Project the recurring templates to their next upcoming edition relative
   * to `reference`. Each template yields exactly one event: the soonest
   * edition whose end date has not yet passed.
   */
  static generateUpcomingEvents(reference: Date): Partial<Event>[] {
    return EventCrawler.RECURRING_EVENTS.map(template =>
      EventCrawler.nextEdition(template, reference)
    );
  }

  /**
   * Compute the next edition of a recurring event on or after `reference`.
   */
  private static nextEdition(template: RecurringEventTemplate, reference: Date): Partial<Event> {
    const everyYears = Math.max(1, template.everyYears ?? 1);
    const anchor = template.anchorYear ?? reference.getUTCFullYear();

    // Walk forward from a year at or before the reference until we land on a
    // valid cadence year whose edition hasn't ended yet.
    let year = reference.getUTCFullYear();
    // Snap to the cadence grid (anchor + k*everyYears) at or below `year`.
    year -= ((year - anchor) % everyYears + everyYears) % everyYears;

    for (let guard = 0; guard < 12; guard++) {
      const start = new Date(Date.UTC(year, template.startMonth - 1, template.startDay));
      const end = new Date(Date.UTC(year, template.startMonth - 1, template.startDay + template.durationDays - 1));
      // Keep an edition until the day after it ends.
      if (end.getTime() >= reference.getTime() - 24 * 60 * 60 * 1000) {
        return EventCrawler.buildEvent(template, start, end);
      }
      year += everyYears;
    }

    // Fallback: shouldn't happen, but return the anchor-grid edition.
    const start = new Date(Date.UTC(year, template.startMonth - 1, template.startDay));
    const end = new Date(Date.UTC(year, template.startMonth - 1, template.startDay + template.durationDays - 1));
    return EventCrawler.buildEvent(template, start, end);
  }

  private static buildEvent(template: RecurringEventTemplate, start: Date, end: Date): Partial<Event> {
    const iso = (d: Date) => d.toISOString().split('T')[0];
    return {
      title: `${template.baseTitle} ${start.getUTCFullYear()}`,
      type: template.type,
      format: template.format,
      startDate: iso(start),
      endDate: iso(end),
      location: template.location,
      organizer: template.organizer,
      description: template.description,
      topics: template.topics,
      price: template.price,
      expectedAttendees: template.expectedAttendees,
      website: template.website,
      registrationUrl: template.registrationUrl,
      source: template.source
    };
  }

  /**
   * Get the recurring event templates (for inspection / manual curation).
   */
  static getRecurringEvents(): RecurringEventTemplate[] {
    return EventCrawler.RECURRING_EVENTS;
  }

  /**
   * Add a new recurring event template (for manual curation).
   */
  static addEvent(event: RecurringEventTemplate): void {
    EventCrawler.RECURRING_EVENTS.push(event);
  }

  /**
   * Filter events by type
   */
  static filterByType(events: Event[], type: Event['type']): Event[] {
    return events.filter(e => e.type === type);
  }

  /**
   * Filter events by format
   */
  static filterByFormat(events: Event[], format: Event['format']): Event[] {
    return events.filter(e => e.format === format);
  }

  /**
   * Get events in a date range
   */
  static filterByDateRange(events: Event[], start: Date, end: Date): Event[] {
    return events.filter(e => {
      const eventStart = new Date(e.startDate);
      return eventStart >= start && eventStart <= end;
    });
  }
}
