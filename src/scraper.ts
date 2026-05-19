/**
 * Main scraper for myscheme.gov.in
 * Scrapes all government schemes with structured data
 */

import { chromium, Browser, Page } from 'playwright';
import {
  Scheme,
  SchemeListItem,
  ScrapingState,
  DEFAULT_CONFIG,
  ScraperConfig
} from './types';
import {
  ensureOutputDir,
  loadState,
  saveState,
  saveSchemesJson,
  saveSchemesCsv,
  generateSchemeId,
  delay,
  cleanText,
  logProgress,
  formatDate
} from './utils';

class MyschemeScraper {
  private browser: Browser | null = null;
  private config: ScraperConfig;
  private schemes: Scheme[] = [];
  private state: ScrapingState;
  private isFastMode: boolean = false;

  constructor(config: Partial<ScraperConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = this.loadOrCreateState();
  }

  private loadOrCreateState(): ScrapingState {
    const savedState = loadState();
    if (savedState) {
      console.log(`Resuming from page ${savedState.currentPage}`);
      return savedState;
    }
    return {
      currentPage: 1,
      totalPages: 471,
      scrapedSchemeIds: [],
      lastScrapedAt: new Date().toISOString(),
      errors: [],
    };
  }

  async initialize(): Promise<void> {
    console.log('Launching browser...');
    this.browser = await chromium.launch({ headless: true });
    console.log('Browser launched successfully');
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      console.log('Browser closed');
    }
  }

  async scrape(): Promise<Scheme[]> {
    await this.initialize();
    
    try {
      await this.updateTotalPages();
      
      const totalSchemes = this.state.totalPages * this.config.resultsPerPage;
      console.log(`Total pages: ${this.state.totalPages}`);
      console.log(`Estimated schemes: ${totalSchemes}`);
      
      for (let page = this.state.currentPage; page <= this.state.totalPages; page++) {
        this.state.currentPage = page;
        logProgress(page, this.state.totalPages, 'pages');
        
        try {
          const schemeItems = await this.scrapePage(page);
          console.log(`Found ${schemeItems.length} schemes on page ${page}`);
          
          for (const item of schemeItems) {
            if (this.state.scrapedSchemeIds.includes(item.id)) {
              console.log(`Skipping already scraped: ${item.title}`);
              continue;
            }
            
            try {
              const scheme = await this.scrapeSchemeDetail(item);
              this.schemes.push(scheme);
              this.state.scrapedSchemeIds.push(item.id);
              console.log(`  Scraped: ${scheme.title}`);
              
              if (this.schemes.length % 50 === 0) {
                this.saveProgress();
              }
              
              await delay(this.isFastMode ? this.config.fastDelayMs : this.config.delayMs);
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              console.error(`Error scraping scheme ${item.id}:`, message);
              this.state.errors.push({
                page,
                schemeId: item.id,
                url: item.url,
                error: message,
                timestamp: new Date().toISOString(),
              });
            }
          }
          
          this.saveProgress();
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Error on page ${page}:`, message);
          this.state.errors.push({
            page,
            error: message,
            timestamp: new Date().toISOString(),
          });
        }
      }
      
      this.saveFinalResults();
      
    } finally {
      await this.close();
    }
    
    return this.schemes;
  }

  setFastMode(fast: boolean): void {
    this.isFastMode = fast;
    console.log(`Fast mode: ${fast ? 'ON' : 'OFF'}`);
  }

  private async updateTotalPages(): Promise<void> {
    const page = await this.browser!.newPage();
    try {
      await page.goto(this.config.searchUrl, { waitUntil: 'networkidle' });
      
      const lastPage = await page.evaluate(() => {
        const paginationLinks = Array.from(document.querySelectorAll('ul li'));
        let maxPage = 1;
        for (const li of paginationLinks) {
          const text = li.textContent?.trim() || '';
          const num = parseInt(text, 10);
          if (!isNaN(num) && num > maxPage) {
            maxPage = num;
          }
        }
        return maxPage;
      });
      
      this.state.totalPages = lastPage;
      console.log(`Total pages detected: ${lastPage}`);
    } finally {
      await page.close();
    }
  }

  private async scrapePage(pageNum: number): Promise<SchemeListItem[]> {
    const page = await this.browser!.newPage();
    const items: SchemeListItem[] = [];
    
    try {
      const url = pageNum === 1 ? this.config.searchUrl : `${this.config.searchUrl}?page=${pageNum}`;
      await page.goto(url, { waitUntil: 'networkidle' });
      
      await page.waitForSelector('#scheme-name-0', { timeout: 10000 }).catch(() => {
        console.log('No scheme cards found on page');
      });
      
      const cards = await page.locator('[id^="scheme-name-"]').all();
      
      for (let i = 0; i < cards.length; i++) {
        try {
          const card = cards[i];
          const link = card.locator('a');
          const titleSpan = card.locator('span');
          
          const href = await link.getAttribute('href');
          const title = await titleSpan.textContent();
          
          if (href && title) {
            const id = generateSchemeId(href);
            items.push({
              id,
              title: cleanText(title),
              url: href.startsWith('http') ? href : `${this.config.baseUrl}${href}`,
              ministry: '',
              tags: [],
            });
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Error extracting card ${i}:`, message);
        }
      }
      
    } finally {
      await page.close();
    }
    
    return items;
  }

  private async scrapeSchemeDetail(item: SchemeListItem): Promise<Scheme> {
    const page = await this.browser!.newPage();
    
    try {
      await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000); // Wait for dynamic content
      
      // Extract with individual timeouts to prevent hanging
      const [title, ministry, tags, descriptionArray, benefits, eligibility, exclusions, applicationProcess, documentsRequired, faqs] = await Promise.all([
        this.extractWithTimeout(this.extractTitle(page), 5000),
        this.extractWithTimeout(this.extractMinistry(page), 5000),
        this.extractWithTimeout(this.extractTags(page), 5000),
        this.extractWithTimeout(this.extractSection(page, '#details'), 10000),
        this.extractWithTimeout(this.extractSection(page, '#benefits'), 10000),
        this.extractWithTimeout(this.extractSection(page, '#eligibility'), 10000),
        this.extractWithTimeout(this.extractSection(page, '#exclusions'), 10000),
        this.extractWithTimeout(this.extractApplicationProcess(page), 10000),
        this.extractWithTimeout(this.extractDocumentsRequired(page), 10000),
        this.extractWithTimeout(this.extractFaqs(page), 10000),
      ]);
      
      const description = descriptionArray.join('\n\n');
      
      return {
        id: item.id,
        title: title || item.title,
        ministry,
        tags: tags.length > 0 ? tags : item.tags,
        description,
        benefits,
        eligibility,
        exclusions,
        applicationProcess,
        documentsRequired,
        faqs,
        url: item.url,
        scrapedAt: new Date().toISOString(),
      };
    } finally {
      await page.close();
    }
  }

  private async extractWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => 
        setTimeout(() => reject(new Error('Extraction timeout')), ms)
      )
    ]).catch(() => [] as any);
  }

  private async extractTitle(page: Page): Promise<string> {
    try {
      const titleEl = page.locator('h1');
      const count = await titleEl.count();
      if (count === 0) return '';
      return cleanText(await titleEl.textContent() || '');
    } catch {
      return '';
    }
  }

  private async extractMinistry(page: Page): Promise<string> {
    try {
      const ministryEl = page.locator('h3');
      const count = await ministryEl.count();
      if (count === 0) return '';
      const text = await ministryEl.textContent() || '';
      // Filter out error messages
      if (text.includes('Something went wrong') || text.includes('error')) return '';
      return cleanText(text);
    } catch {
      return '';
    }
  }

  private async extractTags(page: Page): Promise<string[]> {
    try {
      const tagButtons = await page.locator('.mb-2.md\\:mb-0.w-full [role="button"]').all();
      const tags: string[] = [];
      for (const btn of tagButtons) {
        const tag = await btn.textContent();
        if (tag) tags.push(cleanText(tag));
      }
      return tags;
    } catch {
      return [];
    }
  }

  private async extractSection(page: Page, sectionId: string): Promise<string[]> {
    try {
      const section = page.locator(sectionId);
      const sectionCount = await section.count();
      if (sectionCount === 0) return [];
      
      const slateEditor = section.locator('.markdown-options');
      const slateCount = await slateEditor.count();
      if (slateCount === 0) return [];
      
      const items = await slateEditor.locator('[data-slate-node="element"]').all();
      const textItems: string[] = [];
      
      for (const item of items) {
        const text = await this.extractSlateText(item);
        if (text && text.trim()) {
          textItems.push(cleanText(text));
        }
      }
      
      return textItems;
    } catch {
      return [];
    }
  }

  private async extractSlateText(locator: any): Promise<string> {
    try {
      const leaves = await locator.locator('[data-slate-string="true"]').all();
      if (leaves.length > 0) {
        const texts: string[] = [];
        for (const leaf of leaves) {
          const text = await leaf.textContent();
          if (text) texts.push(text);
        }
        return texts.join('');
      }
      return await locator.textContent() || '';
    } catch {
      return '';
    }
  }

  private async extractApplicationProcess(page: Page): Promise<{ mode: string; steps: string[] }> {
    try {
      const section = page.locator('#application-process');
      const sectionCount = await section.count();
      if (sectionCount === 0) return { mode: 'Online', steps: [] };
      
      const modeEl = section.locator('.capitalize');
      const modeCount = await modeEl.count();
      const mode = modeCount > 0 ? cleanText(await modeEl.textContent() || '') : 'Online';
      
      const slateEditor = section.locator('.markdown-options');
      const slateCount = await slateEditor.count();
      const steps: string[] = [];
      
      if (slateCount > 0) {
        const items = await slateEditor.locator('[data-slate-node="element"]').all();
        for (const item of items) {
          const text = await this.extractSlateText(item);
          if (text && text.trim()) {
            steps.push(cleanText(text));
          }
        }
      }
      
      return { mode, steps };
    } catch {
      return { mode: 'Online', steps: [] };
    }
  }

  private async extractDocumentsRequired(page: Page): Promise<string[]> {
    return this.extractSection(page, '#documents-required');
  }

  private async extractFaqs(page: Page): Promise<{ question: string; answer: string }[]> {
    try {
      const section = page.locator('#faqs');
      const sectionCount = await section.count();
      if (sectionCount === 0) return [];
      
      const faqs: { question: string; answer: string }[] = [];
      const faqItems = await section.locator('.py-4').all();
      
      for (const faqItem of faqItems) {
        const questionEl = faqItem.locator('p');
        const answerEl = faqItem.locator('.rounded-b');
        
        const qCount = await questionEl.count();
        if (qCount === 0) continue;
        
        const question = cleanText(await questionEl.textContent() || '');
        let answer = '';
        
        const aCount = await answerEl.count();
        if (aCount > 0) {
          const slateEditor = answerEl.locator('.markdown-options');
          const sCount = await slateEditor.count();
          if (sCount > 0) {
            const leaves = await slateEditor.locator('[data-slate-string="true"]').all();
            const answerParts: string[] = [];
            for (const leaf of leaves) {
              const text = await leaf.textContent();
              if (text) answerParts.push(text);
            }
            answer = cleanText(answerParts.join(''));
          }
        }
        
        if (question) {
          faqs.push({ question, answer });
        }
      }
      
      return faqs;
    } catch {
      return [];
    }
  }

  private saveProgress(): void {
    this.state.lastScrapedAt = new Date().toISOString();
    saveState(this.state);
  }

  private saveFinalResults(): void {
    console.log(`\nScraping complete!`);
    console.log(`Total schemes scraped: ${this.schemes.length}`);
    console.log(`Errors encountered: ${this.state.errors.length}`);
    
    saveSchemesJson(this.schemes);
    saveSchemesCsv(this.schemes);
    this.saveProgress();
    
    if (this.state.errors.length > 0) {
      ensureOutputDir();
      const fs = require('fs');
      fs.writeFileSync(
        `${this.config.outputDir}/errors-${formatDate()}.json`,
        JSON.stringify(this.state.errors, null, 2)
      );
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isFast = args.includes('--fast');
  
  const scraper = new MyschemeScraper();
  scraper.setFastMode(isFast);
  
  console.log('Starting myscheme.gov.in scraper...');
  console.log('===================================');
  
  try {
    const schemes = await scraper.scrape();
    console.log(`\nFinal count: ${schemes.length} schemes`);
  } catch (error) {
    console.error('Fatal error:', error);
  }
}

main();