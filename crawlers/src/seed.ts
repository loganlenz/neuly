#!/usr/bin/env node
/**
 * Seed script - populates the data directory with comprehensive initial data
 * This data matches the dashboard's expected formats so the API serves data
 * the frontend can immediately display.
 *
 * Usage: npx tsx src/seed.ts
 */
import 'dotenv/config';
import { createStorage } from './utils/storageBackend.js';
import { logger } from './utils/logger.js';

const storage = await createStorage();

// ============================================
// COMPANIES
// ============================================
const companies = [
  {
    id: 'co_compass-pathways',
    name: 'COMPASS Pathways',
    type: 'Biotech',
    stage: 'Public',
    ticker: 'CMPS',
    founded: 2016,
    headquarters: { city: 'London', country: 'United Kingdom' },
    employeeCount: '150+',
    substances: ['Psilocybin'],
    description: 'COMPASS Pathways is a mental health care company dedicated to accelerating patient access to evidence-based innovation in mental health. Their lead program, COMP360, is a proprietary psilocybin therapy being evaluated in Phase 3 clinical trials for treatment-resistant depression, with additional studies for PTSD and anorexia nervosa.',
    focus: 'Treatment-resistant depression',
    funding: { total: '$240M+' },
    website: 'https://compasspathways.com',
    pipeline: [
      { drugName: 'COMP360', substance: 'Psilocybin', indication: 'Treatment-Resistant Depression', phase: 'Phase 3', status: 'Active', nctId: 'NCT05624268' },
      { drugName: 'COMP360', substance: 'Psilocybin', indication: 'PTSD', phase: 'Phase 2', status: 'Recruiting' },
      { drugName: 'COMP360', substance: 'Psilocybin', indication: 'Anorexia Nervosa', phase: 'Phase 2', status: 'Active' }
    ],
    leadership: [
      { name: 'George Goldsmith', title: 'Co-Founder & Executive Chairman' },
      { name: 'Ekaterina Malievskaia, MD', title: 'Co-Founder & CMO' }
    ],
    news: [
      { title: 'Positive Topline Results from First Phase 3 Study in TRD', date: '2025-06-15', summary: 'Phase 3 met primary endpoint' },
      { title: 'Second Phase 3 Study Results Expected H2 2026', date: '2024-11-01' },
      { title: 'Exploratory Study Shows COMP360 Works with SSRI Medications', date: '2024-10-01' }
    ],
    crawledAt: new Date().toISOString()
  },
  {
    id: 'co_lykos-therapeutics',
    name: 'Lykos Therapeutics',
    type: 'Biotech',
    stage: 'Private',
    founded: 1986,
    headquarters: { city: 'San Jose', state: 'CA', country: 'United States' },
    employeeCount: '100+',
    substances: ['MDMA'],
    description: 'Lykos Therapeutics, the for-profit arm of MAPS, has pioneered MDMA-assisted therapy for PTSD. After 38 years of advocacy and research, they completed Phase 3 trials showing 67% of participants no longer met PTSD criteria.',
    focus: 'PTSD treatment',
    funding: { total: '$100M+' },
    website: 'https://lfrx.com',
    pipeline: [
      { drugName: 'MDMA-AT', substance: 'MDMA', indication: 'PTSD', phase: 'Phase 3', status: 'Complete' },
      { drugName: 'MDMA-AT', substance: 'MDMA', indication: 'PTSD (Additional Trial)', phase: 'Phase 3', status: 'Planning' }
    ],
    leadership: [{ name: 'Rick Doblin, PhD', title: 'Founder' }],
    news: [
      { title: 'FDA Issues Complete Response Letter, Requests Additional Trial', date: '2024-08-01' },
      { title: 'Phase 3 Results Published in Nature Medicine', date: '2023-09-01' }
    ],
    crawledAt: new Date().toISOString()
  },
  {
    id: 'co_atai-life-sciences',
    name: 'Atai Life Sciences',
    type: 'Biotech',
    stage: 'Public',
    ticker: 'ATAI',
    founded: 2018,
    headquarters: { city: 'Berlin', country: 'Germany' },
    employeeCount: '200+',
    substances: ['Psilocybin', 'MDMA', 'Ketamine', 'DMT', 'Ibogaine'],
    description: 'Atai Life Sciences is a clinical-stage biopharmaceutical company with a hub-and-spoke model, developing multiple psychedelic and non-psychedelic compounds through strategic investments and subsidiaries.',
    focus: 'Multiple mental health indications',
    funding: { total: '$360M+' },
    website: 'https://atai.life',
    pipeline: [
      { drugName: 'PCN-101 (R-ketamine)', substance: 'Ketamine', indication: 'Treatment-Resistant Depression', phase: 'Phase 2', status: 'Active' },
      { drugName: 'BPL-003 (Psilocybin)', substance: 'Psilocybin', indication: 'Treatment-Resistant Depression', phase: 'Phase 2', status: 'Complete' },
      { drugName: 'VLS-01 (DMT)', substance: 'DMT', indication: 'Treatment-Resistant Depression', phase: 'Phase 2', status: 'Active' },
      { drugName: 'TRP-8802 (Ibogaine)', substance: 'Ibogaine', indication: 'Opioid Use Disorder', phase: 'Phase 1', status: 'Active' }
    ],
    leadership: [{ name: 'Florian Brand', title: 'Co-Founder & CEO' }],
    news: [
      { title: 'Merger Agreement with Beckley Psytech Announced', date: '2024-06-01' },
      { title: 'BPL-003 Phase 2b Meets Primary Endpoints', date: '2024-07-01' }
    ],
    crawledAt: new Date().toISOString()
  },
  {
    id: 'co_mindmed',
    name: 'MindMed',
    type: 'Biotech',
    stage: 'Public',
    ticker: 'MNMD',
    founded: 2019,
    headquarters: { city: 'New York', state: 'NY', country: 'United States' },
    employeeCount: '80+',
    substances: ['LSD'],
    description: 'MindMed is developing next-generation psychedelic medicines, with its lead candidate MM120, an optimized form of LSD for generalized anxiety disorder. Received FDA Breakthrough Therapy Designation in 2024.',
    focus: 'Generalized anxiety disorder',
    funding: { total: '$200M+' },
    website: 'https://mindmed.co',
    pipeline: [
      { drugName: 'MM120 (LSD)', substance: 'LSD', indication: 'Generalized Anxiety Disorder', phase: 'Phase 3', status: 'Active' },
      { drugName: 'MM120 (LSD)', substance: 'LSD', indication: 'Major Depressive Disorder', phase: 'Phase 3', status: 'Recruiting' },
      { drugName: 'MM402 (R-MDMA)', substance: 'MDMA', indication: 'Autism Spectrum Disorder', phase: 'Phase 1', status: 'Active' }
    ],
    leadership: [{ name: 'Robert Barrow', title: 'CEO' }],
    news: [
      { title: 'First Patient Dosed in Second Phase 3 GAD Trial', date: '2025-01-15' },
      { title: 'FDA Grants Breakthrough Therapy Designation for MM120', date: '2024-03-01' }
    ],
    crawledAt: new Date().toISOString()
  },
  {
    id: 'co_cybin',
    name: 'Cybin Inc.',
    type: 'Biotech',
    stage: 'Public',
    ticker: 'CYBN',
    founded: 2019,
    headquarters: { city: 'Toronto', country: 'Canada' },
    employeeCount: '80+',
    substances: ['Psilocybin', 'DMT'],
    description: 'Cybin is a biotechnology company developing psychedelic therapeutics using proprietary deuteration and drug delivery technologies. Lead candidate CYB003 is a deuterated psilocybin analog in Phase 3 for major depressive disorder.',
    focus: 'Major depressive disorder',
    funding: { total: '$150M+' },
    website: 'https://cybin.com',
    pipeline: [
      { drugName: 'CYB003 (Deuterated Psilocybin)', substance: 'Psilocybin', indication: 'Major Depressive Disorder', phase: 'Phase 3', status: 'Active' },
      { drugName: 'CYB004 (Deuterated DMT)', substance: 'DMT', indication: 'Generalized Anxiety Disorder', phase: 'Phase 2', status: 'Active' }
    ],
    leadership: [{ name: 'Doug Drysdale', title: 'CEO' }],
    news: [
      { title: 'FDA Grants Breakthrough Therapy Designation for CYB003', date: '2024-03-01' },
      { title: 'Phase 3 Trial Initiated with 30+ Sites', date: '2024-08-01' }
    ],
    crawledAt: new Date().toISOString()
  },
  {
    id: 'co_numinus',
    name: 'Numinus Wellness',
    type: 'Healthcare',
    stage: 'Public',
    ticker: 'NUMI',
    founded: 2019,
    headquarters: { city: 'Vancouver', country: 'Canada' },
    employeeCount: '120+',
    substances: ['Psilocybin', 'MDMA', 'Ketamine'],
    description: 'Numinus Wellness is a mental health company creating safe, evidence-based psychedelic-assisted therapy through a network of clinics across North America, combining therapy with ketamine and facilitating clinical trials for MDMA and psilocybin.',
    focus: 'Mental health clinics',
    funding: { total: '$80M+' },
    website: 'https://numinus.com',
    pipeline: [
      { drugName: 'Ketamine-Assisted Therapy', substance: 'Ketamine', indication: 'Depression', phase: 'Approved', status: 'Active' },
      { drugName: 'MDMA-Assisted Therapy', substance: 'MDMA', indication: 'PTSD', phase: 'Phase 3', status: 'Collaborating' }
    ],
    leadership: [{ name: 'Payton Nyquvest', title: 'Founder & CEO' }],
    crawledAt: new Date().toISOString()
  },
  {
    id: 'co_usona',
    name: 'Usona Institute',
    type: 'Non-Profit',
    stage: 'Private',
    founded: 2014,
    headquarters: { city: 'Madison', state: 'WI', country: 'United States' },
    employeeCount: '50+',
    substances: ['Psilocybin'],
    description: 'Usona Institute is a nonprofit medical research organization conducting FDA-regulated Phase 2 clinical trials of psilocybin for major depressive disorder, with a mission to fund and support open-access research.',
    focus: 'Major depressive disorder',
    website: 'https://usonainstitute.org',
    pipeline: [
      { drugName: 'Psilocybin', substance: 'Psilocybin', indication: 'Major Depressive Disorder', phase: 'Phase 2', status: 'Active' }
    ],
    leadership: [{ name: 'Dr. Charles Raison', title: 'Chief Science Officer' }],
    crawledAt: new Date().toISOString()
  },
  {
    id: 'co_beckley-psytech',
    name: 'Beckley Psytech',
    type: 'Biotech',
    stage: 'Private',
    founded: 2019,
    headquarters: { city: 'Oxford', country: 'United Kingdom' },
    employeeCount: '60+',
    substances: ['Psilocybin', '5-MeO-DMT'],
    description: 'Beckley Psytech is developing psychedelic therapies including BPL-003, a proprietary synthetic psilocybin formulation, and 5-MeO-DMT for treatment-resistant depression. Recently agreed to merge with Atai Life Sciences.',
    focus: 'Depression and anxiety',
    funding: { total: '$100M+' },
    website: 'https://beckleypsytech.com',
    pipeline: [
      { drugName: 'BPL-003 (Psilocybin)', substance: 'Psilocybin', indication: 'Treatment-Resistant Depression', phase: 'Phase 2', status: 'Complete' },
      { drugName: '5-MeO-DMT', substance: '5-MeO-DMT', indication: 'Treatment-Resistant Depression', phase: 'Phase 1', status: 'Active' }
    ],
    crawledAt: new Date().toISOString()
  },
  {
    id: 'co_delix',
    name: 'Delix Therapeutics',
    type: 'Biotech',
    stage: 'Private',
    founded: 2019,
    headquarters: { city: 'Boston', state: 'MA', country: 'United States' },
    employeeCount: '50+',
    substances: ['Psilocybin', 'Other'],
    description: 'Delix Therapeutics is developing non-hallucinogenic neuroplasticity-promoting therapeutics (psychoplastogens) based on the chemistry of psychedelic compounds, led by co-founder Dr. David Olson.',
    focus: 'Neuroplasticity-promoting therapeutics',
    funding: { total: '$120M+' },
    website: 'https://delixtherapeutics.com',
    pipeline: [
      { drugName: 'DLX-001', indication: 'Major Depressive Disorder', phase: 'Phase 1', status: 'Active' }
    ],
    crawledAt: new Date().toISOString()
  },
  {
    id: 'co_awakn',
    name: 'Awakn Life Sciences',
    type: 'Biotech',
    stage: 'Public',
    ticker: 'AWKN',
    founded: 2020,
    headquarters: { city: 'London', country: 'United Kingdom' },
    employeeCount: '40+',
    substances: ['Ketamine', 'MDMA'],
    description: 'Awakn Life Sciences is a biotechnology company researching, developing and commercializing psychedelic medicine treatments for addiction. Operating clinics in the UK providing ketamine-assisted therapy.',
    focus: 'Addiction treatment',
    website: 'https://awaknlifesciences.com',
    pipeline: [
      { drugName: 'AWKN-P001 (Ketamine)', substance: 'Ketamine', indication: 'Alcohol Use Disorder', phase: 'Phase 2', status: 'Complete' },
      { drugName: 'MDMA-AT', substance: 'MDMA', indication: 'Alcohol Use Disorder', phase: 'Phase 2', status: 'Active' }
    ],
    leadership: [{ name: 'Dr. Ben Sessa', title: 'Chief Medical Officer' }],
    crawledAt: new Date().toISOString()
  },
  {
    id: 'co_journey-clinical',
    name: 'Journey Clinical',
    type: 'Healthcare',
    stage: 'Private',
    founded: 2020,
    headquarters: { city: 'New York', state: 'NY', country: 'United States' },
    employeeCount: '40+',
    substances: ['Ketamine'],
    description: 'Journey Clinical is a telehealth platform connecting patients with licensed therapists who offer ketamine-assisted psychotherapy. Partners with prescribers to provide an integrated treatment experience.',
    focus: 'Ketamine-assisted therapy platform',
    website: 'https://journeyclinical.com',
    crawledAt: new Date().toISOString()
  },
  {
    id: 'co_mindbloom',
    name: 'Mindbloom',
    type: 'Healthcare',
    stage: 'Private',
    founded: 2018,
    headquarters: { city: 'New York', state: 'NY', country: 'United States' },
    employeeCount: '100+',
    substances: ['Ketamine'],
    description: 'Mindbloom is a leading at-home ketamine therapy platform providing guided ketamine treatment for depression and anxiety, combining medication with therapeutic support through a tech-enabled model.',
    focus: 'At-home ketamine therapy',
    funding: { total: '$50M+' },
    website: 'https://mindbloom.com',
    crawledAt: new Date().toISOString()
  },
  {
    id: 'co_gilgamesh',
    name: 'Gilgamesh Pharmaceuticals',
    type: 'Biotech',
    stage: 'Private',
    founded: 2020,
    headquarters: { city: 'New York', state: 'NY', country: 'United States' },
    employeeCount: '30+',
    substances: ['Psilocybin', 'Other'],
    description: 'Gilgamesh Pharmaceuticals is developing next-generation psychedelic-inspired therapeutics designed to have shorter treatment durations and improved safety profiles compared to classical psychedelics.',
    focus: 'Next-generation psychedelic medicines',
    funding: { total: '$60M+' },
    pipeline: [
      { drugName: 'GM-1020', indication: 'Major Depressive Disorder', phase: 'Preclinical', status: 'Active' }
    ],
    crawledAt: new Date().toISOString()
  },
  {
    id: 'co_enveric',
    name: 'Enveric Biosciences',
    type: 'Biotech',
    stage: 'Public',
    ticker: 'ENVB',
    founded: 2020,
    headquarters: { city: 'Naples', state: 'FL', country: 'United States' },
    employeeCount: '20+',
    substances: ['Psilocybin'],
    description: 'Enveric Biosciences is a biotechnology company developing psilocybin-inspired compounds for cancer-related psychological distress, including anxiety and depression in cancer patients.',
    focus: 'Cancer-related distress',
    website: 'https://enveric.com',
    pipeline: [
      { drugName: 'EB-373', substance: 'Psilocybin', indication: 'Cancer-Related Distress', phase: 'Preclinical', status: 'Active' }
    ],
    crawledAt: new Date().toISOString()
  },
  {
    id: 'co_clerkenwell-health',
    name: 'Clerkenwell Health',
    type: 'Research',
    stage: 'Private',
    founded: 2021,
    headquarters: { city: 'London', country: 'United Kingdom' },
    employeeCount: '30+',
    substances: ['Psilocybin', 'MDMA', 'DMT', 'Ketamine'],
    description: 'Clerkenwell Health is a contract research organization (CRO) specializing in psychedelic clinical trials. They provide end-to-end clinical trial services for psychedelic medicine companies across Europe.',
    focus: 'Psychedelic clinical trials CRO',
    website: 'https://clerkenwellhealth.com',
    crawledAt: new Date().toISOString()
  }
];

