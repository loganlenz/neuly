import { XMLParser } from 'fast-xml-parser';
import { BaseCrawler, CrawlResult, parseDate, cleanText, extractNumber } from '../core/BaseCrawler.js';
import {
  ResearchPaper,
  ResearchPaperSchema,
  Substance,
  Indication,
  SUBSTANCES,
  INDICATIONS
} from '../models/types.js';
import { logger } from '../utils/logger.js';

interface PubMedSearchResult {
  esearchresult?: {
    count?: string;
    retmax?: string;
    retstart?: string;
    idlist?: string[];
  };
}

interface PubMedArticle {
  MedlineCitation?: {
    PMID?: { '#text'?: string; '@_Version'?: string } | string;
    Article?: {
      ArticleTitle?: string;
      Abstract?: {
        AbstractText?: string | Array<{ '#text'?: string; '@_Label'?: string }>;
      };
      AuthorList?: {
        Author?: Array<{
          LastName?: string;
          ForeName?: string;
          Initials?: string;
          AffiliationInfo?: Array<{ Affiliation?: string }> | { Affiliation?: string };
          Identifier?: { '#text'?: string; '@_Source'?: string };
        }>;
      };
      Journal?: {
        Title?: string;
        JournalIssue?: {
          Volume?: string;
          Issue?: string;
          PubDate?: {
            Year?: string;
            Month?: string;
            Day?: string;
            MedlineDate?: string;
          };
        };
        ISSN?: string;
      };
      Pagination?: {
        MedlinePgn?: string;
      };
      ELocationID?: Array<{ '#text'?: string; '@_EIdType'?: string }> | { '#text'?: string; '@_EIdType'?: string };
      PublicationTypeList?: {
        PublicationType?: string[] | string;
      };
      ArticleDate?: {
        Year?: string;
        Month?: string;
        Day?: string;
      };
    };
    MeshHeadingList?: {
      MeshHeading?: Array<{
        DescriptorName?: { '#text'?: string };
        QualifierName?: Array<{ '#text'?: string }> | { '#text'?: string };
      }>;
    };
    KeywordList?: {
      Keyword?: string[] | string;
    };
    ChemicalList?: {
      Chemical?: Array<{
        NameOfSubstance?: { '#text'?: string };
      }>;
    };
  };
  PubmedData?: {
    ArticleIdList?: {
      ArticleId?: Array<{ '#text'?: string; '@_IdType'?: string }>;
    };
    History?: {
      PubMedPubDate?: Array<{
        '@_PubStatus'?: string;
        Year?: string;
        Month?: string;
        Day?: string;
      }>;
    };
  };
}

type PubMedCitation = NonNullable<PubMedArticle['MedlineCitation']>;
type PubMedCitationArticle = NonNullable<PubMedCitation['Article']>;

interface PubMedFetchResult {
  PubmedArticleSet?: {
    PubmedArticle?: PubMedArticle | PubMedArticle[];
  };
}

/**
 * Crawler for PubMed - fetches psychedelic research papers
 * Uses NCBI E-utilities API
 * Documentation: https://www.ncbi.nlm.nih.gov/books/NBK25500/
 */
export class PubMedCrawler extends BaseCrawler<ResearchPaper> {
  private xmlParser: XMLParser;
  private apiKey?: string;

