import { XMLParser } from 'fast-xml-parser';
import { BaseCrawler, CrawlResult, parseDate, cleanText } from '../core/BaseCrawler.js';
import {
  Person,
  PersonSchema,
  Substance,
  SUBSTANCES,
  ClinicalTrial,
  Grant,
  ResearchPaper
} from '../models/types.js';
import { logger } from '../utils/logger.js';

export interface PeopleCrawlerOptions {
  /** Stored trials: principal investigators and study officials */
  trials?: ClinicalTrial[];
  /** Stored NIH grants: principal investigators */
  grants?: Grant[];
  /** Stored papers: prolific authors in the corpus */
  papers?: ResearchPaper[];
  /** Minimum papers in the corpus before an author is listed (default 5) */
  minPapers?: number;
  /** Skip PubMed publication-count lookups (tests / offline) */
  skipPubMed?: boolean;
}

/** Degrees and honorifics trailing a name on ClinicalTrials.gov ("Jane Doe, MD, PhD") */
const CREDENTIALS = /\s*,?\s*\b(m\.?d\.?|ph\.?d\.?|d\.?o\.?|psy\.?d\.?|m\.?p\.?h\.?|m\.?s\.?c?\.?|m\.?a\.?|r\.?n\.?|b\.?sc?\.?|pharm\.?d\.?|f\.?r\.?c\.?p\.?c?\.?|m\.?b\.?b\.?s\.?|dr\.?|prof\.?|professor|associate professor|assistant professor|md-phd|np|pa-c|lcsw|lmft|mph|msc|mba|ms|ma|rn|bsn|dnp|frcpc|frcp|facs|faan)\b\.?/gi;

/**
 * Matching key for the same person across sources: first + last name only,
 * so "Carlos Zarate", "Carlos A Zarate" and "Dr. Carlos Zarate" collapse.
 */
export function personKey(name: string): string {
  const normalized = normalizePersonName(name);
  if (!normalized) return '';
  const words = normalized.toLowerCase().replace(/\./g, '').split(' ');
  return words.length === 1 ? words[0] : `${words[0]} ${words[words.length - 1]}`;
}

/** Strings that are organisations, hotlines or roles rather than people */
const NOT_A_PERSON = /\b(call|trial|trials|pharmaceutical|pharma|department|dept|clinical|office|contact|team|group|study|site|coordinator|hospital|university|institute|center|centre|clinic|inc|llc|ltd|k\.k\.|foundation|research|services|laborator|assist|resident|residant|student|nurse|investigator|physician|professor|program|committee|unit|division|company|corporation|hotline|information)\b/i;

/**
 * Normalise a person's name for cross-source matching.
 * ClinicalTrials.gov officials arrive as "Jane Q Doe, MD, PhD" — everything
 * after the first comma is credentials unless the name is "Last, First".
 * Returns '' when the string is not a plausible person name.
 */