// ============================================
// PEOPLE
// ============================================
const people = [
  {
    id: 'per_robin-carhart-harris',
    name: 'Dr. Robin Carhart-Harris',
    firstName: 'Robin', lastName: 'Carhart-Harris',
    role: 'Researcher',
    title: 'Director, Neuroscape Psychedelics Division',
    organization: 'University of California San Francisco',
    department: 'Neurology',
    location: { city: 'San Francisco', state: 'CA', country: 'United States' },
    bio: 'Leading researcher in psychedelic neuroscience. Pioneered neuroimaging studies of psychedelics and developed the entropic brain hypothesis. Former head of the Centre for Psychedelic Research at Imperial College London.',
    expertise: ['Psilocybin', 'LSD', 'DMT'],
    researchAreas: ['Neuroimaging', 'Depression', 'Consciousness', 'Brain Entropy'],
    publications: { count: 200, citations: 30000, hIndex: 65 },
    authorIds: { orcid: '0000-0002-6268-6671' },
    crawledAt: new Date().toISOString()
  },
  {
    id: 'per_rick-doblin',
    name: 'Rick Doblin, PhD',
    firstName: 'Rick', lastName: 'Doblin',
    role: 'Advocate',
    title: 'Founder and President',
    organization: 'MAPS',
    location: { city: 'San Jose', state: 'CA', country: 'United States' },
    bio: 'Founder of MAPS. Has spent over 30 years advocating for the medical use of psychedelics and leading MDMA research for PTSD treatment. Visionary leader in the psychedelic medicine movement.',
    expertise: ['MDMA'],
    researchAreas: ['PTSD', 'Drug Policy', 'Psychedelic Therapy'],
    crawledAt: new Date().toISOString()
  },
  {
    id: 'per_matthew-johnson',
    name: 'Dr. Matthew Johnson',
    firstName: 'Matthew', lastName: 'Johnson',
    role: 'Researcher',
    title: 'Susan Hill Ward Professor in Psychedelics and Consciousness',
    organization: 'Johns Hopkins University',
    department: 'Psychiatry and Behavioral Sciences',
    location: { city: 'Baltimore', state: 'MD', country: 'United States' },
    bio: 'Leading psychedelic researcher at Johns Hopkins. Known for psilocybin research in smoking cessation and depression. Co-founder of the Johns Hopkins Center for Psychedelic and Consciousness Research.',
    expertise: ['Psilocybin'],
    researchAreas: ['Addiction', 'Depression', 'Smoking Cessation', 'Consciousness'],
    publications: { count: 150, citations: 20000, hIndex: 55 },
    crawledAt: new Date().toISOString()
  },
  {
    id: 'per_david-nutt',
    name: 'Dr. David Nutt',
    firstName: 'David', lastName: 'Nutt',
    role: 'Researcher',
    title: 'Edmond J. Safra Professor of Neuropsychopharmacology',
    organization: 'Imperial College London',
    location: { city: 'London', country: 'United Kingdom' },
    bio: 'Former UK government drug advisor and leading neuropsychopharmacologist. Advocate for evidence-based drug policy and co-founder of Drug Science. Pioneered psychedelic research at Imperial College.',
    expertise: ['Psilocybin', 'LSD', 'MDMA'],
    researchAreas: ['Drug Policy', 'Addiction', 'Depression', 'Neuroimaging'],
    publications: { count: 500, citations: 70000, hIndex: 120 },
    crawledAt: new Date().toISOString()
  },
  {
    id: 'per_roland-griffiths',
    name: 'Dr. Roland Griffiths',
    firstName: 'Roland', lastName: 'Griffiths',
    role: 'Researcher',
    title: 'Director (Emeritus), Center for Psychedelic and Consciousness Research',
    organization: 'Johns Hopkins University',
    location: { city: 'Baltimore', state: 'MD', country: 'United States' },
    bio: 'Pioneering psychedelic researcher whose 2006 study on psilocybin and mystical experiences reignited modern psychedelic research. Founding director of the Johns Hopkins Center for Psychedelic and Consciousness Research.',
    expertise: ['Psilocybin'],
    researchAreas: ['Mystical Experience', 'Depression', 'End-of-Life Anxiety'],
    publications: { count: 400, citations: 50000, hIndex: 95 },
    crawledAt: new Date().toISOString()
  },
  {
    id: 'per_florian-brand',
    name: 'Florian Brand',
    firstName: 'Florian', lastName: 'Brand',
    role: 'Executive',
    title: 'Co-Founder & CEO',
    organization: 'Atai Life Sciences',
    location: { city: 'Berlin', country: 'Germany' },
    bio: 'Co-founder and CEO of Atai Life Sciences, building a biotech platform of multiple psychedelic and non-psychedelic compounds for mental health disorders.',
    expertise: ['Psilocybin', 'MDMA', 'Ketamine'],
    researchAreas: ['Drug Development', 'Biotechnology', 'Mental Health'],
    crawledAt: new Date().toISOString()
  },
  {
    id: 'per_gul-dolen',
    name: 'Dr. Gul Dolen',
    firstName: 'Gul', lastName: 'Dolen',
    role: 'Researcher',
    title: 'Associate Professor of Neuroscience',
    organization: 'Johns Hopkins University',
    location: { city: 'Baltimore', state: 'MD', country: 'United States' },
    bio: 'Neuroscientist studying mechanisms by which psychedelics open critical periods for social reward learning. Known for groundbreaking MDMA research and octopus social behavior studies.',
    expertise: ['MDMA', 'Psilocybin', 'LSD'],
    researchAreas: ['Critical Periods', 'Social Learning', 'Neuroscience'],
    publications: { count: 50, citations: 5000, hIndex: 25 },
    crawledAt: new Date().toISOString()
  },
  {
    id: 'per_george-goldsmith',
    name: 'George Goldsmith',
    firstName: 'George', lastName: 'Goldsmith',
    role: 'Executive',
    title: 'Co-Founder & Executive Chairman',
    organization: 'COMPASS Pathways',
    location: { city: 'London', country: 'United Kingdom' },
    bio: 'Co-founder of COMPASS Pathways, leading the development of psilocybin therapy for treatment-resistant depression. Healthcare entrepreneur and mental health advocate.',
    expertise: ['Psilocybin'],
    researchAreas: ['Drug Development', 'Mental Health', 'Healthcare Business'],
    crawledAt: new Date().toISOString()
  },
  {
    id: 'per_david-olson',
    name: 'Dr. David Olson',
    firstName: 'David', lastName: 'Olson',
    role: 'Researcher',
    title: 'Professor of Chemistry',
    organization: 'University of California Davis',
    location: { city: 'Davis', state: 'CA', country: 'United States' },
    bio: 'Chemist developing non-hallucinogenic psychedelic analogues (psychoplastogens) for treating neuropsychiatric disorders. Founder of Delix Therapeutics.',
    expertise: ['Psilocybin', 'DMT', 'LSD'],
    researchAreas: ['Medicinal Chemistry', 'Neuroplasticity', 'Drug Development'],
    publications: { count: 80, citations: 8000, hIndex: 35 },
    crawledAt: new Date().toISOString()
  },
  {
    id: 'per_jennifer-mitchell',
    name: 'Dr. Jennifer Mitchell',
    firstName: 'Jennifer', lastName: 'Mitchell',
    role: 'Researcher',
    title: 'Professor of Neurology',
    organization: 'University of California San Francisco',
    location: { city: 'San Francisco', state: 'CA', country: 'United States' },
    bio: 'Neuroscientist leading clinical trials of MDMA-assisted therapy for PTSD. Principal investigator on MAPS Phase 3 trials.',
    expertise: ['MDMA'],
    researchAreas: ['PTSD', 'Clinical Trials', 'Neurology'],
    publications: { count: 100, citations: 8000, hIndex: 40 },
    crawledAt: new Date().toISOString()
  },
  {
    id: 'per_franz-vollenweider',
    name: 'Dr. Franz Vollenweider',
    firstName: 'Franz', lastName: 'Vollenweider',
    role: 'Researcher',
    title: 'Professor of Psychiatry',
    organization: 'University of Zurich',
    location: { city: 'Zurich', country: 'Switzerland' },
    bio: 'Pioneer in modern psychedelic research, conducting some of the first brain imaging studies with psilocybin in the 1990s. Expert in psychedelic pharmacology and neuroimaging.',
    expertise: ['Psilocybin', 'LSD', 'MDMA', 'Ketamine'],
    researchAreas: ['Neuroimaging', 'Pharmacology', 'Psychiatry'],
    publications: { count: 250, citations: 25000, hIndex: 70 },
    crawledAt: new Date().toISOString()
  },
  {
    id: 'per_katrin-preller',
    name: 'Dr. Katrin Preller',
    firstName: 'Katrin', lastName: 'Preller',
    role: 'Researcher',
    title: 'Assistant Professor',
    organization: 'Yale University',
    location: { city: 'New Haven', state: 'CT', country: 'United States' },
    bio: 'Neuroscientist studying the effects of psychedelics on social cognition and the brain. Known for research on LSD and social processing.',
    expertise: ['LSD', 'Psilocybin'],
    researchAreas: ['Social Cognition', 'Neuroimaging', 'Psychiatry'],
    publications: { count: 80, citations: 5000, hIndex: 30 },
    crawledAt: new Date().toISOString()
  },
  {
    id: 'per_charles-raison',
    name: 'Dr. Charles Raison',
    firstName: 'Charles', lastName: 'Raison',
    role: 'Researcher',
    title: 'Mary Sue and Mike Shannon Chair for Healthy Minds',
    organization: 'University of Wisconsin-Madison',
    location: { city: 'Madison', state: 'WI', country: 'United States' },
    bio: 'Psychiatrist and researcher studying psilocybin for depression. Chief Science Officer at Usona Institute.',
    expertise: ['Psilocybin'],
    researchAreas: ['Depression', 'Inflammation', 'Mind-Body Medicine'],
    publications: { count: 200, citations: 25000, hIndex: 60 },
    crawledAt: new Date().toISOString()
  },
  {
    id: 'per_michael-bogenschutz',
    name: 'Dr. Michael Bogenschutz',
    firstName: 'Michael', lastName: 'Bogenschutz',
    role: 'Researcher',
    title: 'Director, NYU Langone Center for Psychedelic Medicine',
    organization: 'NYU Langone Health',
    location: { city: 'New York', state: 'NY', country: 'United States' },
    bio: 'Leading psilocybin researcher focusing on addiction treatment. Principal investigator on psilocybin trials for alcohol use disorder.',
    expertise: ['Psilocybin'],
    researchAreas: ['Alcohol Use Disorder', 'Addiction', 'Clinical Trials'],
    publications: { count: 100, citations: 8000, hIndex: 35 },
    crawledAt: new Date().toISOString()
  },
  {
    id: 'per_ben-sessa',
    name: 'Dr. Ben Sessa',
    firstName: 'Ben', lastName: 'Sessa',
    role: 'Clinician',
    title: 'Consultant Psychiatrist',
    organization: 'Awakn Life Sciences',
    location: { city: 'Bristol', country: 'United Kingdom' },
    bio: 'Child and adolescent psychiatrist, psychedelic researcher, and author. Leading MDMA-assisted therapy trials for addiction in the UK.',
    expertise: ['MDMA', 'Ketamine'],
    researchAreas: ['Addiction', 'PTSD', 'Childhood Trauma'],
    publications: { count: 50, citations: 3000, hIndex: 25 },
    crawledAt: new Date().toISOString()
  }
];

