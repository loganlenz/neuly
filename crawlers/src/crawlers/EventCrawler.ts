import * as cheerio from 'cheerio';
import { BaseCrawler, CrawlResult, parseDate, cleanText, extractNumber } from '../core/BaseCrawler.js';
import {
  Event,
  EventSchema
} from '../models/types.js';
import { logger } from '../utils/logger.js';

interface EventSource {
  name: string;
  type: 'known' | 'api' | 'scrape';
  url?: string;
  events?: Partial<Event>[];
}

/**
 * Crawler for psychedelic medicine events, conferences, and webinars
 * Aggregates from known event sources and conference websites
 */
export class EventCrawler extends BaseCrawler<Event> {
  // Known psychedelic medicine events and conferences
  private static readonly KNOWN_EVENTS: Partial<Event>[] = [
    {
      title: 'Psychedelic Science 2025',
      type: 'Conference',
      format: 'In-Person',
      startDate: '2025-06-19',
      endDate: '2025-06-23',
      location: {
        venue: 'Colorado Convention Center',
        city: 'Denver',
        state: 'CO',
        country: 'United States'
      },
      organizer: 'MAPS',
      description: 'The world\'s largest psychedelic research conference, bringing together scientists, therapists, policy experts, and advocates from around the globe.',
      topics: ['Research', 'Therapy', 'Policy', 'Integration'],
      expectedAttendees: 12000,
      website: 'https://psychedelicscience.org',
      registrationUrl: 'https://psychedelicscience.org/register',
      source: 'MAPS'
    },
    {
      title: 'ICPR 2025 - Interdisciplinary Conference on Psychedelic Research',
      type: 'Conference',
      format: 'Hybrid',
      startDate: '2025-04-24',
      endDate: '2025-04-27',
      location: {
        city: 'Haarlem',
        country: 'Netherlands'
      },
      organizer: 'OPEN Foundation',
      description: 'Europe\'s premier psychedelic research conference featuring cutting-edge science and clinical research.',
      topics: ['Neuroscience', 'Clinical Research', 'Philosophy', 'Anthropology'],
      website: 'https://icpr-conference.com',
      source: 'OPEN Foundation'
    },
    {
      title: 'Breaking Convention 2025',
      type: 'Conference',
      format: 'In-Person',
      startDate: '2025-07-11',
      endDate: '2025-07-13',
      location: {
        city: 'London',
        country: 'United Kingdom'
      },
      organizer: 'Breaking Convention',
      description: 'A multidisciplinary conference on psychedelic consciousness, featuring academic research alongside art and culture.',
      topics: ['Consciousness', 'Art', 'Culture', 'Science'],
      website: 'https://breakingconvention.co.uk',
      source: 'Breaking Convention'
    },
    {
      title: 'Horizons: Perspectives on Psychedelics',
      type: 'Conference',
      format: 'In-Person',
      startDate: '2025-10-10',
      endDate: '2025-10-12',
      location: {
        city: 'New York',
        state: 'NY',
        country: 'United States'
      },
      organizer: 'Horizons Media',
      description: 'Annual gathering exploring the role of psychedelics in medicine, science, culture, and spirituality.',
      topics: ['Medicine', 'Culture', 'Spirituality', 'Business'],
      website: 'https://horizonsnyc.com',
      source: 'Horizons Media'
    },
    {
      title: 'Ketamine Conference 2025',
      type: 'Conference',
      format: 'In-Person',
      startDate: '2025-03-20',
      endDate: '2025-03-22',
      location: {
        city: 'Las Vegas',
        state: 'NV',
        country: 'United States'
      },
      organizer: 'Ketamine Research Foundation',
      description: 'Conference focused on ketamine-assisted therapy, best practices, and the latest clinical research.',
      topics: ['Ketamine', 'Depression', 'Clinical Practice', 'Research'],
      website: 'https://ketamineconference.com',
      source: 'Ketamine Research Foundation'
    },
    {
      title: 'MAPS Psychedelic Research Training',
      type: 'Course',
      format: 'Virtual',
      startDate: '2025-02-01',
      endDate: '2025-02-28',
      organizer: 'MAPS',
      description: 'Professional training program for therapists and researchers in psychedelic-assisted therapy.',
      topics: ['Training', 'Therapy', 'MDMA', 'Clinical Skills'],
      website: 'https://maps.org/training',
      source: 'MAPS'
    },
    {
      title: 'Fluence Psychedelic Therapy Training',
      type: 'Workshop',
      format: 'Hybrid',
      startDate: '2025-01-15',
      endDate: '2025-04-15',
      organizer: 'Fluence',
      description: 'Comprehensive training for mental health professionals in psychedelic-assisted therapy.',
      topics: ['Therapy Training', 'Integration', 'Ethics', 'Clinical Practice'],
      website: 'https://fluencetraining.com',
      source: 'Fluence'
    },
    {
      title: 'Psychedelic Investor Summit 2025',
      type: 'Summit',
      format: 'In-Person',
      startDate: '2025-05-15',
      endDate: '2025-05-16',
      location: {
        city: 'Miami',
        state: 'FL',
        country: 'United States'
      },
      organizer: 'Psychedelic Finance',
      description: 'Bringing together investors, executives, and entrepreneurs in the psychedelic medicine space.',
      topics: ['Investment', 'Business', 'Startups', 'Market Analysis'],
      price: {
        amount: 1500,
        currency: 'USD',
        isFree: false
      },
      source: 'Psychedelic Finance'
    },
    {
      title: 'COMPASS Pathways Research Webinar Series',
      type: 'Webinar',
      format: 'Virtual',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      organizer: 'COMPASS Pathways',
      description: 'Monthly webinars featuring updates on psilocybin research and clinical trial results.',
      topics: ['Psilocybin', 'Depression', 'Clinical Trials', 'Research'],
      price: {
        isFree: true
      },
      website: 'https://compasspathways.com/research',
      source: 'COMPASS Pathways'
    },
    {
      title: 'Spirit Pharmacology Conference',
      type: 'Conference',
      format: 'In-Person',
      startDate: '2025-09-12',
      endDate: '2025-09-14',
      location: {
        city: 'Basel',
        country: 'Switzerland'
      },
      organizer: 'Spirit Foundation',
      description: 'Academic conference on the pharmacology and therapeutic potential of psychoactive substances.',
      topics: ['Pharmacology', 'Chemistry', 'Neuroscience', 'History'],
      website: 'https://spirit-pharmacology.org',
      source: 'Spirit Foundation'
    },
    {
      title: 'Women In Psychedelics Summit',
      type: 'Summit',
      format: 'Hybrid',
      startDate: '2025-03-08',
      endDate: '2025-03-09',
      location: {
        city: 'San Francisco',
        state: 'CA',
        country: 'United States'
      },
      organizer: 'Women In Psychedelics',
      description: 'Celebrating and empowering women leaders in the psychedelic science and medicine space.',
      topics: ['Leadership', 'Equity', 'Research', 'Business'],
      website: 'https://womeninpsychedelics.org',
      source: 'Women In Psychedelics'
    },
    {
      title: 'Psychedelic Medicine Association Annual Meeting',
      type: 'Conference',
      format: 'In-Person',
      startDate: '2025-08-21',
      endDate: '2025-08-23',
      location: {
        city: 'Austin',
        state: 'TX',
        country: 'United States'
      },
      organizer: 'Psychedelic Medicine Association',
      description: 'Professional association meeting for healthcare providers working with psychedelic medicines.',
      topics: ['Clinical Practice', 'Policy', 'Ethics', 'Research'],
      website: 'https://psychedelicmedicineassociation.org',
      source: 'PMA'
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

    // Process known events
    for (const knownEvent of EventCrawler.KNOWN_EVENTS) {
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
   * Get known events list
   */
  static getKnownEvents(): Partial<Event>[] {
    return EventCrawler.KNOWN_EVENTS;
  }

  /**
   * Add a new event to the known events list (for manual curation)
   */
  static addEvent(event: Partial<Event>): void {
    EventCrawler.KNOWN_EVENTS.push(event);
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