export function normalizePersonName(name: string): string {
  let text = cleanText(name) || '';
  text = text.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';

  const commaParts = text.split(',').map(p => p.trim()).filter(Boolean);
  if (commaParts.length > 1) {
    const [head, second] = commaParts;
    // "Doe, Jane" → "Jane Doe"; otherwise drop the credential tail
    text = head.split(' ').length === 1 && /^[A-Z][a-z]+(\s[A-Z]\.?)?$/.test(second) && !CREDENTIALS.test(second)
      ? `${second} ${head}`
      : head;
  }

  text = text
    .replace(/^(dr|prof|professor|mr|mrs|ms|mx)\.?\s+/i, '')
    .replace(CREDENTIALS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[,;:\-\s]+$/, '');

  if (!text || /\d/.test(text)) return '';
  // "DEBORAH C. MASH" → "Deborah C. Mash" (initials stay as written)
  text = text.split(' ').map(w => (w.length > 2 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w)).join(' ');
  const words = text.split(' ');
  if (words.length < 2 || words.length > 5) return '';
  if (NOT_A_PERSON.test(text)) return '';
  // Every word should look like a name part (letters, hyphens, apostrophes, initials)
  if (!words.every(w => /^[\p{L}][\p{L}'’\-.]*$/u.test(w))) return '';
  return text;
}

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
    },
    {
      name: 'Dr. Stephen Ross',
      firstName: 'Stephen',
      lastName: 'Ross',
      role: 'Researcher',
      title: 'Associate Professor of Psychiatry',
      organization: 'NYU Langone Health',
      department: 'Psychiatry',
      location: { city: 'New York', state: 'NY', country: 'United States' },
      bio: 'Psychiatrist and addiction specialist who co-led the landmark NYU trial of psilocybin for cancer-related existential distress.',
      expertise: ['Psilocybin'],
      researchAreas: ['End-of-Life Anxiety', 'Addiction', 'Depression']
    },
    {
      name: 'Dr. Anthony Bossis',
      firstName: 'Anthony',
      lastName: 'Bossis',
      role: 'Researcher',
      title: 'Clinical Assistant Professor of Psychiatry',
      organization: 'NYU Langone Health',
      department: 'Psychiatry',
      location: { city: 'New York', state: 'NY', country: 'United States' },
      bio: 'Psychologist specializing in psilocybin-assisted therapy, palliative care, and the psychology of religious and mystical experience.',
      expertise: ['Psilocybin'],
      researchAreas: ['Palliative Care', 'End-of-Life Anxiety', 'Mystical Experience']
    },
    {
      name: 'Dr. Frederick Barrett',
      firstName: 'Frederick',
      lastName: 'Barrett',
      role: 'Researcher',
      title: 'Director, Center for Psychedelic and Consciousness Research',
      organization: 'Johns Hopkins University',
      department: 'Psychiatry and Behavioral Sciences',
      location: { city: 'Baltimore', state: 'MD', country: 'United States' },
      bio: 'Cognitive neuroscientist and current director of the Johns Hopkins Center for Psychedelic and Consciousness Research, studying the acute and enduring effects of psychedelics on the brain.',
      expertise: ['Psilocybin', 'DMT'],
      researchAreas: ['Neuroimaging', 'Cognition', 'Depression']
    },
    {
      name: 'Dr. Alan Davis',
      firstName: 'Alan',
      lastName: 'Davis',
      role: 'Researcher',
      title: 'Director, Center for Psychedelic Drug Research and Education',
      organization: 'Ohio State University',
      department: 'Social Work',
      location: { city: 'Columbus', state: 'OH', country: 'United States' },
      bio: 'Researcher studying psilocybin for major depressive disorder and the therapeutic use of psychedelics for trauma, including among veterans.',
      expertise: ['Psilocybin', '5-MeO-DMT'],
      researchAreas: ['Depression', 'PTSD', 'Veterans']
    },
    {
      name: 'Dr. Albert Garcia-Romeu',
      firstName: 'Albert',
      lastName: 'Garcia-Romeu',
      role: 'Researcher',
      title: 'Assistant Professor of Psychiatry',
      organization: 'Johns Hopkins University',
      department: 'Psychiatry and Behavioral Sciences',
      location: { city: 'Baltimore', state: 'MD', country: 'United States' },
      bio: 'Psychopharmacologist researching psilocybin for addiction and depression, with a focus on the psychological mechanisms of psychedelic therapy.',
      expertise: ['Psilocybin'],
      researchAreas: ['Addiction', 'Smoking Cessation', 'Depression']
    },
    {
      name: 'Dr. Nolan Williams',
      firstName: 'Nolan',
      lastName: 'Williams',
      role: 'Researcher',
      title: 'Associate Professor of Psychiatry and Behavioral Sciences',
      organization: 'Stanford University',
      department: 'Psychiatry',
      location: { city: 'Stanford', state: 'CA', country: 'United States' },
      bio: 'Neurologist and psychiatrist leading trials of ibogaine for traumatic brain injury in veterans and developer of accelerated neurostimulation protocols for depression.',
      expertise: ['Ibogaine', 'DMT'],
      researchAreas: ['Traumatic Brain Injury', 'Depression', 'Neurostimulation']
    },
    {
      name: 'Dr. Boris Heifets',
      firstName: 'Boris',
      lastName: 'Heifets',
      role: 'Researcher',
      title: 'Assistant Professor of Anesthesiology',
      organization: 'Stanford University',
      department: 'Anesthesiology',
      location: { city: 'Stanford', state: 'CA', country: 'United States' },
      bio: 'Anesthesiologist and neuroscientist investigating the mechanisms of ketamine and MDMA, including the role of expectancy and consciousness in antidepressant response.',
      expertise: ['Ketamine', 'MDMA'],
      researchAreas: ['Anesthesiology', 'Depression', 'Mechanism of Action']
    },
    {
      name: 'Dr. Rachel Yehuda',
      firstName: 'Rachel',
      lastName: 'Yehuda',
      role: 'Researcher',
      title: 'Director, Center for Psychedelic Psychotherapy and Trauma Research',
      organization: 'Icahn School of Medicine at Mount Sinai',
      department: 'Psychiatry',
      location: { city: 'New York', state: 'NY', country: 'United States' },
      bio: 'Pioneering PTSD and epigenetics researcher leading studies of MDMA-assisted therapy for trauma at Mount Sinai.',
      expertise: ['MDMA'],
      researchAreas: ['PTSD', 'Trauma', 'Epigenetics']
    },
    {
      name: 'Dr. John Krystal',
      firstName: 'John',
      lastName: 'Krystal',
      role: 'Researcher',
      title: 'Chair, Department of Psychiatry',
      organization: 'Yale University',
      department: 'Psychiatry',
      location: { city: 'New Haven', state: 'CT', country: 'United States' },
      bio: 'Psychiatrist whose foundational work established ketamine as a rapid-acting antidepressant, reshaping modern depression treatment.',
      expertise: ['Ketamine'],
      researchAreas: ['Depression', 'Treatment-Resistant Depression', 'Neuropharmacology']
    },
    {
      name: 'Dr. Gerard Sanacora',
      firstName: 'Gerard',
      lastName: 'Sanacora',
      role: 'Researcher',
      title: 'Director, Yale Depression Research Program',
      organization: 'Yale University',
      department: 'Psychiatry',
      location: { city: 'New Haven', state: 'CT', country: 'United States' },
      bio: 'Psychiatrist and leading authority on the clinical use of ketamine for treatment-resistant depression and mood disorders.',
      expertise: ['Ketamine'],
      researchAreas: ['Depression', 'Mood Disorders']
    },
    {
      name: 'Dr. Carlos Zarate',
      firstName: 'Carlos',
      lastName: 'Zarate',
      role: 'Researcher',
      title: 'Chief, Experimental Therapeutics and Pathophysiology Branch',
      organization: 'National Institute of Mental Health',
      department: 'Experimental Therapeutics',
      location: { city: 'Bethesda', state: 'MD', country: 'United States' },
      bio: 'NIMH researcher whose studies demonstrated ketamine\'s rapid antidepressant effects, catalyzing a new field of rapid-acting therapeutics.',
      expertise: ['Ketamine'],
      researchAreas: ['Depression', 'Bipolar Disorder', 'Suicidality']
    },
    {
      name: 'Dr. Charles Grob',
      firstName: 'Charles',
      lastName: 'Grob',
      role: 'Researcher',
      title: 'Professor of Psychiatry and Pediatrics',
      organization: 'UCLA',
      department: 'Psychiatry',
      location: { city: 'Los Angeles', state: 'CA', country: 'United States' },
      bio: 'Psychiatrist who conducted some of the first modern US trials of psilocybin for cancer-related anxiety and early ayahuasca research.',
      expertise: ['Psilocybin', 'Ayahuasca', 'MDMA'],
      researchAreas: ['End-of-Life Anxiety', 'Ethnopharmacology']
    },
    {
      name: 'Dr. Joshua Woolley',
      firstName: 'Joshua',
      lastName: 'Woolley',
      role: 'Researcher',
      title: 'Associate Professor of Psychiatry',
      organization: 'University of California San Francisco',
      department: 'Psychiatry',
      location: { city: 'San Francisco', state: 'CA', country: 'United States' },
      bio: 'Psychiatrist directing the UCSF Translational Psychedelic Research (TrPR) Program, studying psilocybin for depression and social cognition.',
      expertise: ['Psilocybin'],
      researchAreas: ['Depression', 'Social Cognition', 'Neuroimaging']
    },
    {
      name: 'Amanda Feilding',
      firstName: 'Amanda',
      lastName: 'Feilding',
      role: 'Advocate',
      title: 'Founder and Director',
      organization: 'Beckley Foundation',
      location: { city: 'Oxford', country: 'United Kingdom' },
      bio: 'Founder of the Beckley Foundation and a driving force behind modern psychedelic science and drug-policy reform, collaborating on pioneering LSD and psilocybin brain-imaging research.',
      expertise: ['LSD', 'Psilocybin', 'DMT'],
      researchAreas: ['Drug Policy', 'Neuroimaging', 'Consciousness']
    },
    {
      name: 'Paul Stamets',
      firstName: 'Paul',
      lastName: 'Stamets',
      role: 'Advocate',
      title: 'Mycologist and Founder',
      organization: 'Fungi Perfecti',
      location: { city: 'Shelton', state: 'WA', country: 'United States' },
      bio: 'World-renowned mycologist and author, a prominent advocate for the therapeutic potential of psilocybin mushrooms and stacking/microdosing research.',
      expertise: ['Psilocybin'],
      researchAreas: ['Mycology', 'Microdosing', 'Neurogenesis']
    },
    {
      name: 'Dr. Rick Strassman',
      firstName: 'Rick',
      lastName: 'Strassman',
      role: 'Researcher',
      title: 'Clinical Associate Professor of Psychiatry',
      organization: 'University of New Mexico',
      department: 'Psychiatry',
      location: { city: 'Albuquerque', state: 'NM', country: 'United States' },
      bio: 'Psychiatrist who conducted the first new US clinical research on DMT in the 1990s and authored "DMT: The Spirit Molecule."',
      expertise: ['DMT', '5-MeO-DMT'],
      researchAreas: ['Consciousness', 'Pharmacology']
    },
    {
      name: 'Dr. Guy Goodwin',
      firstName: 'Guy',
      lastName: 'Goodwin',
      role: 'Executive',
      title: 'Chief Medical Officer',
      organization: 'COMPASS Pathways',
      location: { city: 'London', country: 'United Kingdom' },
      bio: 'Emeritus Professor of Psychiatry at Oxford and Chief Medical Officer of COMPASS Pathways, overseeing the clinical development of psilocybin therapy for treatment-resistant depression.',
      expertise: ['Psilocybin'],
      researchAreas: ['Depression', 'Bipolar Disorder', 'Clinical Trials']
    },
    {
      name: 'Christian Angermayer',
      firstName: 'Christian',
      lastName: 'Angermayer',
      role: 'Investor',
      title: 'Founder',
      organization: 'Atai Life Sciences',
      location: { city: 'London', country: 'United Kingdom' },
      bio: 'Entrepreneur and investor who founded Atai Life Sciences and has been a leading financial backer of the psychedelic medicine industry.',
      expertise: ['Psilocybin', 'MDMA', 'DMT', 'Ibogaine'],
      researchAreas: ['Biotechnology', 'Investment', 'Drug Development']
    },
    {
      name: 'Robert Barrow',
      firstName: 'Robert',
      lastName: 'Barrow',
      role: 'Executive',
      title: 'Chief Executive Officer',
      organization: 'MindMed',
      location: { city: 'New York', state: 'NY', country: 'United States' },
      bio: 'Drug-development executive leading MindMed\'s clinical programs, including LSD (MM120) for generalized anxiety disorder and depression.',
      expertise: ['LSD', 'DMT'],
      researchAreas: ['Drug Development', 'Anxiety', 'Depression']
    },
    {
      name: 'Dr. Kabir Nath',
      firstName: 'Kabir',
      lastName: 'Nath',
      role: 'Executive',
      title: 'Chief Executive Officer',
      organization: 'COMPASS Pathways',
      location: { city: 'London', country: 'United Kingdom' },
      bio: 'Healthcare executive serving as CEO of COMPASS Pathways, leading the company\'s late-stage psilocybin therapy development.',
      expertise: ['Psilocybin'],
      researchAreas: ['Drug Development', 'Mental Health', 'Commercialization']
    },
    {
      name: 'Dr. Sandeep Nayak',
      firstName: 'Sandeep',
      lastName: 'Nayak',
      role: 'Researcher',
      title: 'Assistant Professor of Psychiatry',
      organization: 'Johns Hopkins University',
      department: 'Psychiatry and Behavioral Sciences',
      location: { city: 'Baltimore', state: 'MD', country: 'United States' },
      bio: 'Psychiatrist at the Johns Hopkins Center for Psychedelic and Consciousness Research studying psilocybin for addiction and depression.',
      expertise: ['Psilocybin'],
      researchAreas: ['Addiction', 'Depression']
    }
  ];

  private xmlParser: XMLParser;

  private readonly options: PeopleCrawlerOptions;

  constructor(options: PeopleCrawlerOptions = {}) {
    super({
      name: 'PeopleCrawler',
      baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
      rateLimit: 3,
      concurrency: 2,
      retries: 3,
      timeout: 30000
    });

    this.xmlParser = new XMLParser({
      // Keep every text node a string: <Day>7</Day>, <PMID>…</PMID>, <Volume>12</Volume>
      // would otherwise be coerced to numbers and break string handling downstream.
      parseTagValue: false,
      ignoreAttributes: false,
      attributeNamePrefix: '@_'
    });
    this.options = options;
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
          source: 'Curated',
          crawledAt: this.getTimestamp()
        };

        // Try to fetch additional publication data from PubMed if we have their name
        if (figure.name && figure.role === 'Researcher' && !this.options.skipPubMed) {
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

    // Derived people: investigators, grant PIs, prolific authors. Curated
    // entries win on collisions; derived records carry their evidence.
    const seen = new Set(people.map(p => personKey(p.name)));
    const derived = this.derivePeople();
    let added = 0;
    for (const person of derived) {
      const key = personKey(person.name || '');
      if (!key || seen.has(key)) continue;
      const validated = this.validate({ ...person, crawledAt: this.getTimestamp() });
      if (validated) {
        people.push(validated);
        seen.add(key);
        added++;
      }
    }
    if (added > 0) {
      logger.info(`[PeopleCrawler] ${added} people derived from stored trials, grants and papers`);
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
   * Build people records from the datasets already in the database:
   *  - ClinicalTrials.gov overall officials (principal investigators)
   *  - NIH RePORTER principal investigators
   *  - Authors with at least `minPapers` papers in the stored corpus
   * Each record lists the evidence (NCT ids, grant numbers, paper counts).
   */
  private derivePeople(): Partial<Person>[] {
    const byName = new Map<string, Partial<Person> & { evidence: string[]; expertiseSet: Set<Substance>; sources: Set<string> }>();

    const upsert = (rawName: string, patch: Partial<Person>, evidence: string, source: string, substances: Substance[]) => {
      const name = normalizePersonName(rawName);
      if (!name || name.length > 80) return;
      const key = personKey(name);
      const current = byName.get(key) ?? {
        id: this.generateId('per', this.slugify(name)),
        name,
        role: 'Researcher' as Person['role'],
        evidence: [],
        expertiseSet: new Set<Substance>(),
        sources: new Set<string>()
      };
      current.title = current.title || patch.title;
      current.organization = current.organization || patch.organization;
      current.researchAreas = Array.from(new Set([...(current.researchAreas || []), ...(patch.researchAreas || [])])).slice(0, 12);
      if (patch.publications?.count && !current.publications?.count) current.publications = patch.publications;
      if (evidence && current.evidence.length < 30) current.evidence.push(evidence);
      for (const s of substances) if (s !== 'Other') current.expertiseSet.add(s);
      current.sources.add(source);
      byName.set(key, current);
    };

    for (const trial of this.options.trials ?? []) {
      for (const official of trial.officials ?? []) {
        if (!official.name) continue;
        const role = official.role || 'Investigator';
        upsert(official.name, {
          title: role.replace(/\b\w/g, ch => ch.toUpperCase()),
          organization: official.affiliation,
          researchAreas: trial.conditions.slice(0, 3)
        }, `${role} on ${trial.nctId}`, 'ClinicalTrials.gov', trial.substances);
      }
    }

    for (const grant of this.options.grants ?? []) {
      for (const pi of grant.piNames) {
        upsert(pi, {
          title: 'Principal Investigator',
          organization: grant.organization
        }, `PI on NIH ${grant.projectNumber}`, 'NIH RePORTER', grant.substances);
      }
    }

    const minPapers = this.options.minPapers ?? 5;
    const authorCounts = new Map<string, { name: string; count: number; affiliation?: string; substances: Set<Substance>; areas: Map<string, number> }>();
    for (const paper of this.options.papers ?? []) {
      for (const author of paper.authors) {
        const name = normalizePersonName(author.name);
        // PubMed stores "Doe JQ" — an initials-only surname form is not a display name
        if (!name || /^et al/i.test(name) || /\b[A-Z]{1,3}$/.test(name)) continue;
        const key = personKey(name);
        const entry = authorCounts.get(key) ?? { name, count: 0, affiliation: undefined, substances: new Set<Substance>(), areas: new Map() };
        entry.count++;
        entry.affiliation = entry.affiliation || cleanText(author.affiliation);
        for (const s of paper.substances) entry.substances.add(s);
        for (const k of paper.keywords ?? []) entry.areas.set(k, (entry.areas.get(k) ?? 0) + 1);
        authorCounts.set(key, entry);
      }
    }
    for (const entry of authorCounts.values()) {
      if (entry.count < minPapers) continue;
      const areas = Array.from(entry.areas.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
      upsert(entry.name, {
        organization: entry.affiliation?.split(/[,;]/)[0]?.trim().slice(0, 120),
        researchAreas: areas,
        publications: { count: entry.count }
      }, `${entry.count} papers in the Neuly corpus`, 'PubMed author corpus', Array.from(entry.substances));
    }

    return Array.from(byName.values()).map(({ evidence, expertiseSet, sources, ...person }) => ({
      ...person,
      expertise: expertiseSet.size > 0 ? Array.from(expertiseSet) : undefined,
      evidence,
      source: Array.from(sources).join('; ')
    }));
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
