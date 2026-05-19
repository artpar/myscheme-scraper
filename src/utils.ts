/**
 * Utility functions for myscheme.gov.in scraper
 */

import * as fs from 'fs';
import * as path from 'path';
import { Scheme, ScrapingState, DEFAULT_CONFIG } from './types';

/**
 * Ensure output directory exists
 */
export function ensureOutputDir(dirPath: string = DEFAULT_CONFIG.outputDir): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Load scraping state from file
 */
export function loadState(statePath: string = `${DEFAULT_CONFIG.outputDir}/scraping-state.json`): ScrapingState | null {
  try {
    if (fs.existsSync(statePath)) {
      const data = fs.readFileSync(statePath, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading state:', error);
  }
  return null;
}

/**
 * Save scraping state to file
 */
export function saveState(state: ScrapingState, statePath: string = `${DEFAULT_CONFIG.outputDir}/scraping-state.json`): void {
  ensureOutputDir();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Save schemes to JSON file
 */
export function saveSchemesJson(schemes: Scheme[], filePath: string = `${DEFAULT_CONFIG.outputDir}/schemes.json`): void {
  ensureOutputDir();
  fs.writeFileSync(filePath, JSON.stringify(schemes, null, 2));
  console.log(`Saved ${schemes.length} schemes to ${filePath}`);
}

/**
 * Save schemes to CSV file
 */
export function saveSchemesCsv(schemes: Scheme[], filePath: string = `${DEFAULT_CONFIG.outputDir}/schemes.csv`): void {
  ensureOutputDir();
  
  const headers = [
    'id', 'title', 'ministry', 'tags', 'description', 
    'benefits', 'eligibility', 'exclusions', 
    'application_mode', 'application_steps',
    'documents_required', 'faqs', 'url', 'scraped_at'
  ];
  
  const rows = schemes.map(scheme => [
    escapeCsv(scheme.id),
    escapeCsv(scheme.title),
    escapeCsv(scheme.ministry),
    escapeCsv(scheme.tags.join('; ')),
    escapeCsv(scheme.description),
    escapeCsv(scheme.benefits.join('; ')),
    escapeCsv(scheme.eligibility.join('; ')),
    escapeCsv(scheme.exclusions.join('; ')),
    escapeCsv(scheme.applicationProcess.mode),
    escapeCsv(scheme.applicationProcess.steps.join(' | ')),
    escapeCsv(scheme.documentsRequired.join('; ')),
    escapeCsv(scheme.faqs.map(f => `${f.question}: ${f.answer}`).join('; ')),
    escapeCsv(scheme.url),
    escapeCsv(scheme.scrapedAt)
  ]);
  
  const csv = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
  fs.writeFileSync(filePath, csv);
  console.log(`Saved ${schemes.length} schemes to ${filePath}`);
}

/**
 * Escape CSV value
 */
function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Generate scheme ID from URL
 */
export function generateSchemeId(url: string): string {
  const match = url.match(/\/schemes\/([^/]+)/);
  return match ? match[1] : url.split('/').pop() || '';
}

/**
 * Delay execution
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract text from Slate editor content
 */
export function extractSlateText(element: any): string {
  if (!element) return '';
  
  // Handle Slate.js structure
  if (element.dataSlateLeaf) {
    return element.textContent || '';
  }
  
  // Recursively extract from children
  let text = '';
  if (element.childNodes) {
    for (const child of element.childNodes) {
      text += extractSlateText(child);
    }
  } else if (element.textContent) {
    text += element.textContent;
  }
  
  return text.trim();
}

/**
 * Clean and normalize text
 */
export function cleanText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[\n\r\t]+/g, ' ')
    .trim();
}

/**
 * Format date for filename
 */
export function formatDate(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

/**
 * Log progress
 */
export function logProgress(current: number, total: number, message: string = ''): void {
  const percent = ((current / total) * 100).toFixed(1);
  console.log(`[${percent}%] ${current}/${total} ${message}`);
}