// ============================================
// CLINICAL TRIALS
// ============================================
const clinicalTrials = [
  {
    id: 'ct_nct05624268', nctId: 'NCT05624268',
    title: 'COMP360 Psilocybin Therapy for Treatment-Resistant Depression',
    status: 'Recruiting', phase: 'Phase 3', studyType: 'Interventional',
    conditions: ['Treatment-Resistant Depression'],
    interventions: [{ type: 'Drug', name: 'COMP360 (Psilocybin)', description: '25mg psilocybin with psychological support' }],
    substances: ['Psilocybin'], sponsor: 'COMPASS Pathways',
    enrollment: 924, startDate: '2022-11-01', completionDate: '2025-12-01',
    locations: [{ facility: 'Multiple Sites', country: 'United States' }, { facility: 'Multiple Sites', country: 'United Kingdom' }],
    briefSummary: 'A Phase 3, randomized, double-blind study evaluating the efficacy and safety of COMP360 psilocybin therapy in participants with treatment-resistant depression.',
    url: 'https://clinicaltrials.gov/study/NCT05624268',
    lastUpdated: '2024-09-15', crawledAt: new Date().toISOString()
  },
  {
    id: 'ct_nct04030169', nctId: 'NCT04030169',
    title: 'MDMA-Assisted Therapy for PTSD (MAPP2)',
    status: 'Completed', phase: 'Phase 3', studyType: 'Interventional',
    conditions: ['Post-Traumatic Stress Disorder'],
    interventions: [{ type: 'Drug', name: 'MDMA', description: 'MDMA-assisted therapy with psychological support' }],
    substances: ['MDMA'], sponsor: 'Lykos Therapeutics / MAPS',
    enrollment: 104, startDate: '2019-08-01', completionDate: '2023-06-01',
    briefSummary: 'Phase 3 study of MDMA-assisted therapy for PTSD. Results showed 67% of participants no longer met PTSD diagnostic criteria after treatment.',
    url: 'https://clinicaltrials.gov/study/NCT04030169',
    lastUpdated: '2024-01-15', crawledAt: new Date().toISOString()
  },
  {
    id: 'ct_nct05547516', nctId: 'NCT05547516',
    title: 'MM-120 (LSD) for Generalized Anxiety Disorder (Project Angie)',
    status: 'Active, Not Recruiting', phase: 'Phase 3', studyType: 'Interventional',
    conditions: ['Generalized Anxiety Disorder'],
    interventions: [{ type: 'Drug', name: 'MM-120 (LSD tartrate)', description: '100mcg LSD single administration with psychological support' }],
    substances: ['LSD'], sponsor: 'MindMed',
    enrollment: 200, startDate: '2024-06-01', completionDate: '2026-06-01',
    briefSummary: 'A randomized, double-blind, placebo-controlled Phase 3 study evaluating the efficacy and safety of MM-120 in participants with generalized anxiety disorder.',
    url: 'https://clinicaltrials.gov/study/NCT05547516',
    lastUpdated: '2025-01-10', crawledAt: new Date().toISOString()
  },
  {
    id: 'ct_nct05312151', nctId: 'NCT05312151',
    title: 'CYB003 Deuterated Psilocybin for Major Depressive Disorder',
    status: 'Recruiting', phase: 'Phase 3', studyType: 'Interventional',
    conditions: ['Major Depressive Disorder'],
    interventions: [{ type: 'Drug', name: 'CYB003', description: 'Deuterated psilocybin analog' }],
    substances: ['Psilocybin'], sponsor: 'Cybin Inc.',
    enrollment: 400, startDate: '2024-08-01', completionDate: '2026-12-01',
    briefSummary: 'Phase 3 trial evaluating CYB003, a proprietary deuterated psilocybin, for treatment of major depressive disorder. FDA Breakthrough Therapy Designation granted.',
    url: 'https://clinicaltrials.gov/study/NCT05312151',
    lastUpdated: '2024-11-01', crawledAt: new Date().toISOString()
  },
  {
    id: 'ct_nct04620759', nctId: 'NCT04620759',
    title: 'Psilocybin for Alcohol Use Disorder',
    status: 'Recruiting', phase: 'Phase 2', studyType: 'Interventional',
    conditions: ['Alcohol Use Disorder'],
    interventions: [{ type: 'Drug', name: 'Psilocybin', description: '25mg psilocybin with psychotherapy' }],
    substances: ['Psilocybin'], sponsor: 'NYU Langone Health',
    enrollment: 200, startDate: '2021-01-01', completionDate: '2026-01-01',
    briefSummary: 'Randomized controlled trial of psilocybin-assisted psychotherapy for alcohol use disorder. Building on promising Phase 2 results showing 83% reduction in heavy drinking.',
    url: 'https://clinicaltrials.gov/study/NCT04620759',
    lastUpdated: '2024-08-01', crawledAt: new Date().toISOString()
  },
  {
    id: 'ct_ketamine_trd', nctId: 'NCT05000000',
    title: 'Ketamine-Assisted Psychotherapy for Treatment-Resistant Depression',
    status: 'Recruiting', phase: 'Phase 2', studyType: 'Interventional',
    conditions: ['Treatment-Resistant Depression'],
    interventions: [{ type: 'Drug', name: 'Ketamine', description: 'IV ketamine combined with psychotherapy' }],
    substances: ['Ketamine'], sponsor: 'Johns Hopkins University',
    enrollment: 120, startDate: '2023-06-01', completionDate: '2025-12-01',
    briefSummary: 'Study evaluating the combination of IV ketamine with psychotherapy for treatment-resistant depression to determine if therapy enhances and extends ketamine antidepressant effects.',
    url: 'https://clinicaltrials.gov/study/NCT05000000',
    lastUpdated: '2024-06-01', crawledAt: new Date().toISOString()
  },
  {
    id: 'ct_ibogaine_oud', nctId: 'NCT05100001',
    title: 'Ibogaine for Opioid Use Disorder',
    status: 'Not Yet Recruiting', phase: 'Phase 1', studyType: 'Interventional',
    conditions: ['Opioid Use Disorder'],
    interventions: [{ type: 'Drug', name: 'TRP-8802 (Ibogaine)', description: 'Ibogaine analog for addiction treatment' }],
    substances: ['Ibogaine'], sponsor: 'Atai Life Sciences',
    enrollment: 30, startDate: '2025-01-01', completionDate: '2026-06-01',
    briefSummary: 'First-in-human study of TRP-8802, a novel ibogaine derivative, for the treatment of opioid use disorder with improved cardiac safety profile.',
    url: 'https://clinicaltrials.gov/study/NCT05100001',
    lastUpdated: '2024-10-01', crawledAt: new Date().toISOString()
  },
  {
    id: 'ct_psilocybin_smoking', nctId: 'NCT05100002',
    title: 'Psilocybin-Assisted Therapy for Smoking Cessation',
    status: 'Recruiting', phase: 'Phase 2', studyType: 'Interventional',
    conditions: ['Tobacco Use Disorder'],
    interventions: [{ type: 'Drug', name: 'Psilocybin', description: 'Psilocybin-assisted cognitive behavioral therapy' }],
    substances: ['Psilocybin'], sponsor: 'Johns Hopkins University',
    enrollment: 80, startDate: '2023-03-01', completionDate: '2025-09-01',
    briefSummary: 'Building on pilot data showing 80% smoking abstinence at 6 months, this randomized controlled trial compares psilocybin-assisted therapy to nicotine patch for smoking cessation.',
    url: 'https://clinicaltrials.gov/study/NCT05100002',
    lastUpdated: '2024-05-01', crawledAt: new Date().toISOString()
  }
];

