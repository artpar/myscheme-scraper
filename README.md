# myscheme-scraper

Playwright-based scraper for [myscheme.gov.in](https://www.myscheme.gov.in) - extracts all Indian government schemes in structured JSON/CSV format.

## Features

- Scrapes all ~4,700+ government schemes from myscheme.gov.in
- Structured output with: title, ministry, tags, description, benefits, eligibility, exclusions, application process, documents required, and FAQs
- Pagination support (471 pages × 10 results)
- Rate limiting and polite scraping
- JSON and CSV export formats
- Progress tracking with resume capability

## Installation

```bash
npm install
npx playwright install chromium
```

## Usage

```bash
# Scrape all schemes (default - polite rate limiting)
npm run scrape

# Fast mode (higher concurrency, use responsibly)
npm run scrape:fast

# Build TypeScript
npm run build
```

## Output

Results are saved to `output/` directory:
- `schemes.json` - All schemes in JSON format
- `schemes.csv` - All schemes in CSV format
- `scraping-state.json` - Progress/resume state

## Data Schema

Each scheme contains:
```typescript
{
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
  faqs: { question: string; answer: string; }[];
  url: string;
  scrapedAt: string;
}
```

## Project Structure

```
├── src/
│   ├── scraper.ts      # Main scraper logic
│   ├── types.ts        # TypeScript interfaces
│   └── utils.ts        # Utility functions
├── output/             # Scraped data output
├── package.json
├── tsconfig.json
└── playwright.config.ts
```

## License

MIT