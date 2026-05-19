/**
 * Main scraper for myscheme.gov.in
 * Scrapes and saves each scheme immediately - no memory accumulation
 */

import { chromium, Browser, Page } from 'playwright';
import * as fs from 'fs';
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
  generateSchemeId,
  delay,
  cleanText,
  logProgress,
  formatDate
} from './utils';

class MyschemeScraper {
  private browser: Browser | null = null;
  private config: ScraperConfig;
  private state: ScrapingState;
  private isFastMode: boolean = false;
  private schemesFile: string;
  private csvFile: string;

  constructor(config: Partial<ScraperConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = this.loadOrCreateState();
    ensureOutputDir(this.config.outputDir);
    this.schemesFile = `${this.config.outputDir}/schemes.json`;
    this.csvFile = `${this.config.outputDir}/schemes.csv`;
    
    // Initialize output files
    if (!fs.existsSync(this.schemesFile)) {
      fs.writeFileSync(this.schemesFile, JSON.stringify([]));
    }
    if (!fs.existsSync(this.csvFile)) {
      fs.writeFileSync(this.csvFile, 'id,title,ministry,tags,description,url,scrapedAt\n');
    }
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

  async scrape(): Promise<number> {
    await this.initialize();
    let totalScraped = 0;
    
    try {
      // Get total pages from first load
      await this.updateTotalPages();
      
      console.log(`Total pages: ${this.state.totalPages}`);
      
      for (let pageNum = this.state.currentPage; pageNum <= this.state.totalPages; pageNum++) {
        this.state.currentPage = pageNum;
        logProgress(pageNum, this.state.totalPages, 'pages');
        
        try {
          const schemeItems = await this.scrapePage(pageNum);
          console.log(`Found ${schemeItems.length} schemes on page ${pageNum}`);
          
          for (const item of schemeItems) {
            if (this.state.scrapedSchemeIds.includes(item.id)) {
              continue;
            }
            
            try {
              const scheme = await this.scrapeSchemeDetail(item);
              this.saveScheme(scheme);
              this.state.scrapedSchemeIds.push(item.id);
              totalScraped++;
              
              console.log(`  [${totalScraped}] ${scheme.title}`);
              
              // Save progress every 10 schemes
              if (totalScraped % 10 === 0) {
                this.saveProgress();
              }
              
              await delay(this.isFastMode ? this.config.fastDelayMs : this.config.delayMs);
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              console.error(`Error: ${item.id} - ${message}`);
              this.state.errors.push({
                page: pageNum,
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
          console.error(`Page ${pageNum} error:`, message);
          this.state.errors.push({
            page: pageNum,
            error: message,
            timestamp: new Date().toISOString(),
          });
        }
      }
      
    } finally {
      await this.close();
    }
    
    console.log(`\n✅ Complete! Total schemes scraped: ${totalScraped}`);
    return totalScraped;
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
        const links = Array.from(document.querySelectorAll('ul li'));
        let max = 1;
        for (const li of links) {
          const n = parseInt(li.textContent?.trim() || '', 10);
          if (!isNaN(n) && n > max) max = n;
        }
        return max;
      });
      
      this.state.totalPages = lastPage;
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
      
      await page.waitForSelector('#scheme-name-0', { timeout: 10000 }).catch(() => {});
      
      const cards = await page.locator('[id^="scheme-name-"]').all();
      
      for (const card of cards) {
        const href = await card.locator('a').getAttribute('href');
        const title = await card.locator('span').textContent();
        
        if (href && title) {
          items.push({
            id: generateSchemeId(href),
            title: cleanText(title),
            url: href.startsWith('http') ? href : `${this.config.baseUrl}${href}`,
            ministry: '',
            tags: [],
          });
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
      await page.waitForTimeout(1500);
      
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
        tags,
        description: description.join('\n\n'),
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
    const el = page.locator('h1');
    return (await el.count()) > 0 ? cleanText(await el.textContent() || '') : '';
  }

  private async extractMinistry(page: Page): Promise<string> {
    const el = page.locator('h3');
    if ((await el.count()) === 0) return '';
    const text = await el.textContent() || '';
    return text.includes('error') || text.includes('wrong') ? '' : cleanText(text);
  }

  private async extractTags(page: Page): Promise<string[]> {
    const buttons = await page.locator('.mb-2.md\\:mb-0.w-full [role="button"]').all();
    const tags: string[] = [];
    for (const btn of buttons) {
      const t = await btn.textContent();
      if (t) tags.push(cleanText(t));
    }
    return tags;
  }

  private async extractSection(page: Page, sectionId: string): Promise<string[]> {
    const section = page.locator(sectionId);
    if ((await section.count()) === 0) return [];
    
    const slate = section.locator('.markdown-options');
    if ((await slate.count()) === 0) return [];
    
    const items = await slate.locator('[data-slate-node="element"]').all();
    const results: string[] = [];
    
    for (const item of items) {
      const leaves = await item.locator('[data-slate-string="true"]').all();
      if (leaves.length > 0) {
        const texts = (await Promise.all(leaves.map(l => l.textContent()))).filter(Boolean);
        const text = texts.join('');
        if (text.trim()) results.push(cleanText(text));
      }
    }
    
    return results;
  }

  private async extractApplicationProcess(page: Page): Promise<{ mode: string; steps: string[] }> {
    const section = page.locator('#application-process');
    if ((await section.count()) === 0) return { mode: 'Online', steps: [] };
    
    const modeEl = section.locator('.capitalize');
    const mode = (await modeEl.count()) > 0 ? cleanText(await modeEl.textContent() || '') : 'Online';
    
    const slate = section.locator('.markdown-options');
    const steps: string[] = [];
    
    if ((await slate.count()) > 0) {
      const items = await slate.locator('[data-slate-node="element"]').all();
      for (const item of items) {
        const leaves = await item.locator('[data-slate-string="true"]').all();
        if (leaves.length > 0) {
          const texts = (await Promise.all(leaves.map(l => l.textContent()))).filter(Boolean);
          const text = texts.join('');
          if (text.trim()) steps.push(cleanText(text));
        }
      }
    }
    
    return { mode, steps };
  }

  private async extractDocumentsRequired(page: Page): Promise<string[]> {
    return this.extractSection(page, '#documents-required');
  }

  private async extractFaqs(page: Page): Promise<{ question: string; answer: string }[]> {
    const section = page.locator('#faqs');
    if ((await section.count()) === 0) return [];
    
    const faqs: { question: string; answer: string }[] = [];
    const items = await section.locator('.py-4').all();
    
    for (const item of items) {
      const qEl = item.locator('p');
      if ((await qEl.count()) === 0) continue;
      
      const question = cleanText(await qEl.textContent() || '');
      if (!question) continue;
      
      let answer = '';
      const aEl = item.locator('.rounded-b');
      if ((await aEl.count()) > 0) {
        const slate = aEl.locator('.markdown-options');
        if ((await slate.count()) > 0) {
          const leaves = await slate.locator('[data-slate-string="true"]').all();
          const texts = (await Promise.all(leaves.map(l => l.textContent()))).filter(Boolean);
          answer = cleanText(texts.join(''));
        }
      }
      
      faqs.push({ question, answer });
    }
    
    return faqs;
  }

  private saveScheme(scheme: Scheme): void {
    // Save to JSON (append to array)
    const data = JSON.parse(fs.readFileSync(this.schemesFile, 'utf-8'));
    data.push(scheme);
    fs.writeFileSync(this.schemesFile, JSON.stringify(data, null, 2));
    
    // Save to CSV (append line)
    const csvLine = [
      scheme.id,
      `"${scheme.title.replace(/"/g, '""')}"`,
      `"${scheme.ministry.replace(/"/g, '""')}"`,
      `"${scheme.tags.join('; ').replace(/"/g, '""')}"`,
      `"${scheme.description.replace(/"/g, '""')}"`,
      scheme.url,
      scheme.scrapedAt
    ].join(',');
    
    fs.appendFileSync(this.csvFile, csvLine + '\n');
  }

  private saveProgress(): void {
    this.state.lastScrapedAt = new Date().toISOString();
    saveState(this.state);
    
    if (this.state.errors.length > 0) {
      fs.writeFileSync(
        `${this.config.outputDir}/errors-${formatDate()}.json`,
        JSON.stringify(this.state.errors, null, 2)
      );
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const scraper = new MyschemeScraper();
  scraper.setFastMode(args.includes('--fast'));
  
  console.log('myscheme.gov.in scraper - incremental save');
  console.log('=========================================\n');
  
  try {
    await scraper.scrape();
  } catch (error) {
    console.error('Fatal error:', error);
  }
}

main();