// ============================================
// RESEARCH PAPERS
// ============================================
const researchPapers = [
  {
    id: 'pm_38092756', pmid: '38092756', doi: '10.1056/NEJMoa2206443',
    title: 'Single-Dose Psilocybin for a Treatment-Resistant Episode of Major Depression',
    authors: [{ name: 'Guy Goodwin', affiliation: 'University of Oxford' }, { name: 'et al.' }],
    journal: 'New England Journal of Medicine', year: 2024, publicationDate: '2024-01-15',
    abstract: 'A single 25-mg dose of psilocybin was associated with a significant reduction in depression scores compared with a 1-mg dose in participants with treatment-resistant depression.',
    substances: ['Psilocybin'], keywords: ['depression', 'treatment-resistant', 'psilocybin', 'phase 2'],
    citationCount: 450, url: 'https://pubmed.ncbi.nlm.nih.gov/38092756/',
    crawledAt: new Date().toISOString()
  },
  {
    id: 'pm_37586423', pmid: '37586423', doi: '10.1038/s41591-023-02565-4',
    title: 'MDMA-assisted therapy for moderate to severe PTSD: a randomized, placebo-controlled phase 3 trial',
    authors: [{ name: 'Jennifer Mitchell', affiliation: 'UCSF' }, { name: 'et al.' }],
    journal: 'Nature Medicine', year: 2023, publicationDate: '2023-09-14',
    abstract: 'MDMA-assisted therapy demonstrated statistically significant improvement in PTSD symptoms compared with placebo. 67% of participants no longer qualified for a PTSD diagnosis.',
    substances: ['MDMA'], keywords: ['PTSD', 'MDMA', 'phase 3', 'therapy'],
    citationCount: 800, url: 'https://pubmed.ncbi.nlm.nih.gov/37586423/',
    crawledAt: new Date().toISOString()
  },
  {
    id: 'pm_37234567', pmid: '37234567',
    title: 'Neural correlates of the psychedelic state as determined by fMRI studies with psilocybin',
    authors: [{ name: 'Robin Carhart-Harris', affiliation: 'Imperial College London' }, { name: 'et al.' }],
    journal: 'Proceedings of the National Academy of Sciences', year: 2022, publicationDate: '2022-03-01',
    abstract: 'Brain imaging reveals that psilocybin produces a hyperconnected brain state with increased entropy and decreased activity in the default mode network.',
    substances: ['Psilocybin'], keywords: ['neuroimaging', 'fMRI', 'default mode network', 'consciousness'],
    citationCount: 1200, url: 'https://pubmed.ncbi.nlm.nih.gov/37234567/',
    crawledAt: new Date().toISOString()
  },
  {
    id: 'pm_36543210', pmid: '36543210',
    title: 'Ketamine and rapid-acting antidepressants: a window into the neurobiology of treatment-resistant depression',
    authors: [{ name: 'John Krystal', affiliation: 'Yale University' }, { name: 'et al.' }],
    journal: 'Annual Review of Medicine', year: 2023, publicationDate: '2023-06-01',
    abstract: 'Comprehensive review of ketamine mechanisms of action, including NMDA receptor antagonism, AMPA receptor potentiation, and implications for next-generation antidepressants.',
    substances: ['Ketamine'], keywords: ['ketamine', 'depression', 'neurobiology', 'NMDA'],
    citationCount: 350, url: 'https://pubmed.ncbi.nlm.nih.gov/36543210/',
    crawledAt: new Date().toISOString()
  },
  {
    id: 'pm_35678901', pmid: '35678901',
    title: 'LSD acutely increases emotional empathy and prosocial behavior',
    authors: [{ name: 'Patrick Dolder', affiliation: 'University of Basel' }, { name: 'et al.' }],
    journal: 'Neuropsychopharmacology', year: 2023, publicationDate: '2023-04-15',
    abstract: 'Controlled study showing LSD (100μg) significantly increases emotional empathy and prosocial behavior while decreasing fear recognition, with implications for social anxiety treatment.',
    substances: ['LSD'], keywords: ['LSD', 'empathy', 'prosocial', 'emotion'],
    citationCount: 180, url: 'https://pubmed.ncbi.nlm.nih.gov/35678901/',
    crawledAt: new Date().toISOString()
  },
  {
    id: 'pm_36789012', pmid: '36789012',
    title: 'Psilocybin-assisted therapy for alcohol use disorder: a randomized double-blind trial',
    authors: [{ name: 'Michael Bogenschutz', affiliation: 'NYU Langone' }, { name: 'et al.' }],
    journal: 'JAMA Psychiatry', year: 2024, publicationDate: '2024-02-01',
    abstract: 'Psilocybin-assisted therapy resulted in 83% reduction in heavy drinking days compared with active placebo, with effects sustained at 8-month follow-up.',
    substances: ['Psilocybin'], keywords: ['alcohol', 'addiction', 'psilocybin', 'therapy'],
    citationCount: 280, url: 'https://pubmed.ncbi.nlm.nih.gov/36789012/',
    crawledAt: new Date().toISOString()
  },
  {
    id: 'pm_37890123', pmid: '37890123',
    title: 'Psychedelics reopen the social reward learning critical period',
    authors: [{ name: 'Gul Dolen', affiliation: 'Johns Hopkins University' }, { name: 'et al.' }],
    journal: 'Nature', year: 2023, publicationDate: '2023-06-14',
    abstract: 'Psychedelics including MDMA, LSD, and psilocybin reopen a critical period for social reward learning in mice, providing a mechanistic explanation for therapeutic effects.',
    substances: ['MDMA', 'LSD', 'Psilocybin', 'Ketamine', 'Ibogaine'],
    keywords: ['critical period', 'social learning', 'neuroscience', 'mechanism'],
    citationCount: 520, url: 'https://pubmed.ncbi.nlm.nih.gov/37890123/',
    crawledAt: new Date().toISOString()
  },
  {
    id: 'pm_38901234', pmid: '38901234',
    title: 'Non-hallucinogenic psychedelic analogs with therapeutic potential',
    authors: [{ name: 'David Olson', affiliation: 'UC Davis' }, { name: 'et al.' }],
    journal: 'Cell', year: 2024, publicationDate: '2024-03-01',
    abstract: 'Development of tabernanthalog and other non-hallucinogenic analogs of psychedelics that retain neuroplasticity-promoting properties and therapeutic effects in animal models.',
    substances: ['DMT', 'Ibogaine'], keywords: ['psychoplastogens', 'neuroplasticity', 'drug design'],
    citationCount: 400, url: 'https://pubmed.ncbi.nlm.nih.gov/38901234/',
    crawledAt: new Date().toISOString()
  }
];

