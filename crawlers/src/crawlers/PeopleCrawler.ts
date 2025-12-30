import { XMLParser } from 'fast-xml-parser';
import { BaseCrawler, CrawlResult, parseDate, cleanText } from '../core/BaseCrawler.js';
import {
  Person,
  PersonSchema,
  Substance,
  SUBSTANCES
} from '../models/types.js';
import { logger } from '../utils/logger.js';

/**
 * Crawler for researcher and key people data in the psychedelic medicine field
 * Combines known key figures with PubMed author data
 */
export class PeopleCrawler extends BaseCrawler<Person> {
  // Known key figures in psychedelic medicine
  private static readonly KEY_FIGURES: Partial<Person>[] = [
    {
      name: 'Dr. Robin Carhart-Harris',
      firstName: 'Robin',
      lastName: 'Carhart-Harris',
      role: 'Researcher',
      title: 'Director, Neuroscape Psychedelics Division',
      organization: 'University of California San Francisco',
      department: 'Neurology',
      location: { city: 'San Francisco', state: 'CA', country: 'United States' },
      bio: 'Leading researcher in psychedelic neuroscience, known for pioneering neuroimaging studies of psychedelics and the development of the entropic brain hypothesis. Former head of the Centre for Psychedelic Research at Imperial College London.',
      expertise: ['Psilocybin', 'LSD', 'DMT'],
      researchAreas: ['Neuroimaging', 'Depression', 'Consciousness', 'Brain Entropy'],
      publications: { count: 200, citations: 30000, hIndex: 65 },
      authorIds: { orcid: '0000-0002-6268-6671' }
    },
    {
      name: 'Rick Doblin',
      firstName: 'Rick',
      lastName: 'Doblin',
      role: 'Advocate',
      title: 'Founder and President',
      organization: 'MAPS',
      location: { city: 'San Jose', state: 'CA', country: 'United States' },
      bio: 'Founder of the Multidisciplinary Association for Psychedelic Studies (MAPS). Has spent over 30 years advocating for the medical use of psychedelics and leading MDMA research for PTSD treatment.',
      expertise: ['MDMA'],
      researchAreas: ['PTSD', 'Drug Policy', 'Psychedelic Therapy']
    },
    {
      name: 'Dr. Matthew Johnson',
      firstName: 'Matthew',
      lastName: 'Johnson',
      role: 'Researcher',
      title: 'Susan Hill Ward Professor in Psychedelics and Consciousness',
      organization: 'Johns Hopkins University',
      department: 'Psychiatry and Behavioral Sciences',
      location: { city: 'Baltimore', state: 'MD', country: 'United States' },
      bio: 'Leading psychedelic researcher at Johns Hopkins, known for psilocybin research in smoking cessation and depression. Co-founder of the Johns Hopkins Center for Psychedelic and Consciousness Research.',
      expertise: ['Psilocybin'],
      researchAreas: ['Addiction', 'Depression', 'Smoking Cessation', 'Consciousness'],
      publications: { count: 150, citations: 20000, hIndex: 55 },
      authorIds: { orcid: '0000-0002-0651-3774' }
    },
    {
      name: 'Dr. Roland Griffiths',
      firstName: 'Roland',
      lastName: 'Griffiths',
      role: 'Researcher',
      title: 'Director (Emeritus), Center for Psychedelic and Consciousness Research',
      organization: 'Johns Hopkins University',
      department: 'Psychiatry',
      location: { city: 'Baltimore', state: 'MD', country: 'United States' },
      bio: 'Pioneering psychedelic researcher whose 2006 study on psilocybin and mystical experiences reignited modern psychedelic research. Founding director of the Johns Hopkins Center for Psychedelic and Consciousness Research.',
      expertise: ['Psilocybin'],
      researchAreas: ['Mystical Experience', 'Depression', 'End-of-Life Anxiety'],
      publications: { count: 400, citations: 50000, hIndex: 95 }
    },
    {
      name: 'Dr. David Nutt',
      firstName: 'David',
      lastName: 'Nutt',
      role: 'Researcher',
      title: 'Edmond J. Safra Professor of Neuropsychopharmacology',
      organization: 'Imperial College London',
      department: 'Brain Sciences',
      location: { city: 'London', country: 'United Kingdom' },
      bio: 'Former UK government drug advisor and leading neuropsychopharmacologist. Advocate for evidence-based drug policy and co-founder of Drug Science. Pioneered psilocybin research at Imperial College.',
      expertise: ['Psilocybin', 'LSD', 'MDMA'],
      researchAreas: ['Drug Policy', 'Addiction', 'Depression', 'Neuroimaging'],
      publications: { count: 500, citations: 70000, hIndex: 120 }
    },
    {
      name: 'Dr. Gul Dolen',
      firstName: 'Gul',
      lastName: 'Dolen',
      role: 'Researcher',
      title: 'Associate Professor of Neuroscience',
      organization: 'Johns Hopkins University',
      department: 'Neuroscience',
      location: { city: 'Baltimore', state: 'MD', country: 'United States' },
      bio: 'Neuroscientist studying the mechanisms by which psychedelics open critical periods for social reward learning. Known for groundbreaking research on MDMA and octopus social behavior.',
      expertise: ['MDMA', 'Psilocybin', 'LSD'],
      researchAreas: ['Critical Periods', 'Social Learning', 'Neuroscience'],
      publications: { count: 50, citations: 5000, hIndex: 25 }
    },
    {
      name: 'Dr. David Olson',
      firstName: 'David',
      lastName: 'Olson',
      role: 'Researcher',
      title: 'Professor of Chemistry, Biochemistry and Molecular Medicine',
      organization: 'University of California Davis',
      department: 'Chemistry',
      location: { city: 'Davis', state: 'CA', country: 'United States' },
      bio: 'Chemist developing non-hallucinogenic psychedelic analogues (psychoplastogens) for treating neuropsychiatric disorders. Founder of Delix Therapeutics.',
      expertise: ['Psilocybin', 'DMT', 'LSD'],
      researchAreas: ['Medicinal Chemistry', 'Neuroplasticity', 'Drug Development'],
      publications: { count: 80, citations: 8000, hIndex: 35 }
    },
    {
      name: 'Dr. Franz Vollenweider',
      firstName: 'Franz',
      lastName: 'Vollenweider',
      role: 'Researcher',
      title: 'Professor of Psychiatry',
      organization: 'University of Zurich',
      department: 'Psychiatric Hospital',
      location: { city: 'Zurich', country: 'Switzerland' },
      bio: 'Pioneer in modern psychedelic research, conducting some of the first brain imaging studies with psilocybin in the 1990s. Expert in psychedelic pharmacology and neuroimaging.',
      expertise: ['Psilocybin', 'LSD', 'MDMA', 'Ketamine'],
      researchAreas: ['Neuroimaging', 'Pharmacology', 'Psychiatry'],
      publications: { count: 250, citations: 25000, hIndex: 70 }
    },
    {
      name: 'Dr. Katrin Preller',
      firstName: 'Katrin',
      lastName: 'Preller',
      role: 'Researcher',
      title: 'Assistant Professor',
      organization: 'Yale University',
      department: 'Psychiatry',
      location: { city: 'New Haven', state: 'CT', country: 'United States' },
      bio: 'Neuroscientist studying the effects of psychedelics on social cognition and the brain. Known for research on LSD and social processing.',
      expertise: ['LSD', 'Psilocybin'],
      researchAreas: ['Social Cognition', 'Neuroimaging', 'Psychiatry'],
      publications: { count: 80, citations: 5000, hIndex: 30 }
    },
    {
      name: 'Dr. Jennifer Mitchell',
      firstName: 'Jennifer',
      lastName: 'Mitchell',
      role: 'Researcher',
      title: 'Professor of Neurology',
      organization: 'University of California San Francisco',
      department: 'Neurology',
      location: { city: 'San Francisco', state: 'CA', country: 'United States' },
      bio: 'Neuroscientist leading clinical trials of MDMA-assisted therapy for PTSD. Principal investigator on MAPS Phase 3 trials.',
      expertise: ['MDMA'],
      researchAreas: ['PTSD', 'Clinical Trials', 'Neurology'],
      publications: { count: 100, citations: 8000, hIndex: 40 }
    },
    {
      name: 'George Goldsmith',
      firstName: 'George',
      lastName: 'Goldsmith',
      role: 'Executive',
      title: 'Co-Founder and Executive Chairman',
      organization: 'COMPASS Pathways',
      location: { city: 'London', country: 'United Kingdom' },
      bio: 'Co-founder of COMPASS Pathways, leading the development of psilocybin therapy for treatment-resistant depression. Healthcare entrepreneur and mental health advocate.',
      expertise: ['Psilocybin'],
      researchAreas: ['Drug Development', 'Mental Health', 'Healthcare Business']
    },
    {
      name: 'Dr. Florian Brand',
      firstName: 'Florian',
      lastName: 'Brand',
      role: 'Executive',
      title: 'Co-Founder and CEO',
      organization: 'Atai Life Sciences',
      location: { city: 'Berlin', country: 'Germany' },
      bio: 'Co-founder and CEO of Atai Life Sciences, a biotech company developing psychedelic and non-psychedelic compounds for mental health.',
      expertise: ['Psilocybin', 'MDMA', 'Ketamine', 'Ibogaine'],
      researchAreas: ['Drug Development', 'Biotechnology', 'Mental Health']
    },
    {
      name: 'Dr. Charles Raison',
      firstName: 'Charles',
      lastName: 'Raison',
      role: 'Researcher',
      title: 'Mary Sue and Mike Shannon Chair for Healthy Minds',
      organization: 'University of Wisconsin-Madison',
      department: 'Psychiatry',
      location: { city: 'Madison', state: 'WI', country: 'United States' },
      bio: 'Psychiatrist and researcher studying psilocybin for depression. Chief Science Officer at Usona Institute.',
      expertise: ['Psilocybin'],
      researchAreas: ['Depression', 'Inflammation', 'Mind-Body Medicine'],
      publications: { count: 200, citations: 25000, hIndex: 60 }
    },
    {
      name: 'Dr. Michael Bogenschutz',
      firstName: 'Michael',
      lastName: 'Bogenschutz',
      role: 'Researcher',
      title: 'Director, NYU Langone Center for Psychedelic Medicine',
      organization: 'NYU Langone Health',
      department: 'Psychiatry',
      location: { city: 'New York', state: 'NY', country: 'United States' },
      bio: 'Leading psilocybin researcher focusing on addiction treatment. Principal investigator on psilocybin trials for alcohol use disorder.',
      expertise: ['Psilocybin'],
      researchAreas: ['Alcohol Use Disorder', 'Addiction', 'Clinical Trials'],
      publications: { count: 100, citations: 8000, hIndex: 35 }
    },
    {
      name: 'Dr. Ben Sessa',
      firstName: 'Ben',
      lastName: 'Sessa',
      role: 'Clinician',
      title: 'Consultant Psychiatrist',
      organization: 'Awakn Life Sciences',
      location: { city: 'Bristol', country: 'United Kingdom' },
      bio: 'Child and adolescent psychiatrist, psychedelic researcher, and author. Leading MDMA-assisted therapy trials for addiction in the UK.',
      expertise: ['MDMA', 'Ketamine'],
      researchAreas: ['Addiction', 'PTSD', 'Childhood Trauma'],
      publications: { count: 50, citations: 3000, hIndex: 25 }
    }
  ];

