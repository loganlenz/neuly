import { describe, it, expect } from 'vitest';
import { normalizeCompanyName, parseEntityKey, CompanyCrawler } from './CompanyCrawler.js';
import { FundingCrawler } from './FundingCrawler.js';
import { isRelevantFederalDocument } from './LegislationCrawler.js';
import { PeopleCrawler, normalizePersonName } from './PeopleCrawler.js';
import { CareCrawler } from './CareCrawler.js';
import type { ClinicalTrial, Grant, ResearchPaper } from '../models/types.js';

describe('CompanyCrawler helpers', () => {
  it('normalises legal suffixes for cross-source matching', () => {
    expect(normalizeCompanyName('COMPASS Pathways plc')).toBe('compass pathways');
    expect(normalizeCompanyName('Mind Medicine (MindMed) Inc.')).toBe('mind medicine');
    expect(normalizeCompanyName('Cybin Inc')).toBe(normalizeCompanyName('CYBIN INC.'));
  });

  it('parses EDGAR entity aggregation keys', () => {
    expect(parseEntityKey('COMPASS Pathways plc  (CMPS)  (CIK 0001816590)')).toEqual({
      name: 'COMPASS Pathways plc', cik: '0001816590', ticker: 'CMPS'
    });
    expect(parseEntityKey('PSYENCE BIOMEDICAL LTD.  (PBM, PBMWW)  (CIK 0001985062)')).toEqual({
      name: 'PSYENCE BIOMEDICAL LTD.', cik: '0001985062', ticker: 'PBM'
    });
    expect(parseEntityKey('Newcourt Acquisition Corp  (CIK 0001849475)')).toEqual({
      name: 'Newcourt Acquisition Corp', cik: '0001849475', ticker: undefined
    });
    expect(parseEntityKey('garbage')).toBeUndefined();
  });

  it('turns industry trial sponsors into companies with evidence', async () => {
    const trial = (overrides: Partial<ClinicalTrial>): ClinicalTrial => ({
      id: 'ct_x', nctId: 'NCT00000001', title: 't', status: 'Recruiting', conditions: ['Depression'],
      interventions: [], substances: ['Psilocybin'], url: 'https://clinicaltrials.gov/study/NCT00000001',
      lastUpdated: '2026-01-01', crawledAt: '2026-01-01', ...overrides
    });
    const crawler = new CompanyCrawler({
      skipDiscovery: true,
      trials: [
        trial({ nctId: 'NCT00000001', sponsor: 'Novel Psychedelics Ltd.', sponsorClass: 'INDUSTRY' }),
        trial({ nctId: 'NCT00000002', sponsor: 'Novel Psychedelics Ltd', sponsorClass: 'INDUSTRY', substances: ['DMT'] }),
        trial({ nctId: 'NCT00000003', sponsor: 'Johns Hopkins University', sponsorClass: 'OTHER' })
      ]
    });
    // no network: fail every request so enrichment is skipped
    (crawler as unknown as { request: () => Promise<never> }).request = async () => { throw new Error('offline'); };

    const result = await crawler.crawl();
    const novel = result.data!.find(c => c.name === 'Novel Psychedelics Ltd.');
    expect(novel).toBeDefined();
    expect(novel!.substances.sort()).toEqual(['DMT', 'Psilocybin']);
    expect(novel!.evidence).toEqual(['Sponsors NCT00000001', 'Sponsors NCT00000002']);
    expect(novel!.source).toBe('ClinicalTrials.gov sponsor');
    expect(result.data!.some(c => c.name === 'Johns Hopkins University')).toBe(false);
    // curated companies still present, with stable ids
    expect(result.data!.find(c => c.id === 'co_compass-pathways')).toBeDefined();
  });
});

describe('FundingCrawler.parseFormD', () => {
  const xml = `<?xml version="1.0"?>
<edgarSubmission>
  <submissionType>D</submissionType>
  <primaryIssuer>
    <cik>0001553643</cik>
    <entityName>RELMADA THERAPEUTICS, INC.</entityName>
    <issuerAddress><city>NEW YORK</city><stateOrCountry>NY</stateOrCountry></issuerAddress>
  </primaryIssuer>
  <relatedPersonsList>
    <relatedPersonInfo>
      <relatedPersonName><firstName>Sergio</firstName><lastName>Traversa</lastName></relatedPersonName>
      <relatedPersonRelationshipList><relationship>Executive Officer</relationship><relationship>Director</relationship></relatedPersonRelationshipList>
      <relationshipClarification>CEO</relationshipClarification>
    </relatedPersonInfo>
  </relatedPersonsList>
  <offeringData>
    <industryGroup><industryGroupType>Pharmaceuticals</industryGroupType></industryGroup>
    <typesOfSecuritiesOffered><isEquityType>true</isEquityType><isDebtType>false</isDebtType></typesOfSecuritiesOffered>
    <offeringSalesAmounts>
      <totalOfferingAmount>Indefinite</totalOfferingAmount>
      <totalAmountSold>12500000</totalAmountSold>
      <totalRemaining>0</totalRemaining>
    </offeringSalesAmounts>
    <investors><totalNumberAlreadyInvested>14</totalNumberAlreadyInvested></investors>
  </offeringData>
</edgarSubmission>`;

  it('extracts amounts, investors, securities and named officers', () => {
    const parsed = new FundingCrawler().parseFormD(xml);
    expect(parsed.totalOfferingAmount).toBeUndefined(); // "Indefinite"
    expect(parsed.totalAmountSold).toBe(12500000);
    expect(parsed.totalRemaining).toBe(0);
    expect(parsed.investorCount).toBe(14);
    expect(parsed.industryGroup).toBe('Pharmaceuticals');
    expect(parsed.securityTypes).toEqual(['Equity']);
    expect(parsed.issuerCity).toBe('New York');
    expect(parsed.issuerState).toBe('NY');
    expect(parsed.relatedPersons).toEqual([{ name: 'Sergio Traversa', roles: ['Executive Officer', 'Director', 'CEO'] }]);
  });
});