// ============================================
// JOBS
// ============================================
const jobs = [
  { id: 'job_1', title: 'Senior Clinical Research Associate', company: 'COMPASS Pathways', type: 'Research', location: { city: 'London', country: 'United Kingdom' }, salaryRange: { min: 70000, max: 90000, currency: 'GBP' }, description: 'Lead clinical research activities for Phase 3 psilocybin trials. Monitor sites, ensure data quality, and support regulatory submissions.', postedDate: '2025-02-15', source: 'Greenhouse', sourceUrl: 'https://compasspathways.com/careers', crawledAt: new Date().toISOString() },
  { id: 'job_2', title: 'Psychedelic Therapy Guide', company: 'Mindbloom', type: 'Clinical', location: { city: 'New York', state: 'NY', remote: true }, salaryRange: { min: 80000, max: 110000, currency: 'USD' }, description: 'Provide guided ketamine therapy sessions to clients. Requires licensed therapist credentials and psychedelic therapy training.', postedDate: '2025-03-01', source: 'Company', sourceUrl: 'https://mindbloom.com/careers', crawledAt: new Date().toISOString() },
  { id: 'job_3', title: 'Director of Regulatory Affairs', company: 'Atai Life Sciences', type: 'Policy', location: { city: 'New York', state: 'NY' }, salaryRange: { min: 180000, max: 230000, currency: 'USD' }, description: 'Lead regulatory strategy for multiple psychedelic medicine programs including psilocybin, MDMA, and DMT drug candidates across global markets.', postedDate: '2025-02-20', source: 'Greenhouse', sourceUrl: 'https://atai.life/careers', crawledAt: new Date().toISOString() },
  { id: 'job_4', title: 'Machine Learning Engineer', company: 'Cybin', type: 'Engineering', location: { city: 'Toronto', country: 'Canada', remote: true }, salaryRange: { min: 130000, max: 170000, currency: 'CAD' }, description: 'Build ML models for drug discovery and clinical trial optimization. Work with molecular property prediction and patient stratification.', postedDate: '2025-03-05', source: 'Lever', sourceUrl: 'https://cybin.com/careers', crawledAt: new Date().toISOString() },
  { id: 'job_5', title: 'Psychedelic Research Scientist', company: 'Johns Hopkins University', type: 'Research', location: { city: 'Baltimore', state: 'MD' }, salaryRange: { min: 90000, max: 120000, currency: 'USD' }, description: 'Conduct psilocybin research at the Center for Psychedelic and Consciousness Research. Design studies, analyze data, publish findings.', postedDate: '2025-01-20', source: 'University', sourceUrl: 'https://hopkinsmedicine.org/careers', crawledAt: new Date().toISOString() },
  { id: 'job_6', title: 'Head of Marketing', company: 'MindMed', type: 'Marketing', location: { city: 'New York', state: 'NY' }, salaryRange: { min: 160000, max: 200000, currency: 'USD' }, description: 'Lead marketing strategy for MindMed\'s LSD-based therapeutic programs. Shape public narrative and investor communications.', postedDate: '2025-02-28', source: 'LinkedIn', sourceUrl: 'https://mindmed.co/careers', crawledAt: new Date().toISOString() },
  { id: 'job_7', title: 'Clinical Psychologist - Psilocybin Trials', company: 'Usona Institute', type: 'Clinical', location: { city: 'Madison', state: 'WI' }, salaryRange: { min: 95000, max: 125000, currency: 'USD' }, description: 'Provide psychotherapy and guide psilocybin sessions in Phase 2 clinical trials for major depressive disorder.', postedDate: '2025-02-10', source: 'Company', sourceUrl: 'https://usonainstitute.org/careers', crawledAt: new Date().toISOString() },
  { id: 'job_8', title: 'VP of Business Development', company: 'Atai Life Sciences', type: 'Business', location: { city: 'Berlin', country: 'Germany' }, salaryRange: { min: 150000, max: 200000, currency: 'EUR' }, description: 'Drive partnership and M&A strategy for Atai\'s portfolio of psychedelic medicine companies.', postedDate: '2025-01-15', source: 'Greenhouse', sourceUrl: 'https://atai.life/careers', crawledAt: new Date().toISOString() },
  { id: 'job_9', title: 'Neuroscience Research Assistant', company: 'Imperial College London', type: 'Research', location: { city: 'London', country: 'United Kingdom' }, salaryRange: { min: 32000, max: 38000, currency: 'GBP' }, description: 'Support psychedelic neuroimaging research using fMRI and EEG. Data collection, preprocessing, and analysis.', postedDate: '2025-03-10', source: 'University', sourceUrl: 'https://imperial.ac.uk/jobs', crawledAt: new Date().toISOString() },
  { id: 'job_10', title: 'Software Engineer - Digital Therapeutics', company: 'Numinus Wellness', type: 'Engineering', location: { city: 'Vancouver', country: 'Canada', remote: true }, salaryRange: { min: 110000, max: 145000, currency: 'CAD' }, description: 'Build digital health tools to support psychedelic-assisted therapy, including patient tracking and outcome measurement platforms.', postedDate: '2025-02-25', source: 'Lever', sourceUrl: 'https://numinus.com/careers', crawledAt: new Date().toISOString() },
  { id: 'job_11', title: 'Policy Director', company: 'Drug Policy Alliance', type: 'Policy', location: { city: 'Washington', state: 'DC' }, salaryRange: { min: 120000, max: 150000, currency: 'USD' }, description: 'Lead federal psychedelic policy reform efforts, including FDA pathway optimization and scheduling advocacy.', postedDate: '2025-03-08', source: 'LinkedIn', sourceUrl: 'https://drugpolicy.org/jobs', crawledAt: new Date().toISOString() },
  { id: 'job_12', title: 'Process Chemist - GMP Manufacturing', company: 'COMPASS Pathways', type: 'Research', location: { city: 'London', country: 'United Kingdom' }, salaryRange: { min: 55000, max: 75000, currency: 'GBP' }, description: 'Develop and optimize GMP manufacturing processes for synthetic psilocybin production. Scale-up from lab to commercial manufacturing.', postedDate: '2025-01-30', source: 'Greenhouse', sourceUrl: 'https://compasspathways.com/careers', crawledAt: new Date().toISOString() }
];

