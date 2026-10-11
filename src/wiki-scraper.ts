import assert from 'node:assert';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import camelCase from 'lodash/camelCase.js';
import { type Browser, type Locator, type Page, chromium } from 'playwright';
import { P, match } from 'ts-pattern';

import { Formatter, Selector } from '#@/playwright.js';
import type { EventSignature, FunctionSignature, VariableSignature } from '#@/types.js';
import { Duration } from '#@/units.js';
import { extractSemanticRange, serializeLocalFileURL, sleep, splitStringOnceBy, trimExtension } from '#@/utils.js';

type WikiScraperInput = {
  cacheDirectory: string;
  origin: string;
};

export class WikiScraper {
  private cachedFiles: Record<string, string>;
  private cacheDirectory: string;
  private origin: string;

  private browser?: Browser;

  selector = new Selector();
  formatter = new Formatter();

  constructor({ cacheDirectory, origin }: WikiScraperInput) {
    this.cachedFiles = {};
    this.cacheDirectory = cacheDirectory;
    this.origin = origin;
  }

  async init() {
    this.browser ||= await chromium.launch({
      args: ['--disable-gl-drawing-for-tests'],
    });

    const context = await this.browser.newContext({ javaScriptEnabled: false });
    context.setDefaultTimeout(Duration.fromSeconds(5).asMillis());

    return context;
  }

  listPages() {
    const pages = readdirSync(join(this.cacheDirectory, 'wiki')).map(trimExtension);

    for (const page of pages) {
      const localFileURL = serializeLocalFileURL(this.cacheDirectory, page);
      this.cachedFiles[page] = localFileURL.toString();
    }

    return pages;
  }

  resourceReference(path: string) {
    const page = this.cachedFiles[path] || `${this.origin}/wiki/${path}`;
    console.info(`Visiting: ${trimExtension(basename(page))}`);
    return page;
  }

  async cachePage(page: Page, resourcePath: string) {
    const html = await page.content();

    const localFileURL = serializeLocalFileURL(this.cacheDirectory, resourcePath);

    if (isCloudflareBlockedNotice(html)) {
      delete this.cachedFiles[resourcePath];
      rmSync(localFileURL.pathname, { force: true });
      throw new Error('Blocked');
    }

    if (existsSync(localFileURL.pathname)) {
      this.cachedFiles[resourcePath] = localFileURL.toString();
      return;
    }

    mkdirSync(dirname(localFileURL.pathname), { recursive: true });
    writeFileSync(localFileURL.pathname, html);

    console.info('Stored:', localFileURL.toString());
  }

  async visitPage(page: Page, resourcePath: string) {
    let isBlockedByCloudflare = true;
    do {
      await page.goto(this.resourceReference(resourcePath));
      try {
        await this.cachePage(page, resourcePath);
        isBlockedByCloudflare = false;
      } catch {
        await sleep(Duration.fromSeconds(1 + Math.random() * 5).asMillis());
      }
    } while (isBlockedByCloudflare);
  }

  async downloadPages() {
    const browserContext = await this.init();

    const page = await browserContext.newPage();

    for (const entry of ['World_of_Warcraft_API', 'Events']) {
      await page.goto(this.resourceReference(entry));
      await this.cachePage(page, entry);

      const subpages = [];

      // Gets all immediate links from description details following the primary
      // headings, effectively the link of all function declarations
      const links = await page.locator('//div[@id="mw-content-text"]/div[@class="mw-parser-output"]/dl/dd/a[1]').all();

      const chunkSize = 20;
      const chunkedLinks = [...Array(Math.ceil(links.length / chunkSize))].map((_) => links.splice(0, chunkSize));

      for (const chunk of chunkedLinks) {
        subpages.push(
          ...(
            await Promise.all(
              chunk.map(async (a) => {
                const link = await a.getAttribute('href');
                if (!link?.startsWith('/')) {
                  return null;
                }
                console.log('Found', link);
                return link;
              }),
            )
          ).filter((link) => typeof link === 'string'),
        );
      }

      for (const subpage of subpages) {
        await this.visitPage(page, subpage);
      }
    }

    console.info('Page download completed!');
  }

