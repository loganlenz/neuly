import { XMLParser } from 'fast-xml-parser';
import { BaseCrawler, CrawlResult, parseDate, cleanText } from '../core/BaseCrawler.js';
import {
  ClinicalTrial,
  ClinicalTrialSchema,
  Substance,
  SUBSTANCES,
  CLINICAL_PHASES,
  STUDY_STATUSES,
  PSYCHEDELIC_SEARCH_TERMS,
  StudyStatus,
  ClinicalPhase
} from '../models/types.js';
import { logger } from '../utils/logger.js';
import { detectSubstances as detectTrackedSubstances } from '../utils/substances.js';

interface CTGovStudy {
  protocolSection?: {
    identificationModule?: {
      nctId?: string;
      briefTitle?: string;
      officialTitle?: string;
      organization?: {
        fullName?: string;
      };
    };
    statusModule?: {
      overallStatus?: string;
      startDateStruct?: { date?: string };
      completionDateStruct?: { date?: string };
      primaryCompletionDateStruct?: { date?: string };
      lastUpdatePostDateStruct?: { date?: string };
    };
    descriptionModule?: {
      briefSummary?: string;
      detailedDescription?: string;
    };
    conditionsModule?: {
      conditions?: string[];
      keywords?: string[];
    };
    designModule?: {
      studyType?: string;
      phases?: string[];
      enrollmentInfo?: {
        count?: number;
        type?: string;
      };
    };
    armsInterventionsModule?: {
      interventions?: Array<{
        type?: string;
        name?: string;
        description?: string;
      }>;
    };
    eligibilityModule?: {
      eligibilityCriteria?: string;
    };
    contactsLocationsModule?: {
      locations?: Array<{
        facility?: string;
        city?: string;
        state?: string;
        country?: string;
      }>;
      centralContacts?: Array<{
        name?: string;
        email?: string;
        phone?: string;
      }>;
      overallOfficials?: Array<{
        name?: string;
        affiliation?: string;
        role?: string;
      }>;
    };
    sponsorCollaboratorsModule?: {
      leadSponsor?: {
        name?: string;
        class?: string;
      };
      collaborators?: Array<{
        name?: string;
      }>;
    };
  };
}

interface CTGovResponse {
  studies?: CTGovStudy[];
  totalCount?: number;
  nextPageToken?: string;
}

/**
 * Crawler for ClinicalTrials.gov - fetches psychedelic clinical trials data
 * Uses the ClinicalTrials.gov API v2
 * Documentation: https://clinicaltrials.gov/data-api/api
 */
export class ClinicalTrialsCrawler extends BaseCrawler<ClinicalTrial> {
  private xmlParser: XMLParser;

