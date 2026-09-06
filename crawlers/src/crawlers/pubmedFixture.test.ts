import { describe, it, expect } from 'vitest';
import { PubMedCrawler } from './PubMedCrawler.js';

/**
 * Regression: fast-xml-parser coerced numeric text nodes (Day, PMID, Volume)
 * to numbers, which crashed every article in production. The parser is now
 * configured to keep strings; this pins the whole parse → transform → validate
 * path on a realistic efetch payload.
 */
const XML = `<?xml version="1.0" ?>
<PubmedArticleSet>
<PubmedArticle>
  <MedlineCitation Status="MEDLINE" Owner="NLM">
    <PMID Version="1">37234567</PMID>
    <Article PubModel="Print-Electronic">
      <Journal>
        <ISSN IssnType="Electronic">1091-6490</ISSN>
        <JournalIssue CitedMedium="Internet"><Volume>120</Volume><Issue>7</Issue><PubDate><Year>2023</Year><Month>Feb</Month><Day>7</Day></PubDate></JournalIssue>
        <Title>Proceedings of the National Academy of Sciences</Title>
      </Journal>
      <ArticleTitle>Psilocybin desynchronizes the human brain</ArticleTitle>
      <Pagination><MedlinePgn>e2211234120</MedlinePgn></Pagination>
      <ELocationID EIdType="doi" ValidYN="Y">10.1073/pnas.2211234120</ELocationID>
      <Abstract><AbstractText Label="BACKGROUND">Psilocybin alters cortical dynamics in treatment-resistant depression.</AbstractText></Abstract>
      <AuthorList CompleteYN="Y">
        <Author ValidYN="Y"><LastName>Siegel</LastName><ForeName>Joshua S</ForeName><Initials>JS</Initials><AffiliationInfo><Affiliation>Washington University in St. Louis</Affiliation></AffiliationInfo></Author>
        <Author ValidYN="Y"><LastName>Dosenbach</LastName><ForeName>Nico</ForeName><Initials>N</Initials></Author>
      </AuthorList>
      <ArticleDate DateType="Electronic"><Year>2023</Year><Month>01</Month><Day>30</Day></ArticleDate>
      <PublicationTypeList><PublicationType UI="D016428">Journal Article</PublicationType></PublicationTypeList>
    </Article>
    <MeshHeadingList><MeshHeading><DescriptorName UI="D011562" MajorTopicYN="Y">Psilocybin</DescriptorName></MeshHeading></MeshHeadingList>
    <KeywordList Owner="NOTNLM"><Keyword MajorTopicYN="N">psychedelics</Keyword><Keyword MajorTopicYN="N">fMRI</Keyword></KeywordList>
  </MedlineCitation>
</PubmedArticle>
</PubmedArticleSet>`;

describe('PubMedCrawler efetch parsing', () => {
  it('keeps numeric text nodes as strings and produces a valid paper', () => {
    const crawler = new PubMedCrawler('') as unknown as {
      xmlParser: { parse: (xml: string) => { PubmedArticleSet?: { PubmedArticle?: unknown } } };
      transform: (article: unknown) => unknown;
      validate: (data: unknown) => { id: string; pmid?: string; doi?: string; publicationDate?: string; year?: number; volume?: string; authors: Array<{ name: string }>; substances: string[]; url?: string } | null;
    };
    const parsed = crawler.xmlParser.parse(XML);
    const article = parsed.PubmedArticleSet!.PubmedArticle!;
    const paper = crawler.validate(crawler.transform(article));
    expect(paper).not.toBeNull();
    expect(paper!.id).toBe('pm_37234567');
    expect(paper!.pmid).toBe('37234567');
    expect(paper!.doi).toBe('10.1073/pnas.2211234120');
    expect(paper!.publicationDate).toBe('2023-01-30');
    expect(paper!.year).toBe(2023);
    expect(paper!.volume).toBe('120');
    expect(paper!.authors.map(a => a.name)).toContain('Joshua S Siegel');
    expect(paper!.substances).toEqual(['Psilocybin']);
    expect((paper as unknown as { keywords: string[] }).keywords).toEqual(['psychedelics', 'fMRI']);
    expect((paper as unknown as { publicationType: string[] }).publicationType).toEqual(['Journal Article']);
    expect(paper!.url).toBe('https://pubmed.ncbi.nlm.nih.gov/37234567/');
  });
});