  async scrapeFunctionPage(page: Page, resource: string) {
    await this.visitPage(page, resource);

    const pageTitleLocator = page.locator(this.selector.overridable(resource, 'pageTitle')).first();

    const pageBody = page.locator('//div[@id="mw-content-text"]/div[@class="mw-parser-output"]');

    const descriptionLocator = pageBody.locator(this.selector.overridable(resource, 'description'));
    const parametersHeaderLocator = pageBody.locator('h2:has(> #Arguments)');
    const returnsHeaderLocator = pageBody.locator('h2:has(> #Returns)');
    const eventTriggersHeaderLocator = pageBody.locator('h2:has(> #Triggers_events)');
    const patchChangesHeaderLocator = pageBody.locator('h2:has(> #Patch_changes)');

    try {
      const [pageTitle, description, parameterLocators, returnLocators, eventTriggerLocators, patchChangeLocators] =
        await Promise.all([
          pageTitleLocator.textContent().then(this.formatter.overridable(resource, 'pageTitle')),
          descriptionLocator.textContent().then(this.formatter.overridable(resource, 'description')),
          parametersHeaderLocator.locator('//following-sibling::dl[1]/dd/dl').all(),
          returnsHeaderLocator.locator('//following-sibling::dl[1]/dd/dl').all(),
          eventTriggersHeaderLocator.locator('//following-sibling::ul[1]/li').all(),
          patchChangesHeaderLocator.locator('//following-sibling::ul[1]/li').all(),
        ] as const);

      if (!pageTitle) {
        throw new Error(`Needs special handling: ${JSON.stringify({ pageTitle })} ${JSON.stringify({ description })}`);
      }

      return extractFunction({
        pageTitle,
        description,
        parameterLocators,
        returnLocators,
        eventTriggerLocators,
        patchChangeLocators,
      });
    } catch (error) {
      if (error instanceof Error) {
        console.error(error.message);
      }

      return null;
    }
  }

  async scrapeEventPage(page: Page, resource: string) {
    await this.visitPage(page, resource);

    const pageTitleLocator = page.locator('h1').first();
    const pageBody = page.locator('//div[@id="mw-content-text"]/div[@class="mw-parser-output"]');

    const descriptionLocator = pageBody.locator('> p:first-of-type');

    const parametersHeaderLocator = pageBody.locator('h2:has(> #Arguments)');
    const returnsHeaderLocator = pageBody.locator('h2:has(> #Returns)');
    const eventTriggersHeaderLocator = pageBody.locator('h2:has(> #Triggers_events)');
    const patchChangesHeaderLocator = pageBody.locator('h2:has(> #Patch_changes)');

    const [pageTitle, description, parameterLocators, returnLocators, eventTriggerLocators, patchChangeLocators] =
      await Promise.all([
        pageTitleLocator.textContent().then((content) => content?.trim()),
        descriptionLocator.textContent().then((content) => content?.trim()),
        parametersHeaderLocator.locator('//following-sibling::dl[1]/dd/dl').all(),
        returnsHeaderLocator.locator('//following-sibling::dl[1]/dd/dl').all(),
        eventTriggersHeaderLocator.locator('//following-sibling::ul[1]/li').all(),
        patchChangesHeaderLocator.locator('//following-sibling::ul[1]/li').all(),
      ] as const);

    if (!pageTitle || !description) {
      console.log('Skipped', resource);

      // SPecial handling for
      // match(pageTitle)
      //   .with('SPECIAL', ()=> {
      //   });
      return;
    }

    // TODO
    return extractEvent({
      pageTitle,
      description,
      parameterLocators,
      returnLocators,
      eventTriggerLocators,
      patchChangeLocators,
    }) as unknown as EventSignature;
  }

  async scrape(forceDownload: boolean) {
    const browserContext = await this.init();

    const subpages = this.listPages().reduce<{ functions: string[]; events: string[] }>(
      (pages, page) => {
        match(page)
          .with(P.string.startsWith('API'), (p) => {
            pages.functions.push(p);
          })
          .otherwise((p) => {
            // This needs to be properly handled
            // pages.events.push(p);
          });

        return pages;
      },
      { functions: [], events: [] },
    );

    const hasCachedPages = !!subpages.functions.length || !!subpages.events.length;
    if (!hasCachedPages || forceDownload) {
      await this.downloadPages();
    }

    const functions: FunctionSignature[] = [];
    const events: EventSignature[] = [];

    const page = await browserContext.newPage();

    for (const [i, subpage] of subpages.functions.map((f, i) => [i, f] as const)) {
      process.stdout.write(`${`${i}`.padStart(4, ' ')} `);

      const func = await this.scrapeFunctionPage(page, subpage);
      if (!func) {
        continue;
      }

      functions.push(func);
    }

    for (const subpage of subpages.events) {
      const event = await this.scrapeEventPage(page, subpage);

      if (!event) {
        continue;
      }

      events.push(event);
    }

    console.log('Scraping completed');

    await browserContext.browser()?.close();

    return { functions, events };
  }
}

// Cloudflare responds with a block notice splash screen when bot-like behavior
// is detected
export function isCloudflareBlockedNotice(content: string) {
  return content.includes('Sorry, you have been blocked') || content.includes('challenge-error-text');
}

export async function parseLocatorPairToVariableSignature([lhs, rhs]: [Locator, Locator]): Promise<VariableSignature> {
  const [variableName, variableDetails] = await Promise.all([lhs.textContent(), rhs.textContent()]);

  assert(variableName, 'Failed to extract variable name');
  assert(variableDetails, 'Failed to extract variable details');

  const [_type, description = ''] = variableDetails.trim().split(' - ');
  const [t, opt] = _type.split(/(?=\?)/);

  return {
    name: camelCase(variableName.trim()),
    type: t,
    nilable: opt === '?',
    description,
  };
}