  constructor() {
    super({
      name: 'ClinicalTrials.gov',
      baseUrl: 'https://clinicaltrials.gov/api/v2',
      rateLimit: 3, // 3 requests per second (API allows more but we're being polite)
      concurrency: 2,
      retries: 3,
      timeout: 60000
    });

    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_'
    });
  }

  /**
   * Main crawl method - searches for studies matching the query
   */
  async crawl(query?: string): Promise<CrawlResult<ClinicalTrial>> {
    const trials: ClinicalTrial[] = [];
    const errors: string[] = [];
    const startTime = Date.now();

    try {
      let pageToken: string | undefined;
      let totalFetched = 0;
      const maxResults = 1000; // Limit per query

      do {
        const params: Record<string, string> = {
          'query.term': query || 'psilocybin OR MDMA OR ketamine OR LSD OR ibogaine OR ayahuasca OR psychedelic OR kratom OR kava OR salvinorin OR sceletium OR "amanita muscaria"',
          'filter.overallStatus': 'RECRUITING,ACTIVE_NOT_RECRUITING,ENROLLING_BY_INVITATION,NOT_YET_RECRUITING,COMPLETED',
          'pageSize': '100',
          'fields': [
            'NCTId',
            'BriefTitle',
            'OfficialTitle',
            'OverallStatus',
            'Phase',
            'StudyType',
            'Condition',
            'InterventionName',
            'InterventionType',
            'InterventionDescription',
            'BriefSummary',
            'DetailedDescription',
            'EligibilityCriteria',
            'EnrollmentCount',
            'StartDate',
            'CompletionDate',
            'PrimaryCompletionDate',
            'LastUpdatePostDate',
            'LocationFacility',
            'LocationCity',
            'LocationState',
            'LocationCountry',
            'CentralContactName',
            'CentralContactEMail',
            'CentralContactPhone',
            'LeadSponsorName',
            'LeadSponsorClass',
            'CollaboratorName',
            'OverallOfficialName',
            'OverallOfficialAffiliation',
            'OverallOfficialRole'
          ].join(',')
        };

        if (pageToken) {
          params['pageToken'] = pageToken;
        }

        const response = await this.request<CTGovResponse>('/studies', {
          params
        });

        if (response.studies) {
          for (const study of response.studies) {
            try {
              const transformed = this.transform(study);
              const validated = this.validate(transformed);
              if (validated) {
                trials.push(validated);
                totalFetched++;
              }
            } catch (error) {
              const nctId = study.protocolSection?.identificationModule?.nctId || 'unknown';
              errors.push(`Failed to process study ${nctId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
          }
        }

        pageToken = response.nextPageToken;
        logger.debug(`[ClinicalTrials.gov] Fetched ${totalFetched} studies so far`);

      } while (pageToken && totalFetched < maxResults);

    } catch (error) {
      errors.push(`API request failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return {
      success: errors.length === 0,
      data: trials,
      errors: errors.length > 0 ? errors : undefined,
      stats: {
        total: trials.length + errors.length,
        successful: trials.length,
        failed: errors.length,
        duration: Date.now() - startTime
      }
    };
  }

  /**
   * Transform raw API data to our schema format
   */
  transform(rawData: unknown): Partial<ClinicalTrial> {
    const study = rawData as CTGovStudy;
    const protocol = study.protocolSection;

    if (!protocol) {
      throw new Error('Invalid study data: missing protocolSection');
    }

    const nctId = protocol.identificationModule?.nctId || '';
    const conditions = protocol.conditionsModule?.conditions || [];
    const interventions = protocol.armsInterventionsModule?.interventions || [];
    const locations = protocol.contactsLocationsModule?.locations || [];
    const contacts = protocol.contactsLocationsModule?.centralContacts || [];
    const officials = (protocol.contactsLocationsModule?.overallOfficials || [])
      .filter(o => o.name)
      .map(o => ({
        name: cleanText(o.name) || o.name || '',
        affiliation: cleanText(o.affiliation),
        role: o.role ? o.role.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, ch => ch.toUpperCase()) : undefined
      }));

    // Detect substances from interventions and conditions
    const substances = this.detectSubstances([
      ...interventions.map(i => i.name || ''),
      ...interventions.map(i => i.description || ''),
      ...conditions,
      protocol.descriptionModule?.briefSummary || ''
    ]);

    // Map status to our enum
    const status = this.mapStatus(protocol.statusModule?.overallStatus || '');

    // Map phase to our enum
    const phase = this.mapPhase(protocol.designModule?.phases || []);

    return {
      id: this.generateId('ct', nctId),
      nctId,
      title: protocol.identificationModule?.officialTitle || protocol.identificationModule?.briefTitle || '',
      briefTitle: protocol.identificationModule?.briefTitle,
      officialTitle: protocol.identificationModule?.officialTitle,
      status,
      phase,
      studyType: protocol.designModule?.studyType,
      conditions,
      interventions: interventions.map(i => ({
        type: i.type || 'Drug',
        name: i.name || '',
        description: i.description
      })),
      substances,
      sponsor: protocol.sponsorCollaboratorsModule?.leadSponsor?.name,
      sponsorClass: protocol.sponsorCollaboratorsModule?.leadSponsor?.class,
      officials: officials.length > 0 ? officials : undefined,
      collaborators: protocol.sponsorCollaboratorsModule?.collaborators?.map(c => c.name || '').filter(Boolean),
      enrollment: protocol.designModule?.enrollmentInfo?.count,
      startDate: parseDate(protocol.statusModule?.startDateStruct?.date),
      completionDate: parseDate(protocol.statusModule?.completionDateStruct?.date),
      primaryCompletionDate: parseDate(protocol.statusModule?.primaryCompletionDateStruct?.date),
      locations: locations.map(loc => ({
        facility: loc.facility,
        city: loc.city,
        state: loc.state,
        country: loc.country || 'United States'
      })),
      contacts: contacts.map(c => ({
        name: c.name,
        email: c.email,
        phone: c.phone
      })),
      briefSummary: cleanText(protocol.descriptionModule?.briefSummary),
      detailedDescription: cleanText(protocol.descriptionModule?.detailedDescription),
      eligibilityCriteria: cleanText(protocol.eligibilityModule?.eligibilityCriteria),
      url: `https://clinicaltrials.gov/study/${nctId}`,
      lastUpdated: parseDate(protocol.statusModule?.lastUpdatePostDateStruct?.date) || this.getTimestamp(),
      crawledAt: this.getTimestamp()
    };
  }

  /**
   * Validate data against the Zod schema
   */
  validate(data: unknown): ClinicalTrial | null {
    try {
      return ClinicalTrialSchema.parse(data);
    } catch (error) {
      logger.warn(`[ClinicalTrials.gov] Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  /**
   * Detect tracked substances from text (shared taxonomy). Trials that are
   * clearly psychedelic but name no tracked substance are tagged 'Other'.
   */
  private detectSubstances(texts: string[]): Substance[] {
    const combinedText = texts.join(' ');
    const found = detectTrackedSubstances(combinedText);
    if (found.length === 0 && /psychedelic|hallucinogen|entheogen|psychoplastogen/i.test(combinedText)) {
      return ['Other'];
    }
    return found;
  }

  /**
   * Map ClinicalTrials.gov status to our enum
   */
  private mapStatus(status: string): StudyStatus {
    const statusMap: Record<string, StudyStatus> = {
      'NOT_YET_RECRUITING': 'Not Yet Recruiting',
      'RECRUITING': 'Recruiting',
      'ENROLLING_BY_INVITATION': 'Enrolling by Invitation',
      'ACTIVE_NOT_RECRUITING': 'Active, Not Recruiting',
      'SUSPENDED': 'Suspended',
      'TERMINATED': 'Terminated',
      'COMPLETED': 'Completed',
      'WITHDRAWN': 'Withdrawn'
    };

    return statusMap[status.toUpperCase()] || 'Unknown';
  }

  /**
   * Map ClinicalTrials.gov phase to our enum
   */
  private mapPhase(phases: string[]): ClinicalPhase | undefined {
    if (!phases || phases.length === 0) return undefined;

    const phase = phases[0].toUpperCase();

    if (phase.includes('1') && phase.includes('2')) return 'Phase 1/2';
    if (phase.includes('2') && phase.includes('3')) return 'Phase 2/3';
    if (phase.includes('1')) return 'Phase 1';
    if (phase.includes('2')) return 'Phase 2';
    if (phase.includes('3')) return 'Phase 3';
    if (phase.includes('4') || phase.includes('POST')) return 'Approved';
    if (phase.includes('EARLY') || phase.includes('0')) return 'Preclinical';

    return undefined;
  }

  /**
   * Get default search queries for psychedelic clinical trials
   */
  static getDefaultQueries(): string[] {
    return [
      'psilocybin depression',
      'psilocybin anxiety',
      'psilocybin OCD',
      'psilocybin anorexia',
      'psilocybin addiction',
      'MDMA PTSD',
      'MDMA therapy',
      'MDMA anxiety',
      'ketamine depression',
      'ketamine treatment-resistant',
      'ketamine PTSD',
      'esketamine depression',
      'LSD anxiety',
      'LSD depression',
      'ibogaine addiction',
      'ayahuasca therapy',
      'ayahuasca depression',
      'mescaline therapy',
      '5-MeO-DMT',
      'salvinorin',
      'psychedelic therapy',
      'psychedelic-assisted psychotherapy',
      'psychedelic microdosing',
      'DMT therapy',
      'psilocybin alcohol use disorder',
      'psilocybin smoking cessation',
      'psilocybin bipolar',
      'psilocybin migraine',
      'psilocybin cluster headache',
      'psilocybin cancer distress',
      'psilocybin end of life',
      'psilocybin eating disorder',
      'psilocybin PTSD',
      'MDMA social anxiety',
      'MDMA alcohol use disorder',
      'ketamine bipolar depression',
      'ketamine suicidal ideation',
      'ketamine anxiety',
      'ketamine substance use disorder',
      'esketamine treatment-resistant depression',
      'LSD cluster headache',
      'LSD generalized anxiety disorder',
      'DMT depression',
      'DMT stroke',
      'ibogaine opioid use disorder',
      'ibogaine traumatic brain injury',
      'ayahuasca PTSD',
      'psychedelic obsessive compulsive disorder',
      'psychedelic anorexia nervosa',
      'psychedelic chronic pain',
      'psychedelic fibromyalgia',
      // Plant and fungal medicines beyond the classic psychedelics
      'kratom',
      'mitragynine',
      'kava anxiety',
      'kavalactone',
      'salvinorin',
      'Salvia divinorum',
      'Sceletium tortuosum',
      'kanna',
      'Amanita muscaria',
      'cannabidiol anxiety',
      'cannabis PTSD',
      'cannabis chronic pain'
    ];
  }
}
