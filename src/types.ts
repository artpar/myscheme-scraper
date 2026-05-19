/**
 * TypeScript interfaces for myscheme.gov.in scraper
 */

export interface Scheme {
  id: string;
  title: string;
  ministry: string;
  tags: string[];
  description: string;
  benefits: string[];
  eligibility: string[];
  exclusions: string[];
  applicationProcess: {
    mode: string;
    steps: string[];
  };
  documentsRequired: string[];
  faqs: FAQ[];
  url: string;
  scrapedAt: string;
}

export interface FAQ {
  question: string;
  answer: string;
}

export interface SchemeListItem {
  id: string;
  title: string;
  url: string;
  ministry: string;
  tags: string[];
}

export interface ScrapingState {
  currentPage: number;
  totalPages: number;
  scrapedSchemeIds: string[];
  lastScrapedAt: string;
  errors: ScrapingError[];
}

export interface ScrapingError {
  page: number;
  schemeId?: string;
  url?: string;
  error: string;
  timestamp: string;
}

export interface ScraperConfig {
  baseUrl: string;
  searchUrl: string;
  resultsPerPage: number;
  delayMs: number;
  fastDelayMs: number;
  maxRetries: number;
  outputDir: string;
}

export const DEFAULT_CONFIG: ScraperConfig = {
  baseUrl: 'https://www.myscheme.gov.in',
  searchUrl: 'https://www.myscheme.gov.in/search',
  resultsPerPage: 10,
  delayMs: 2000,
  fastDelayMs: 500,
  maxRetries: 3,
  outputDir: 'output',
};