  private xmlParser: XMLParser;

  constructor() {
    super({
      name: 'PeopleCrawler',
      baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
      rateLimit: 3,
      concurrency: 2,
      retries: 3,
      timeout: 30000
    });

    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_'
    });
  }

  /**
   * Main crawl method - fetches researcher data
   */
  async crawl(query?: string): Promise<CrawlResult<Person>> {
    const people: Person[] = [];
    const errors: string[] = [];
    const startTime = Date.now();

    logger.info(`[PeopleCrawler] Starting people crawl`);

    // Process known key figures
    for (const figure of PeopleCrawler.KEY_FIGURES) {
      try {
        const personData: Partial<Person> = {
          ...figure,
          id: this.generateId('per', this.slugify(figure.name || '')),
          crawledAt: this.getTimestamp()
        };

        // Try to fetch additional publication data from PubMed if we have their name
        if (figure.name && figure.role === 'Researcher') {
          try {
            const pubData = await this.fetchPubMedAuthorData(figure.name);
            if (pubData) {
              personData.publications = {
                ...personData.publications,
                ...pubData
              };
            }
          } catch (error) {
            logger.debug(`[PeopleCrawler] Could not fetch PubMed data for ${figure.name}`);
          }
        }

        const validated = this.validate(personData);
        if (validated) {
          people.push(validated);
        }
      } catch (error) {
        errors.push(`Failed to process ${figure.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Filter by query if provided
    let filteredPeople = people;
    if (query) {
      const queryLower = query.toLowerCase();
      filteredPeople = people.filter(person =>
        person.name.toLowerCase().includes(queryLower) ||
        person.organization?.toLowerCase().includes(queryLower) ||
        person.bio?.toLowerCase().includes(queryLower) ||
        person.expertise?.some(e => e.toLowerCase().includes(queryLower)) ||
        person.researchAreas?.some(r => r.toLowerCase().includes(queryLower))
      );
    }

    logger.info(`[PeopleCrawler] Found ${filteredPeople.length} people`);

    return {
      success: errors.length === 0,
      data: filteredPeople,
      errors: errors.length > 0 ? errors : undefined,
      stats: {
        total: filteredPeople.length + errors.length,
        successful: filteredPeople.length,
        failed: errors.length,
        duration: Date.now() - startTime
      }
    };
  }

  /**
   * Fetch author publication data from PubMed
   */
  private async fetchPubMedAuthorData(authorName: string): Promise<{ count?: number } | null> {
    try {
      // Search for author's publications
      const searchResponse = await this.request<{ esearchresult?: { count?: string } }>(
        '/esearch.fcgi',
        {
          params: {
            db: 'pubmed',
            term: `${authorName}[Author] AND psychedelic`,
            retmode: 'json'
          }
        }
      );

      const count = searchResponse.esearchresult?.count;
      if (count) {
        return { count: parseInt(count, 10) };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Transform raw data to our schema
   */
  transform(rawData: unknown): Partial<Person> {
    return rawData as Partial<Person>;
  }

  /**
   * Validate data against Zod schema
   */
  validate(data: unknown): Person | null {
    try {
      return PersonSchema.parse(data);
    } catch (error) {
      logger.warn(`[PeopleCrawler] Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
   * Get known key figures
   */
  static getKeyFigures(): Partial<Person>[] {
    return PeopleCrawler.KEY_FIGURES;
  }

  /**
   * Filter people by role
   */
  static filterByRole(people: Person[], role: Person['role']): Person[] {
    return people.filter(p => p.role === role);
  }

  /**
   * Filter people by expertise/substance
   */
  static filterByExpertise(people: Person[], substance: Substance): Person[] {
    return people.filter(p => p.expertise?.includes(substance));
  }

  /**
   * Get researchers sorted by publication count
   */
  static sortByPublications(people: Person[]): Person[] {
    return [...people].sort((a, b) => {
      const aCount = a.publications?.count || 0;
      const bCount = b.publications?.count || 0;
      return bCount - aCount;
    });
  }
}
