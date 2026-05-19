import { test, expect } from '@playwright/test';
import { MyschemeScraper } from '../src/scraper';

test.describe('myscheme.gov.in Scraper', () => {
  test('should extract scheme list from search page', async ({ page }) => {
    await page.goto('https://www.myscheme.gov.in/search');
    
    // Wait for scheme cards
    await page.waitForSelector('#scheme-name-0', { timeout: 10000 });
    
    // Check that scheme cards exist
    const cards = await page.$$('[id^="scheme-name-"]');
    expect(cards.length).toBeGreaterThan(0);
    
    // Get first scheme title
    const firstTitle = await page.$eval('#scheme-name-0 span', el => el.textContent);
    expect(firstTitle).toBeTruthy();
    console.log('First scheme:', firstTitle);
  });

  test('should navigate pagination', async ({ page }) => {
    await page.goto('https://www.myscheme.gov.in/search');
    await page.waitForSelector('#scheme-name-0', { timeout: 10000 });
    
    // Click page 2
    const page2 = await page.$('ul li:has-text("2")');
    if (page2) {
      await page2.click();
      await page.waitForTimeout(2000);
      
      // Verify we're on page 2
      const url = page.url();
      expect(url).toContain('page=2');
    }
  });

  test('should extract scheme detail page', async ({ page }) => {
    // Go to first scheme
    await page.goto('https://www.myscheme.gov.in/search');
    await page.waitForSelector('#scheme-name-0', { timeout: 10000 });
    
    // Click first scheme
    const firstLink = await page.$('#scheme-name-0 a');
    const href = await firstLink?.getAttribute('href');
    
    if (href) {
      await page.goto(`https://www.myscheme.gov.in${href}`);
      await page.waitForLoadState('networkidle');
      
      // Check title exists
      const title = await page.$('h1');
      expect(title).toBeTruthy();
      
      // Check sections exist
      const details = await page.$('#details');
      const benefits = await page.$('#benefits');
      const eligibility = await page.$('#eligibility');
      
      expect(details).toBeTruthy();
      expect(benefits).toBeTruthy();
      expect(eligibility).toBeTruthy();
      
      console.log('Scheme detail page loaded successfully');
    }
  });
});