  constructor(apiKey?: string) {
    super({
      name: 'PubMed',
      baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
      rateLimit: apiKey ? 10 : 3, // 10/sec with API key, 3/sec without
      concurrency: 2,
      retries: 3,
      timeout: 60000
    });

    this.apiKey = apiKey || process.env.NCBI_API_KEY;
    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      isArray: (name) => ['Author', 'ArticleId', 'MeshHeading', 'Chemical', 'ELocationID', 'PubMedPubDate', 'AbstractText', 'Keyword', 'AffiliationInfo', 'QualifierName'].includes(name)
    });
  }

  /**
   * Main crawl method - searches PubMed and fetches article details
   */
  async crawl(query?: string): Promise<CrawlResult<ResearchPaper>> {
    const papers: ResearchPaper[] = [];
    const errors: string[] = [];
    const startTime = Date.now();

    const searchQuery = query || 'psilocybin OR MDMA OR ketamine therapy OR psychedelic therapy';

    try {
      // Step 1: Search for article IDs
      const searchParams: Record<string, string> = {
        db: 'pubmed',
        term: searchQuery,
        retmax: '200',
        retmode: 'json',
        sort: 'relevance',
        usehistory: 'y'
      };

      if (this.apiKey) {
        searchParams.api_key = this.apiKey;
      }

      const searchResult = await this.request<PubMedSearchResult>('/esearch.fcgi', {
        params: searchParams
      });

      const pmids = searchResult.esearchresult?.idlist || [];
      logger.info(`[PubMed] Found ${pmids.length} articles for query: ${searchQuery}`);

      if (pmids.length === 0) {
        return {
          success: true,
          data: [],
          stats: {
            total: 0,
            successful: 0,
            failed: 0,
            duration: Date.now() - startTime
          }
        };
      }

      // Step 2: Fetch article details in batches
      const batchSize = 50;
      for (let i = 0; i < pmids.length; i += batchSize) {
        const batch = pmids.slice(i, i + batchSize);

        try {
          const fetchParams: Record<string, string> = {
            db: 'pubmed',
            id: batch.join(','),
            retmode: 'xml',
            rettype: 'full'
          };

          if (this.apiKey) {
            fetchParams.api_key = this.apiKey;
          }

          const response = await this.client.get('/efetch.fcgi', {
            params: fetchParams,
            responseType: 'text'
          });

          const parsed = this.xmlParser.parse(response.data) as PubMedFetchResult;
          const articles = parsed.PubmedArticleSet?.PubmedArticle;

          if (articles) {
            const articleArray = Array.isArray(articles) ? articles : [articles];

            for (const article of articleArray) {
              try {
                const transformed = this.transform(article);
                const validated = this.validate(transformed);
                if (validated) {
                  papers.push(validated);
                }
              } catch (error) {
                const pmid = this.extractPMID(article);
                errors.push(`Failed to process article ${pmid}: ${error instanceof Error ? error.message : 'Unknown error'}`);
              }
            }
          }

          logger.debug(`[PubMed] Processed batch ${i / batchSize + 1}, total papers: ${papers.length}`);

        } catch (error) {
          errors.push(`Batch fetch failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

    } catch (error) {
      errors.push(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return {
      success: errors.length === 0,
      data: papers,
      errors: errors.length > 0 ? errors : undefined,
      stats: {
        total: papers.length + errors.length,
        successful: papers.length,
        failed: errors.length,
        duration: Date.now() - startTime
      }
    };
  }

  /**
   * Transform PubMed XML data to our schema
   */
  transform(rawData: unknown): Partial<ResearchPaper> {
    const article = rawData as PubMedArticle;
    const citation = article.MedlineCitation;
    const pubmedData = article.PubmedData;

    if (!citation?.Article) {
      throw new Error('Invalid article data: missing Article section');
    }

    const pmid = this.extractPMID(article);
    const articleData = citation.Article;

    // Extract DOI
    const doi = this.extractDOI(articleData, pubmedData);

    // Extract authors
    const authors = this.extractAuthors(articleData.AuthorList?.Author || []);

    // Extract publication date
    const pubDate = this.extractPublicationDate(articleData);

    // Extract abstract
    const abstract = this.extractAbstract(articleData.Abstract?.AbstractText);

    // Extract keywords and MeSH terms
    const keywords = this.extractKeywords(citation.KeywordList?.Keyword);
    const meshTerms = this.extractMeshTerms(citation.MeshHeadingList?.MeshHeading || []);

    // Detect substances
    const substances = this.detectSubstances([
      articleData.ArticleTitle || '',
      abstract || '',
      ...keywords,
      ...meshTerms
    ]);

    // Detect indications
    const indications = this.detectIndications([
      articleData.ArticleTitle || '',
      abstract || '',
      ...keywords,
      ...meshTerms
    ]);

    // Extract publication types
    const pubTypes = articleData.PublicationTypeList?.PublicationType;
    const publicationType = Array.isArray(pubTypes) ? pubTypes : pubTypes ? [pubTypes] : undefined;

    return {
      id: this.generateId('pm', pmid),
      pmid,
      doi,
      title: cleanText(articleData.ArticleTitle) || '',
      authors,
      journal: articleData.Journal?.Title,
      publicationDate: pubDate,
      year: pubDate ? parseInt(pubDate.split('-')[0]) : undefined,
      volume: articleData.Journal?.JournalIssue?.Volume,
      issue: articleData.Journal?.JournalIssue?.Issue,
      pages: articleData.Pagination?.MedlinePgn,
      abstract: cleanText(abstract),
      keywords,
      meshTerms,
      substances,
      indications,
      publicationType,
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      isOpenAccess: undefined, // Would need separate API call to determine
      crawledAt: this.getTimestamp()
    };
  }

  /**
   * Validate data against Zod schema
   */
  validate(data: unknown): ResearchPaper | null {
    try {
      return ResearchPaperSchema.parse(data);
    } catch (error) {
      logger.warn(`[PubMed] Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  /**
   * Extract PMID from article
   */
  private extractPMID(article: PubMedArticle): string {
    const pmid = article.MedlineCitation?.PMID;
    if (typeof pmid === 'string') return pmid;
    if (pmid && typeof pmid === 'object') return pmid['#text'] || '';
    return '';
  }

  /**
   * Extract DOI from article data
   */
  private extractDOI(
    articleData: PubMedCitationArticle,
    pubmedData?: PubMedArticle['PubmedData']
  ): string | undefined {
    // Try ELocationID first
    const elocations = articleData?.ELocationID;
    if (elocations) {
      const locationArray = Array.isArray(elocations) ? elocations : [elocations];
      for (const loc of locationArray) {
        if (loc['@_EIdType'] === 'doi') {
          return loc['#text'];
        }
      }
    }

    // Try ArticleIdList
    const articleIds = pubmedData?.ArticleIdList?.ArticleId;
    if (articleIds) {
      for (const id of articleIds) {
        if (id['@_IdType'] === 'doi') {
          return id['#text'];
        }
      }
    }

    return undefined;
  }

  /**
   * Extract and format authors
   */
  private extractAuthors(
    authorList: NonNullable<PubMedCitationArticle['AuthorList']>['Author']
  ): ResearchPaper['authors'] {
    if (!authorList) return [];

    return authorList.map(author => {
      const name = [author.ForeName, author.LastName].filter(Boolean).join(' ') ||
                   author.Initials || 'Unknown';

      let affiliation: string | undefined;
      if (author.AffiliationInfo) {
        const affiliations = Array.isArray(author.AffiliationInfo)
          ? author.AffiliationInfo
          : [author.AffiliationInfo];
        affiliation = affiliations[0]?.Affiliation;
      }

      let authorId: string | undefined;
      if (author.Identifier && author.Identifier['@_Source'] === 'ORCID') {
        authorId = author.Identifier['#text'];
      }

      return { name, affiliation, authorId };
    });
  }

  /**
   * Extract publication date
   */
  private extractPublicationDate(
    articleData: PubMedCitationArticle
  ): string | undefined {
    // Try ArticleDate first (electronic publication)
    const artDate = articleData?.ArticleDate;
    if (artDate?.Year) {
      const month = artDate.Month?.padStart(2, '0') || '01';
      const day = artDate.Day?.padStart(2, '0') || '01';
      return `${artDate.Year}-${month}-${day}`;
    }

    // Fall back to Journal PubDate
    const pubDate = articleData?.Journal?.JournalIssue?.PubDate;
    if (pubDate) {
      if (pubDate.Year) {
        const month = pubDate.Month ? this.monthToNumber(pubDate.Month) : '01';
        const day = pubDate.Day?.padStart(2, '0') || '01';
        return `${pubDate.Year}-${month}-${day}`;
      }
      if (pubDate.MedlineDate) {
        // Format: "2023 Jan-Feb" or "2023"
        const match = pubDate.MedlineDate.match(/(\d{4})/);
        if (match) {
          return `${match[1]}-01-01`;
        }
      }
    }

    return undefined;
  }

  /**
   * Convert month name to number
   */
  private monthToNumber(month: string): string {
    const months: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04',
      may: '05', jun: '06', jul: '07', aug: '08',
      sep: '09', oct: '10', nov: '11', dec: '12'
    };
    return months[month.toLowerCase().slice(0, 3)] || '01';
  }

  /**
   * Extract abstract text
   */
  private extractAbstract(
    abstractText: NonNullable<PubMedCitationArticle['Abstract']>['AbstractText']
  ): string | undefined {
    if (!abstractText) return undefined;

    if (typeof abstractText === 'string') {
      return abstractText;
    }

    // Structured abstract (with labels)
    if (Array.isArray(abstractText)) {
      return abstractText
        .map(section => {
          const label = section['@_Label'];
          const text = section['#text'] || '';
          return label ? `${label}: ${text}` : text;
        })
        .join(' ');
    }

    return undefined;
  }

  /**
   * Extract keywords
   */
  private extractKeywords(
    keywords: NonNullable<PubMedCitation['KeywordList']>['Keyword']
  ): string[] {
    if (!keywords) return [];
    if (typeof keywords === 'string') return [keywords];
    return keywords.filter(Boolean);
  }

  /**
   * Extract MeSH terms
   */
  private extractMeshTerms(
    meshHeadings: NonNullable<PubMedCitation['MeshHeadingList']>['MeshHeading']
  ): string[] {
    if (!meshHeadings) return [];

    const terms: string[] = [];
    for (const heading of meshHeadings) {
      const descriptor = heading.DescriptorName?.['#text'];
      if (descriptor) {
        terms.push(descriptor);
      }
    }
    return terms;
  }

  /**
   * Detect psychedelic substances from text
   */
  private detectSubstances(texts: string[]): Substance[] {
    const found = new Set<Substance>();
    const combinedText = texts.join(' ').toLowerCase();

    const substancePatterns: Record<Substance, RegExp[]> = {
      'Psilocybin': [/psilocybin/i, /psilocin/i, /magic mushroom/i, /psilocybe/i],
      'MDMA': [/\bmdma\b/i, /3,4-methylenedioxy/i, /ecstasy/i],
      'Ketamine': [/ketamine/i, /esketamine/i, /arketamine/i],
      'LSD': [/\blsd\b/i, /lysergic/i, /d-lysergic/i],
      'DMT': [/\bdmt\b/i, /dimethyltryptamine/i],
      '5-MeO-DMT': [/5-meo-dmt/i, /5-methoxydimethyltryptamine/i],
      'Ibogaine': [/ibogaine/i, /iboga/i, /noribogaine/i],
      'Ayahuasca': [/ayahuasca/i, /harmine/i, /banisteriopsis/i],
      'Cannabis': [/cannabis/i, /cannabidiol/i, /\bcbd\b/i, /\bthc\b/i],
      'Mescaline': [/mescaline/i, /peyote/i],
      'Other': []
    };

    for (const [substance, patterns] of Object.entries(substancePatterns)) {
      if (substance === 'Other') continue;
      for (const pattern of patterns) {
        if (pattern.test(combinedText)) {
          found.add(substance as Substance);
          break;
        }
      }
    }

    return Array.from(found);
  }

  /**
   * Detect therapeutic indications from text
   */
  private detectIndications(texts: string[]): Indication[] {
    const found = new Set<Indication>();
    const combinedText = texts.join(' ').toLowerCase();

    const indicationPatterns: Partial<Record<Indication, RegExp[]>> = {
      'Treatment-Resistant Depression': [/treatment.?resistant depression/i, /\btrd\b/i],
      'Major Depressive Disorder': [/major depress/i, /\bmdd\b/i],
      'PTSD': [/\bptsd\b/i, /post.?traumatic stress/i, /trauma/i],
      'Generalized Anxiety Disorder': [/generalized anxiety/i, /\bgad\b/i],
      'End-of-Life Anxiety': [/end.?of.?life/i, /cancer.?anxiety/i, /existential distress/i],
      'Addiction': [/addiction/i, /substance use disorder/i, /\bsud\b/i],
      'Alcohol Use Disorder': [/alcohol use disorder/i, /\baud\b/i, /alcoholism/i],
      'Smoking Cessation': [/smoking cessation/i, /tobacco/i, /nicotine depend/i],
      'OCD': [/\bocd\b/i, /obsessive.?compulsive/i],
      'Chronic Pain': [/chronic pain/i, /fibromyalgia/i],
      'Cluster Headaches': [/cluster headache/i],
      'Migraine': [/migraine/i]
    };

    for (const [indication, patterns] of Object.entries(indicationPatterns)) {
      if (!patterns) continue;
      for (const pattern of patterns) {
        if (pattern.test(combinedText)) {
          found.add(indication as Indication);
          break;
        }
      }
    }

    return Array.from(found);
  }

  /**
   * Get default search queries for psychedelic research
   */
  static getDefaultQueries(): string[] {
    return [
      'psilocybin therapy clinical trial',
      'MDMA PTSD treatment',
      'ketamine depression efficacy',
      'psychedelic-assisted psychotherapy',
      'LSD anxiety treatment',
      'ibogaine addiction treatment',
      'ayahuasca depression',
      'psilocybin neuroimaging fMRI',
      'psychedelic mechanism action',
      'DMT consciousness',
      'microdosing psychedelics'
    ];
  }
}