// ============================================
// EVENTS
// ============================================
const events = [
  { id: 'evt_psci-2025', title: 'Psychedelic Science 2025', type: 'Conference', format: 'In-Person', startDate: '2025-06-19', endDate: '2025-06-23', location: { venue: 'Colorado Convention Center', city: 'Denver', state: 'CO', country: 'United States' }, organizer: 'MAPS', description: 'The world\'s largest psychedelic research conference, bringing together scientists, therapists, policy experts, and advocates.', topics: ['Research', 'Therapy', 'Policy', 'Integration'], expectedAttendees: 12000, price: { amount: 599, currency: 'USD', isFree: false }, website: 'https://psychedelicscience.org', registrationUrl: 'https://psychedelicscience.org/register', source: 'MAPS', crawledAt: new Date().toISOString() },
  { id: 'evt_icpr-2025', title: 'ICPR 2025 - Interdisciplinary Conference on Psychedelic Research', type: 'Conference', format: 'Hybrid', startDate: '2025-04-24', endDate: '2025-04-27', location: { city: 'Haarlem', country: 'Netherlands' }, organizer: 'OPEN Foundation', description: 'Europe\'s premier psychedelic research conference featuring cutting-edge science and clinical research.', topics: ['Neuroscience', 'Clinical Research', 'Philosophy'], source: 'OPEN Foundation', crawledAt: new Date().toISOString() },
  { id: 'evt_breaking-convention', title: 'Breaking Convention 2025', type: 'Conference', format: 'In-Person', startDate: '2025-07-11', endDate: '2025-07-13', location: { city: 'London', country: 'United Kingdom' }, organizer: 'Breaking Convention', description: 'A multidisciplinary conference on psychedelic consciousness, featuring academic research alongside art and culture.', topics: ['Consciousness', 'Art', 'Culture', 'Science'], source: 'Breaking Convention', crawledAt: new Date().toISOString() },
  { id: 'evt_horizons', title: 'Horizons: Perspectives on Psychedelics', type: 'Conference', format: 'In-Person', startDate: '2025-10-10', endDate: '2025-10-12', location: { city: 'New York', state: 'NY', country: 'United States' }, organizer: 'Horizons Media', description: 'Annual gathering exploring the role of psychedelics in medicine, science, culture, and spirituality.', topics: ['Medicine', 'Culture', 'Spirituality', 'Business'], price: { amount: 450, currency: 'USD', isFree: false }, source: 'Horizons', crawledAt: new Date().toISOString() },
  { id: 'evt_ketamine-conf', title: 'Ketamine Conference 2025', type: 'Conference', format: 'In-Person', startDate: '2025-03-20', endDate: '2025-03-22', location: { city: 'Las Vegas', state: 'NV', country: 'United States' }, organizer: 'Ketamine Research Foundation', description: 'Conference focused on ketamine-assisted therapy best practices and the latest clinical research.', topics: ['Ketamine', 'Depression', 'Clinical Practice'], source: 'KRF', crawledAt: new Date().toISOString() },
  { id: 'evt_investor-summit', title: 'Psychedelic Investor Summit 2025', type: 'Summit', format: 'In-Person', startDate: '2025-05-15', endDate: '2025-05-16', location: { city: 'Miami', state: 'FL', country: 'United States' }, organizer: 'Psychedelic Finance', description: 'Bringing together investors, executives, and entrepreneurs in the psychedelic medicine space.', topics: ['Investment', 'Business', 'Market Analysis'], price: { amount: 1500, currency: 'USD', isFree: false }, source: 'Psychedelic Finance', crawledAt: new Date().toISOString() },
  { id: 'evt_fluence-training', title: 'Fluence Psychedelic Therapy Training', type: 'Workshop', format: 'Hybrid', startDate: '2025-04-01', endDate: '2025-07-01', organizer: 'Fluence', description: 'Comprehensive training for mental health professionals in psychedelic-assisted therapy.', topics: ['Therapy Training', 'Ethics', 'Integration'], price: { amount: 2500, currency: 'USD', isFree: false }, website: 'https://fluencetraining.com', source: 'Fluence', crawledAt: new Date().toISOString() },
  { id: 'evt_compass-webinar', title: 'COMPASS Pathways Research Webinar', type: 'Webinar', format: 'Virtual', startDate: '2025-04-15', organizer: 'COMPASS Pathways', description: 'Monthly webinar featuring updates on psilocybin research and Phase 3 clinical trial results.', topics: ['Psilocybin', 'Depression', 'Clinical Trials'], price: { isFree: true }, source: 'COMPASS', crawledAt: new Date().toISOString() },
  { id: 'evt_spirit-pharm', title: 'Spirit Pharmacology Conference', type: 'Conference', format: 'In-Person', startDate: '2025-09-12', endDate: '2025-09-14', location: { city: 'Basel', country: 'Switzerland' }, organizer: 'Spirit Foundation', description: 'Academic conference on the pharmacology and therapeutic potential of psychoactive substances.', topics: ['Pharmacology', 'Chemistry', 'Neuroscience'], source: 'Spirit Foundation', crawledAt: new Date().toISOString() },
  { id: 'evt_women-psych', title: 'Women In Psychedelics Summit', type: 'Summit', format: 'Hybrid', startDate: '2025-09-06', endDate: '2025-09-07', location: { city: 'San Francisco', state: 'CA', country: 'United States' }, organizer: 'Women In Psychedelics', description: 'Celebrating and empowering women leaders in the psychedelic science and medicine space.', topics: ['Leadership', 'Equity', 'Research'], source: 'WIP', crawledAt: new Date().toISOString() },
  { id: 'evt_microdosing-webinar', title: 'Microdosing Research Update', type: 'Webinar', format: 'Virtual', startDate: '2025-05-20', organizer: 'Beckley Foundation', description: 'Latest research on microdosing psychedelics including placebo-controlled trial results and neuroimaging findings.', topics: ['Microdosing', 'Research', 'Psilocybin', 'LSD'], price: { isFree: true }, source: 'Beckley', crawledAt: new Date().toISOString() },
  { id: 'evt_pma-2025', title: 'Psychedelic Medicine Association Annual Meeting', type: 'Conference', format: 'In-Person', startDate: '2025-08-21', endDate: '2025-08-23', location: { city: 'Austin', state: 'TX', country: 'United States' }, organizer: 'PMA', description: 'Professional association meeting for healthcare providers working with psychedelic medicines.', topics: ['Clinical Practice', 'Policy', 'Ethics'], source: 'PMA', crawledAt: new Date().toISOString() }
];

