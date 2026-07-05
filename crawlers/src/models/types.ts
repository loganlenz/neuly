import { z } from 'zod';

// ============================================
// ENUMS AND CONSTANTS
// ============================================

export const SUBSTANCES = [
  'Psilocybin',
  'MDMA',
  'Ketamine',
  'LSD',
  'DMT',
  '5-MeO-DMT',
  'Ibogaine',
  'Ayahuasca',
  'Cannabis',
  'Mescaline',
  'Other'
] as const;

export const INDICATIONS = [
  'Treatment-Resistant Depression',
  'Major Depressive Disorder',
  'PTSD',
  'Generalized Anxiety Disorder',
  'Social Anxiety',
  'End-of-Life Anxiety',
  'Addiction',
  'Alcohol Use Disorder',
  'Opioid Use Disorder',
  'Smoking Cessation',
  'OCD',
  'Eating Disorders',
  'Chronic Pain',
  'Cluster Headaches',
  'Migraine',
  'Other'
] as const;

export const CLINICAL_PHASES = [
  'Preclinical',
  'Phase 1',
  'Phase 1/2',
  'Phase 2',
  'Phase 2/3',
  'Phase 3',
  'FDA Review',
  'Approved'
] as const;

export const STUDY_STATUSES = [
  'Not Yet Recruiting',
  'Recruiting',
  'Enrolling by Invitation',
  'Active, Not Recruiting',
  'Suspended',
  'Terminated',
  'Completed',
  'Withdrawn',
  'Unknown'
] as const;

// ============================================
// ZOD SCHEMAS
// ============================================

// Clinical Trial Schema
export const ClinicalTrialSchema = z.object({
  id: z.string(),
  nctId: z.string(),
  title: z.string(),
  briefTitle: z.string().optional(),
  officialTitle: z.string().optional(),
  status: z.enum(STUDY_STATUSES),
  phase: z.enum(CLINICAL_PHASES).optional(),
  studyType: z.string().optional(),
  conditions: z.array(z.string()),
  interventions: z.array(z.object({
    type: z.string(),
    name: z.string(),
    description: z.string().optional()
  })),
  substances: z.array(z.enum(SUBSTANCES)),
  sponsor: z.string().optional(),
  collaborators: z.array(z.string()).optional(),
  enrollment: z.number().optional(),
  startDate: z.string().optional(),
  completionDate: z.string().optional(),
  primaryCompletionDate: z.string().optional(),
  locations: z.array(z.object({
    facility: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string()
  })).optional(),
  contacts: z.array(z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional()
  })).optional(),
  briefSummary: z.string().optional(),
  detailedDescription: z.string().optional(),
  eligibilityCriteria: z.string().optional(),
  url: z.string().url(),
  lastUpdated: z.string(),
  crawledAt: z.string()
});

// Research Paper Schema
export const ResearchPaperSchema = z.object({
  id: z.string(),
  pmid: z.string().optional(),
  doi: z.string().optional(),
  title: z.string(),
  authors: z.array(z.object({
    name: z.string(),
    affiliation: z.string().optional(),
    authorId: z.string().optional()
  })),
  journal: z.string().optional(),
  publicationDate: z.string().optional(),
  year: z.number().optional(),
  volume: z.string().optional(),
  issue: z.string().optional(),
  pages: z.string().optional(),
  abstract: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  meshTerms: z.array(z.string()).optional(),
  substances: z.array(z.enum(SUBSTANCES)),
  indications: z.array(z.enum(INDICATIONS)).optional(),
  citationCount: z.number().optional(),
  publicationType: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  pdfUrl: z.string().url().optional(),
  isOpenAccess: z.boolean().optional(),
  crawledAt: z.string()
});

