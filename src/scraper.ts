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
      
      // Use page.evaluate to run browser code
      const lastPage = await page.evaluate(() => {
        const paginationLinks = document.querySelectorAll('ul li');
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
      await page.goto(item.url, { waitUntil: 'networkidle' });
      
      const [title, ministry, tags, descriptionArray, benefits, eligibility, exclusions, applicationProcess, documentsRequired, faqs] = await Promise.all([
        this.extractTitle(page),
        this.extractMinistry(page),
        this.extractTags(page),
        this.extractSection(page, '#details'),
        this.extractSection(page, '#benefits'),
        this.extractSection(page, '#eligibility'),
        this.extractSection(page, '#exclusions'),
        this.extractApplicationProcess(page),
        this.extractDocumentsRequired(page),
        this.extractFaqs(page),
      ]);
      
      // Join description array into a single string
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

  private async extractTitle(page: Page): Promise<string> {
    try {
      const titleEl = page.locator('h1');
      return titleEl ? cleanText(await titleEl.textContent() || '') : '';
    } catch {
      return '';
    }
  }

  private async extractMinistry(page: Page): Promise<string> {
    try {
      const ministryEl = page.locator('h3');
      return ministryEl ? cleanText(await ministryEl.textContent() || '') : '';
    } catch {
      return '';
    }
  }

  private async extractTags(page: Page): Promise<string[]> {
    try {
      const tagsContainer = page.locator('.mb-2.md\\:mb-0.w-full');
      if (!await tagsContainer.count()) return [];
      
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
      if (!await section.count()) return [];
      
      const slateEditor = section.locator('.markdown-options');
      if (!await slateEditor.count()) return [];
      
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
      if (!await section.count()) return { mode: '', steps: [] };
      
      const modeEl = section.locator('.capitalize');
      const modeCount = await modeEl.count();
      const mode = modeCount > 0 ? cleanText(await modeEl.textContent() || '') : 'Online';
      
      const slateEditor = section.locator('.markdown-options');
      const steps: string[] = [];
      
      if (await slateEditor.count()) {
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
      if (!await section.count()) return [];
      
      const faqs: { question: string; answer: string }[] = [];
      const faqItems = await section.locator('.py-4').all();
      
      for (const faqItem of faqItems) {
        const questionEl = faqItem.locator('p');
        const answerEl = faqItem.locator('.rounded-b');
        
        if (await questionEl.count()) {
          const question = cleanText(await questionEl.textContent() || '');
          let answer = '';
          
          if (await answerEl.count()) {
            const slateEditor = answerEl.locator('.markdown-options');
            if (await slateEditor.count()) {
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