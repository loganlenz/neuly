import { describe, it, expect } from 'vitest';
import { PubMedCrawler } from './PubMedCrawler.js';
import { JobCrawler } from './JobCrawler.js';
import { cleanText } from '../core/BaseCrawler.js';

// Access private helpers through the prototype: these regressions shipped
// to production, so the exact behaviours are pinned here.
const pubmed = new PubMedCrawler() as unknown as {
  extractPublicationDate: (article: unknown) => string | undefined;
};
const jobs = new JobCrawler() as unknown as {
  parseLocation: (text: string) => { city?: string; state?: string; country?: string; remote?: boolean };
};

describe('PubMedCrawler.extractPublicationDate', () => {
  it('handles numeric Day/Month values produced by the XML parser', () => {
    expect(pubmed.extractPublicationDate({ ArticleDate: { Year: 2024, Month: 3, Day: 7 } })).toBe('2024-03-07');
    expect(pubmed.extractPublicationDate({
      Journal: { JournalIssue: { PubDate: { Year: 2023, Month: 'Nov', Day: 15 } } }
    })).toBe('2023-11-15');
  });

  it('handles string values and missing parts', () => {
    expect(pubmed.extractPublicationDate({ ArticleDate: { Year: '2022', Month: '11', Day: '02' } })).toBe('2022-11-02');
    expect(pubmed.extractPublicationDate({
      Journal: { JournalIssue: { PubDate: { Year: 2021 } } }
    })).toBe('2021-01-01');
    expect(pubmed.extractPublicationDate({
      Journal: { JournalIssue: { PubDate: { MedlineDate: '2020 Jan-Feb' } } }
    })).toBe('2020-01-01');
    expect(pubmed.extractPublicationDate({ Journal: {} })).toBeUndefined();
  });
});

describe('JobCrawler.parseLocation', () => {
  it('does not mistake a full state name for a two-letter code', () => {
    expect(jobs.parseLocation('Jersey City, New Jersey')).toEqual({
      city: 'Jersey City', state: 'NJ', country: 'United States', remote: false
    });
    expect(jobs.parseLocation('New York, NY')).toEqual({
      city: 'New York', state: 'NY', country: 'United States', remote: false
    });
  });

  it('parses city/country and remote variants', () => {
    expect(jobs.parseLocation('London, United Kingdom')).toEqual({
      city: 'London', state: undefined, country: 'United Kingdom', remote: false
    });
    expect(jobs.parseLocation('Remote - United States')).toEqual({ country: 'United States', remote: true });
    expect(jobs.parseLocation('Berlin, Germany (Remote)')).toMatchObject({ city: 'Berlin', country: 'Germany', remote: true });
    expect(jobs.parseLocation('')).toEqual({ remote: false });
  });

  it('cleanText tolerates parser output that is not a plain string', () => {
    expect(cleanText('  two\n lines ')).toBe('two lines');
    expect(cleanText(2024)).toBe('2024');
    expect(cleanText({ '#text': 'Psilocybin for depression', '@_Label': 'TITLE' })).toBe('Psilocybin for depression');
    expect(cleanText({ i: 'in vivo', '#text': 'Effects' })).toBe('Effects');
    expect(cleanText(undefined)).toBeUndefined();
    expect(cleanText('')).toBeUndefined();
  });
});