// Company Schema
export const CompanySchema = z.object({
  id: z.string(),
  name: z.string(),
  legalName: z.string().optional(),
  type: z.enum(['Biotech', 'Pharma', 'Healthcare', 'Non-Profit', 'Research', 'Technology', 'Other']),
  stage: z.enum(['Pre-Seed', 'Seed', 'Series A', 'Series B', 'Series C', 'Late Stage', 'Public', 'Private']),
  ticker: z.string().optional(),
  stockExchange: z.string().optional(),
  founded: z.number().optional(),
  headquarters: z.object({
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string()
  }).optional(),
  employeeCount: z.string().optional(),
  description: z.string().optional(),
  focus: z.string().optional(),
  substances: z.array(z.enum(SUBSTANCES)),
  indications: z.array(z.enum(INDICATIONS)).optional(),
  funding: z.object({
    total: z.string().optional(),
    lastRound: z.string().optional(),
    lastRoundDate: z.string().optional(),
    investors: z.array(z.string()).optional()
  }).optional(),
  pipeline: z.array(z.object({
    drugName: z.string(),
    substance: z.enum(SUBSTANCES).optional(),
    indication: z.string(),
    phase: z.enum(CLINICAL_PHASES),
    status: z.string().optional(),
    nctId: z.string().optional()
  })).optional(),
  leadership: z.array(z.object({
    name: z.string(),
    title: z.string(),
    linkedIn: z.string().optional()
  })).optional(),
  website: z.string().url().optional(),
  linkedIn: z.string().url().optional(),
  twitter: z.string().optional(),
  secFilings: z.array(z.object({
    type: z.string(),
    date: z.string(),
    url: z.string().url()
  })).optional(),
  news: z.array(z.object({
    title: z.string(),
    date: z.string(),
    url: z.string().url().optional(),
    summary: z.string().optional()
  })).optional(),
  crawledAt: z.string()
});

// Person/Researcher Schema
export const PersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  role: z.enum(['Researcher', 'Executive', 'Clinician', 'Investor', 'Advocate', 'Educator', 'Other']),
  title: z.string().optional(),
  organization: z.string().optional(),
  department: z.string().optional(),
  location: z.object({
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional()
  }).optional(),
  bio: z.string().optional(),
  expertise: z.array(z.enum(SUBSTANCES)).optional(),
  researchAreas: z.array(z.string()).optional(),
  education: z.array(z.object({
    degree: z.string(),
    institution: z.string(),
    year: z.number().optional()
  })).optional(),
  publications: z.object({
    count: z.number().optional(),
    citations: z.number().optional(),
    hIndex: z.number().optional()
  }).optional(),
  authorIds: z.object({
    pubmed: z.string().optional(),
    orcid: z.string().optional(),
    googleScholar: z.string().optional(),
    scopus: z.string().optional()
  }).optional(),
  affiliations: z.array(z.object({
    organization: z.string(),
    role: z.string().optional(),
    current: z.boolean().optional()
  })).optional(),
  website: z.string().url().optional(),
  email: z.string().email().optional(),
  linkedIn: z.string().url().optional(),
  twitter: z.string().optional(),
  imageUrl: z.string().url().optional(),
  crawledAt: z.string()
});

// Job Posting Schema
export const JobPostingSchema = z.object({
  id: z.string(),
  title: z.string(),
  company: z.string(),
  companyId: z.string().optional(),
  type: z.enum(['Research', 'Clinical', 'Engineering', 'Policy', 'Marketing', 'Business', 'Operations', 'Other']),
  employmentType: z.enum(['Full-time', 'Part-time', 'Contract', 'Internship', 'Remote']).optional(),
  location: z.object({
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    remote: z.boolean().optional()
  }).optional(),
  salaryRange: z.object({
    min: z.number().optional(),
    max: z.number().optional(),
    currency: z.string().optional()
  }).optional(),
  description: z.string().optional(),
  requirements: z.array(z.string()).optional(),
  benefits: z.array(z.string()).optional(),
  postedDate: z.string().optional(),
  expiryDate: z.string().optional(),
  applicationUrl: z.string().url().optional(),
  source: z.string(),
  sourceUrl: z.string().url(),
  crawledAt: z.string()
});

// Event Schema
export const EventSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.enum(['Conference', 'Webinar', 'Workshop', 'Summit', 'Meetup', 'Symposium', 'Course', 'Other']),
  format: z.enum(['In-Person', 'Virtual', 'Hybrid']),
  startDate: z.string(),
  endDate: z.string().optional(),
  location: z.object({
    venue: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    address: z.string().optional()
  }).optional(),
  virtualUrl: z.string().url().optional(),
  organizer: z.string().optional(),
  description: z.string().optional(),
  topics: z.array(z.string()).optional(),
  speakers: z.array(z.object({
    name: z.string(),
    title: z.string().optional(),
    organization: z.string().optional()
  })).optional(),
  price: z.object({
    amount: z.number().optional(),
    currency: z.string().optional(),
    isFree: z.boolean().optional()
  }).optional(),
  registrationUrl: z.string().url().optional(),
  website: z.string().url().optional(),
  expectedAttendees: z.number().optional(),
  source: z.string(),
  crawledAt: z.string()
});

