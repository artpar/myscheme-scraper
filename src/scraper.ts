/**
 * Main scraper for myscheme.gov.in
 * Scrapes all government schemes with structured data
 */

import { chromium, Browser, Page } from 'playwright';
import {
  Scheme,
  SchemeListItem,
  ScrapingState,
  FAQ,
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
      totalPages: 471, // Will be updated after first page load
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
      // Get total pages from first load
      await this.updateTotalPages();
      
      const totalSchemes = this.state.totalPages * this.config.resultsPerPage;
      console.log(`Total pages: ${this.state.totalPages}`);
      console.log(`Estimated schemes: ${totalSchemes}`);
      
      // Scrape each page
      for (let page = this.state.currentPage; page <= this.state.totalPages; page++) {
        this.state.currentPage = page;
        logProgress(page, this.state.totalPages, 'pages');
        
        try {
          const schemeItems = await this.scrapePage(page);
          console.log(`Found ${schemeItems.length} schemes on page ${page}`);
          
          // Scrape each scheme detail
          for (const item of schemeItems) {
            if (this.state.scrapedSchemeIds.includes(item.id)) {
              console.log(`Skipping already scraped: ${item.title}`);
              continue;
            }
            
            try {
              const scheme = await this.scrapeSchemeDetail(item);
              this.schemes.push(scheme);
              this.state.scrapedSchemeIds.push(item.id);
              
              // Save progress periodically
              if (this.schemes.length % 50 === 0) {
                this.saveProgress();
              }
              
              // Rate limiting
              await delay(this.isFastMode ? this.config.fastDelayMs : this.config.delayMs);
            } catch (error: any) {
              console.error(`Error scraping scheme ${item.id}:`, error.message);
              this.state.errors.push({
                page,
                schemeId: item.id,
                url: item.url,
                error: error.message,
                timestamp: new Date().toISOString(),
              });
            }
          }
          
          this.saveProgress();
        } catch (error: any) {
          console.error(`Error on page ${page}:`, error.message);
          this.state.errors.push({
            page,
            error: error.message,
            timestamp: new Date().toISOString(),
          });
        }
      }
      
      // Final save
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
      
      // Find the last page number in pagination
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
      
      // Wait for scheme cards to load
      await page.waitForSelector('#scheme-name-0', { timeout: 10000 }).catch(() => {
        console.log('No scheme cards found on page');
      });
      
      // Extract scheme cards
      const cards = await page.$$('[id^="scheme-name-"]');
      
      for (let i = 0; i < cards.length; i++) {
        try {
          const card = cards[i];
          const link = await card.$('a');
          const titleSpan = await card.$('span');
          
          if (link && titleSpan) {
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
          }
        } catch (error: any) {
          console.error(`Error extracting card ${i}:`, error.message);
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
      
      // Extract all sections
      const [title, ministry, tags, description, benefits, eligibility, exclusions, applicationProcess, documentsRequired, faqs] = await Promise.all([
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
      const titleEl = await page.$('h1');
      return titleEl ? cleanText(await titleEl.textContent() || '') : '';
    } catch {
      return '';
    }
  }

  private async extractMinistry(page: Page): Promise<string> {
    try {
      const ministryEl = await page.$('h3');
      return ministryEl ? cleanText(await ministryEl.textContent() || '') : '';
    } catch {
      return '';
    }
  }

  private async extractTags(page: Page): Promise<string[]> {
    try {
      const tagsContainer = await page.$('.mb-2.md\\:mb-0.w-full');
      if (!tagsContainer) return [];
      
      const tagButtons = await tagsContainer.$$('[role="button"]');
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
      const section = await page.$(sectionId);
      if (!section) return [];
      
      // Extract from Slate editor
      const slateEditor = await section.$('.markdown-options');
      if (!slateEditor) return [];
      
      const items = await slateEditor.$$('[data-slate-node="element"]');
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

  private async extractSlateText(element: any): Promise<string> {
    try {
      // Try to find text in Slate leaf nodes
      const leaves = await element.$$('[data-slate-string="true"]');
      if (leaves.length > 0) {
        const texts: string[] = [];
        for (const leaf of leaves) {
          const text = await leaf.textContent();
          if (text) texts.push(text);
        }
        return texts.join('');
      }
      
      // Fallback: get all text content
      return await element.textContent() || '';
    } catch {
      return '';
    }
  }

  private async extractApplicationProcess(page: Page): Promise<{ mode: string; steps: string[] }> {
    try {
      const section = await page.$('#application-process');
      if (!section) return { mode: '', steps: [] };
      
      // Extract mode
      const modeEl = await section.$('.capitalize');
      const mode = modeEl ? cleanText(await modeEl.textContent() || '') : 'Online';
      
      // Extract steps from Slate editor
      const slateEditor = await section.$('.markdown-options');
      const steps: string[] = [];
      
      if (slateEditor) {
        const items = await slateEditor.$$('[data-slate-node="element"]');
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

  private async extractFaqs(page: Page): Promise<FAQ[]> {
    try {
      const section = await page.$('#faqs');
      if (!section) return [];
      
      const faqs: FAQ[] = [];
      const faqItems = await section.$$('.py-4.first\\:pt-0.last\\:pb-0');
      
      for (const faqItem of faqItems) {
        const questionEl = await faqItem.$('p');
        const answerEl = await faqItem.$('.rounded-b');
        
        if (questionEl) {
          const question = cleanText(await questionEl.textContent() || '');
          let answer = '';
          
          if (answerEl) {
            const slateEditor = await answerEl.$('.markdown-options');
            if (slateEditor) {
              const leaves = await slateEditor.$$('[data-slate-string="true"]');
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
    
    // Save JSON
    saveSchemesJson(this.schemes);
    
    // Save CSV
    saveSchemesCsv(this.schemes);
    
    // Save final state
    this.saveProgress();
    
    // Save errors
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

// Main execution
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
    process.exit(0);
  } catch (error: any) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();