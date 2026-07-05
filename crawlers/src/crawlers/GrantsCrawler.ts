import { BaseCrawler, CrawlResult, parseDate, cleanText } from '../core/BaseCrawler.js';
import { Grant, GrantSchema } from '../models/types.js';
import { detectSubstances } from '../utils/substances.js';
import { logger } from '../utils/logger.js';

interface ReporterProject {
  project_num?: string;
  project_title?: string;
  abstract_text?: string;
  fiscal_year?: number;
  award_amount?: number;
  organization?: { org_name?: string };
  agency_ic_admin?: { name?: string; abbreviation?: string };
  principal_investigators?: Array<{ full_name?: string; first_name?: string; last_name?: string }>;
  contact_pi_name?: string;
  project_start_date?: string;
  project_end_date?: string;
  project_detail_url?: string;
}

interface ReporterResponse {
  meta?: { total?: number; offset?: number; limit?: number };
  results?: ReporterProject[];
}

/**
 * Crawler for NIH RePORTER research grants. Federal grant funding is a
 * leading indicator: today's R01 is next year's trial and the papers
 * after that.
 * API docs: https://api.reporter.nih.gov
 */
export class GrantsCrawler extends BaseCrawler<Grant> {
  private static readonly SEARCH_TEXT =
    'psilocybin psychedelic MDMA ibogaine ayahuasca "ketamine treatment" "psychedelic-assisted"';
  private static readonly PAGE_SIZE = 500;
  private static readonly MAX_RECORDS = 5000;
  /** How many fiscal years back to sweep */
  private static readonly FISCAL_YEARS_BACK = 5;

  constructor() {
    super({
      name: 'GrantsCrawler',
      baseUrl: 'https://api.reporter.nih.gov/v2',
      rateLimit: 1,
      concurrency: 1,
      retries: 3,
      timeout: 60000
    });
  }

  async crawl(query?: string): Promise<CrawlResult<Grant>> {
    const grants: Grant[] = [];
    const errors: string[] = [];
    const startTime = Date.now();

    const currentYear = new Date().getFullYear();
    const fiscalYears = Array.from(
      { length: GrantsCrawler.FISCAL_YEARS_BACK },
      (_, i) => currentYear - i
    );

    try {
      let offset = 0;
      let total = Infinity;

      while (offset < Math.min(total, GrantsCrawler.MAX_RECORDS)) {
        const response = await this.request<ReporterResponse>('/projects/search', {
          method: 'POST',
          data: {
            criteria: {
              fiscal_years: fiscalYears,
              advanced_text_search: {
                operator: 'or',
                search_field: 'projecttitle,terms,abstracttext',
                search_text: query || GrantsCrawler.SEARCH_TEXT
              }
            },
            include_fields: [
              'ProjectNum', 'ProjectTitle', 'AbstractText', 'FiscalYear',
              'AwardAmount', 'Organization', 'AgencyIcAdmin',
              'PrincipalInvestigators', 'ContactPiName',
              'ProjectStartDate', 'ProjectEndDate', 'ProjectDetailUrl'
            ],
            offset,
            limit: GrantsCrawler.PAGE_SIZE
          }
        });

        const results = response.results || [];
        total = response.meta?.total ?? results.length;

        for (const project of results) {
          const transformed = this.transformProject(project);
          if (!transformed) continue;
          const validated = this.validate(transformed);
          if (validated) grants.push(validated);
        }

        offset += GrantsCrawler.PAGE_SIZE;
        if (results.length < GrantsCrawler.PAGE_SIZE) break;
      }

      logger.info(`[GrantsCrawler] Found ${grants.length} grants (API total: ${total === Infinity ? 'unknown' : total})`);
    } catch (error) {
      errors.push(`RePORTER search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Keep only grants that actually concern tracked substances — the
    // text search matches loosely (e.g. "ketamine" as anesthesia control)
    const relevant = grants.filter(g => g.substances.length > 0);

    return {
      success: errors.length === 0,
      data: relevant,
      errors: errors.length > 0 ? errors : undefined,
      stats: {
        total: relevant.length + errors.length,
        successful: relevant.length,
        failed: errors.length,
        duration: Date.now() - startTime
      }
    };
  }

  private transformProject(project: ReporterProject): Partial<Grant> | null {
    if (!project.project_num || !project.project_title) return null;

    const piNames = (project.principal_investigators || [])
      .map(pi => cleanText(pi.full_name || [pi.first_name, pi.last_name].filter(Boolean).join(' ')))
      .filter((name): name is string => Boolean(name));
    if (piNames.length === 0 && project.contact_pi_name) {
      const contact = cleanText(project.contact_pi_name);
      if (contact) piNames.push(contact);
    }

    const text = `${project.project_title} ${project.abstract_text || ''}`;

    return {
      id: this.generateId('grant', project.project_num),
      projectNumber: project.project_num,
      title: cleanText(project.project_title) || project.project_title,
      abstract: cleanText(project.abstract_text)?.slice(0, 5000),
      piNames,
      organization: cleanText(project.organization?.org_name),
      agency: project.agency_ic_admin?.abbreviation || project.agency_ic_admin?.name,
      fiscalYear: project.fiscal_year,
      awardAmount: project.award_amount ?? undefined,
      startDate: parseDate(project.project_start_date),
      endDate: parseDate(project.project_end_date),
      substances: detectSubstances(text),
      url: project.project_detail_url || `https://reporter.nih.gov/project-details/${encodeURIComponent(project.project_num)}`,
      source: 'NIH RePORTER',
      crawledAt: this.getTimestamp()
    };
  }

  transform(rawData: unknown): Partial<Grant> {
    return rawData as Partial<Grant>;
  }

  validate(data: unknown): Grant | null {
    try {
      return GrantSchema.parse(data);
    } catch (error) {
      logger.warn(`[GrantsCrawler] Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }
}