type ExtractFunctionInput = {
  pageTitle: string;
  description: string;
  parameterLocators: Locator[];
  returnLocators: Locator[];
  eventTriggerLocators: Locator[];
  patchChangeLocators: Locator[];
};
export async function extractFunction({
  pageTitle,
  description,
  parameterLocators,
  returnLocators,
  eventTriggerLocators,
  patchChangeLocators,
}: ExtractFunctionInput) {
  const saneName = pageTitle.replace(/\(|\)/g, '');
  const [ns, title] = splitStringOnceBy(saneName, '.');
  const [iface, name] = splitStringOnceBy(title, ':');

  const [parameters = [], returns = []] = await Promise.all(
    [parameterLocators, returnLocators].map(async (locators) => {
      return Promise.all(
        locators.map(async (locator) => {
          const [variables, descriptions] = await Promise.all([
            locator.locator('> dt').all(),
            locator.locator('> dd').all(),
          ]);

          const zippedLines = variables.map((v, i) => [v, descriptions[i]].filter(Boolean)) as [Locator, Locator][];

          return Promise.all(zippedLines.map(parseLocatorPairToVariableSignature));
        }),
      );
    }),
  );

  const [eventsText, patchChangesText] = await Promise.all([
    Promise.all(eventTriggerLocators.map(async (locator) => locator.textContent())),
    Promise.all(patchChangeLocators.map(async (locator) => locator.textContent())),
  ]);

  const events = eventsText
    .map((eventEntry) => {
      if (!eventEntry) {
        return null;
      }

      return match(/([A-Z_]+)(.*)/.exec(eventEntry))
        .when(
          (r) => !!r,
          (result) => {
            const [, name = null, description = ''] = result;
            return name ? { name, description } : null;
          },
        )
        .otherwise(() => null);
    })
    .filter(Boolean);

  const since = patchChangesText.filter(Boolean).find((t) => {
    if (!t) {
      return false;
    }

    return t.match(/added/i);
  });

  const until = patchChangesText.filter(Boolean).find((t) => {
    if (!t) {
      return false;
    }

    return t.match(/removed/i);
  });

  const semverRange = extractSemanticRange(since, until);
  console.info(
    `     └ ${iface ? `${iface}:` : ''}${name}(${parameters
      .flat()
      .map((p) => p.name)
      .join(', ')}): [${returns
      .flat()
      .map((p) => p.name)
      .join(', ')}] ${ns ? `(${ns})` : ''} ${semverRange.format()}`,
  );

  return {
    name,
    ns,
    iface,
    description,
    parameters: parameters.flat(),
    returns: returns.flat(),
    events,
    version: semverRange,
  };
}

type ExtractEventInput = {
  pageTitle: string;
  description: string;
  parameterLocators: Locator[];
  returnLocators: Locator[];
  eventTriggerLocators: Locator[];
  patchChangeLocators: Locator[];
};
export async function extractEvent({
  pageTitle,
  description,
  parameterLocators,
  returnLocators,
  eventTriggerLocators,
  patchChangeLocators,
}: ExtractFunctionInput) {
  const saneName = pageTitle.replace(/\(|\)/g, '');
  const [ns, title] = splitStringOnceBy(saneName, '.');
  const [iface, name] = splitStringOnceBy(title, ':');

  const [parameters = [], returns = []] = await Promise.all(
    [parameterLocators, returnLocators].map(async (locators) => {
      return Promise.all(
        locators.map(async (locator) => {
          const [variables, descriptions] = await Promise.all([
            locator.locator('dt').all(),
            locator.locator('dd').all(),
          ]);

          const zippedLines = variables.map((v, i) => [v, descriptions[i]].filter(Boolean)) as [Locator, Locator][];

          return Promise.all(zippedLines.map(parseLocatorPairToVariableSignature));
        }),
      );
    }),
  );

  const [eventsText, patchChangesText] = await Promise.all([
    Promise.all(eventTriggerLocators.map(async (locator) => locator.textContent())),
    Promise.all(patchChangeLocators.map(async (locator) => locator.textContent())),
  ]);

  const events = eventsText
    .map((eventEntry) => {
      if (!eventEntry) {
        return null;
      }

      return match(/([A-Z_]+)(.*)/.exec(eventEntry))
        .when(
          (r) => !!r,
          (result) => {
            const [, name = null, description = ''] = result;
            return name ? { name, description } : null;
          },
        )
        .otherwise(() => null);
    })
    .filter(Boolean);

  const since = patchChangesText.filter(Boolean).find((t) => {
    if (!t) {
      return false;
    }

    return t.match(/added/i);
  });

  const until = patchChangesText.filter(Boolean).find((t) => {
    if (!t) {
      return false;
    }

    return t.match(/removed/i);
  });

  return {
    name,
    ns,
    description,
    parameters: parameters.flat(),
    returns: returns.flat(),
    events,
    version: extractSemanticRange(since, until),
  };
}