// Educational Resource Schema
export const EducationalResourceSchema = z.object({
  id: z.string(),
  title: z.string(),
  provider: z.string(),
  type: z.enum(['Course', 'Certification', 'Training', 'Workshop', 'Degree Program', 'Other']),
  format: z.enum(['Online', 'In-Person', 'Hybrid', 'Self-Paced']),
  description: z.string().optional(),
  topics: z.array(z.string()).optional(),
  substances: z.array(z.enum(SUBSTANCES)).optional(),
  duration: z.string().optional(),
  price: z.object({
    amount: z.number().optional(),
    currency: z.string().optional()
  }).optional(),
  accreditation: z.string().optional(),
  prerequisites: z.array(z.string()).optional(),
  targetAudience: z.array(z.string()).optional(),
  website: z.string().url().optional(),
  enrollmentUrl: z.string().url().optional(),
  crawledAt: z.string()
});

// ============================================
// TYPE EXPORTS
// ============================================

export type Substance = typeof SUBSTANCES[number];
export type Indication = typeof INDICATIONS[number];
export type ClinicalPhase = typeof CLINICAL_PHASES[number];
export type StudyStatus = typeof STUDY_STATUSES[number];

export type ClinicalTrial = z.infer<typeof ClinicalTrialSchema>;
export type ResearchPaper = z.infer<typeof ResearchPaperSchema>;
export type Company = z.infer<typeof CompanySchema>;
export type Person = z.infer<typeof PersonSchema>;
export type JobPosting = z.infer<typeof JobPostingSchema>;
export type Event = z.infer<typeof EventSchema>;
export type EducationalResource = z.infer<typeof EducationalResourceSchema>;

// Union type for all crawled data
export type CrawledData =
  | ClinicalTrial
  | ResearchPaper
  | Company
  | Person
  | JobPosting
  | Event
  | EducationalResource;

// Change Event Schema — emitted by the diff engine whenever a crawl
// adds, updates, or removes an entity. Powers alerts and the newsletter.
export const CHANGE_TYPES = ['added', 'updated', 'removed'] as const;
export type ChangeType = typeof CHANGE_TYPES[number];

export const ChangeEventSchema = z.object({
  id: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  entityTitle: z.string(),
  changeType: z.enum(CHANGE_TYPES),
  fields: z.array(z.object({
    field: z.string(),
    from: z.string().optional(),
    to: z.string().optional()
  })).optional(),
  summary: z.string(),
  detectedAt: z.string()
});

export type ChangeEvent = z.infer<typeof ChangeEventSchema>;

// ============================================
// SEARCH TERMS FOR CRAWLERS
// ============================================

export const PSYCHEDELIC_SEARCH_TERMS = [
  // Substances
  'psilocybin',
  'psilocin',
  'magic mushrooms',
  'MDMA',
  '3,4-methylenedioxymethamphetamine',
  'ketamine',
  'esketamine',
  'LSD',
  'lysergic acid diethylamide',
  'DMT',
  'dimethyltryptamine',
  '5-MeO-DMT',
  'ibogaine',
  'ayahuasca',
  'mescaline',
  'peyote',

  // Therapeutic terms
  'psychedelic therapy',
  'psychedelic-assisted therapy',
  'psychedelic-assisted psychotherapy',
  'hallucinogen therapy',
  'entheogen therapy',

  // Research terms
  'psychedelic research',
  'psychedelic clinical trial',
  'hallucinogen research',
  'psychoplastogen',

  // Company/industry terms
  'psychedelic medicine',
  'psychedelic biotech',
  'psychedelic pharma'
];

export const INDICATION_SEARCH_TERMS: Record<string, string[]> = {
  depression: [
    'treatment-resistant depression',
    'major depressive disorder',
    'MDD',
    'TRD',
    'depression psilocybin',
    'depression ketamine'
  ],
  ptsd: [
    'PTSD',
    'post-traumatic stress disorder',
    'trauma MDMA',
    'PTSD psychedelic'
  ],
  anxiety: [
    'anxiety psychedelic',
    'end-of-life anxiety',
    'cancer anxiety psilocybin',
    'generalized anxiety disorder',
    'social anxiety'
  ],
  addiction: [
    'addiction psychedelic',
    'alcohol use disorder psilocybin',
    'opioid addiction ibogaine',
    'smoking cessation psilocybin',
    'substance use disorder'
  ]
};