describe('LegislationCrawler relevance filter', () => {
  it('keeps documents about the sector and drops bulk controlled-substance notices', () => {
    expect(isRelevantFederalDocument('Schedules of Controlled Substances: Placement of Psilocybin in Schedule II')).toBe(true);
    expect(isRelevantFederalDocument('Breakthrough therapy designation guidance for psychedelic drug development')).toBe(true);
    expect(isRelevantFederalDocument('Importer of Controlled Substances Application: Fisher Clinical Services, Inc. Fisher has applied to be registered as an importer of basic classes of controlled substances.')).toBe(false);
  });
});

describe('PeopleCrawler derivation', () => {
  it('strips credentials and derives investigators, PIs and prolific authors with evidence', async () => {
    expect(normalizePersonName('Joshua Siegel, MD, PhD')).toBe('Joshua Siegel');
    expect(normalizePersonName('Pouya Movahed Rad, Associate Professor')).toBe('Pouya Movahed Rad');

    const trial: ClinicalTrial = {
      id: 'ct_x', nctId: 'NCT00000009', title: 't', status: 'Recruiting', conditions: ['PTSD'], interventions: [],
      substances: ['MDMA'], url: 'https://clinicaltrials.gov/study/NCT00000009', lastUpdated: '2026-01-01', crawledAt: '2026-01-01',
      officials: [{ name: 'Alex Example, MD', affiliation: 'Example University', role: 'Principal Investigator' }]
    };
    const grant: Grant = {
      id: 'grant_x', projectNumber: '1R01MH000001-01', title: 'g', piNames: ['Alex Example', 'Priya Grantholder'],
      organization: 'EXAMPLE UNIVERSITY', substances: ['Psilocybin'], source: 'NIH RePORTER', crawledAt: '2026-01-01'
    };
    const paper = (i: number): ResearchPaper => ({
      id: `pm_${i}`, title: `p${i}`, authors: [{ name: 'Prolific Author', affiliation: 'Some Institute, City' }, ...(i === 1 ? [{ name: 'Rare Author' }] : [])],
      substances: ['Ketamine'], keywords: ['depression'], crawledAt: '2026-01-01'
    });

    const crawler = new PeopleCrawler({ trials: [trial], grants: [grant], papers: [1, 2, 3, 4, 5].map(paper), minPapers: 5, skipPubMed: true });
    const result = await crawler.crawl();
    const alex = result.data!.find(p => p.name === 'Alex Example');
    expect(alex).toBeDefined();
    expect(alex!.evidence).toEqual(['Principal Investigator on NCT00000009', 'PI on NIH 1R01MH000001-01']);
    expect(alex!.expertise!.sort()).toEqual(['MDMA', 'Psilocybin']);
    expect(alex!.source).toBe('ClinicalTrials.gov; NIH RePORTER');
    expect(result.data!.find(p => p.name === 'Priya Grantholder')).toBeDefined();
    const prolific = result.data!.find(p => p.name === 'Prolific Author');
    expect(prolific!.publications?.count).toBe(5);
    expect(prolific!.organization).toBe('Some Institute');
    expect(result.data!.find(p => p.name === 'Rare Author')).toBeUndefined();
    // curated figures keep their ids
    expect(result.data!.find(p => p.id === 'per_rick-doblin')).toBeDefined();
  });
});

describe('CareCrawler', () => {
  it('ships curated providers flagged unverified when the regulator feed is skipped', async () => {
    const result = await new CareCrawler({ skipRemote: true }).crawl();
    expect(result.success).toBe(true);
    expect(result.data!.length).toBeGreaterThan(10);
    expect(result.data!.every(p => p.verified === false)).toBe(true);
    expect(result.data!.every(p => p.website?.startsWith('https://'))).toBe(true);
  });
});