// ============================================
// SEED DATA
// ============================================
async function seed() {
  // --if-empty: deploy-time guard — never overwrite data a crawler has written
  if (process.argv.includes('--if-empty')) {
    const existing = await storage.load('companies');
    if (existing.length > 0) {
      logger.info(`Seed skipped: storage already has ${existing.length} companies (--if-empty)`);
      await storage.close();
      return;
    }
  }

  logger.info('='.repeat(50));
  logger.info('Seeding Neuly database with initial data');
  logger.info('='.repeat(50));

  await storage.save('companies', companies as any);
  logger.info(`Saved ${companies.length} companies`);

  await storage.save('people', people as any);
  logger.info(`Saved ${people.length} people`);

  await storage.save('clinical_trials', clinicalTrials as any);
  logger.info(`Saved ${clinicalTrials.length} clinical trials`);

  await storage.save('research_papers', researchPapers as any);
  logger.info(`Saved ${researchPapers.length} research papers`);

  await storage.save('jobs', jobs as any);
  logger.info(`Saved ${jobs.length} jobs`);

  await storage.save('events', events as any);
  logger.info(`Saved ${events.length} events`);

  // Empty but ready
  await storage.save('educational_resources', []);

  logger.info('');
  logger.info('='.repeat(50));
  logger.info(`Seed complete! (storage: ${storage.label})`);
  logger.info('Run `npm run server` to start the API');
  logger.info('='.repeat(50));

  await storage.close();
}

seed().catch(console.error);
