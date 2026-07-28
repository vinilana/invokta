export interface ScrapedPage {
  readonly url: string;
  readonly title: string | null;
  readonly statusCode: number;
  readonly markdown: string;
}

export interface DiscoveredLink {
  readonly url: string;
  readonly title: string | null;
  readonly description: string | null;
}

export interface SiteCrawl {
  readonly pages: ReadonlyArray<ScrapedPage>;
}
