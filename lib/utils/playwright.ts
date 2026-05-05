import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';

import type { Browser as PlaywrightBrowser, BrowserContext, BrowserContextOptions, LaunchOptions, Page as PlaywrightPage, Request as PlaywrightRequest, Response as PlaywrightResponse, Route } from 'playwright';
import { chromium } from 'playwright';

import { config } from '@/config';

import logger from './logger';
import proxy from './proxy';

type SetCookieParam = Parameters<BrowserContext['addCookies']>[0][number];
type Cookie = Awaited<ReturnType<BrowserContext['cookies']>>[number];
type GotoOptions = Parameters<PlaywrightPage['goto']>[1] & {
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'networkidle0' | 'networkidle2';
};

type ProxyState = NonNullable<ReturnType<typeof proxy.getCurrentProxy>>;

type RouteRequest = {
    abort: (errorCode?: string) => Promise<void>;
    continue: (options?: Parameters<Route['continue']>[0]) => Promise<void>;
    resourceType: () => ReturnType<PlaywrightRequest['resourceType']>;
    url: () => string;
};

type FinishedRequest = {
    response: () => {
        status: () => number;
    } | null;
    url: () => string;
};

type RequestHandler = (request: RouteRequest) => Promise<void> | void;
type RequestFinishedHandler = (request: FinishedRequest) => Promise<void> | void;
type HandledRouteRequest = RouteRequest & { handled: boolean };

export type Page = PlaywrightPage & {
    authenticate: (credentials: { password?: string; username?: string }) => Promise<void>;
    cookies: (urls?: string | string[]) => Promise<Cookie[]>;
    goto: (url: string, options?: GotoOptions) => ReturnType<PlaywrightPage['goto']>;
    on: ((event: 'request', handler: RequestHandler) => Page) & ((event: 'requestfinished', handler: RequestFinishedHandler) => Page) & PlaywrightPage['on'];
    setCookie: (...cookies: SetCookieParam[]) => Promise<void>;
    setRequestInterception: (enabled: boolean) => Promise<void>;
    setUserAgent: (userAgent: string) => Promise<void>;
};

export type Browser = PlaywrightBrowser & {
    cookies: (urls?: string | string[]) => Promise<Cookie[]>;
    newPage: () => Promise<Page>;
    setCookie: (...cookies: SetCookieParam[]) => Promise<void>;
    userAgent: () => string;
};

const normalizeWaitUntil = (waitUntil: GotoOptions['waitUntil']) => (waitUntil === 'networkidle0' || waitUntil === 'networkidle2' ? 'networkidle' : waitUntil);

const normalizeGotoOptions = (options?: GotoOptions): Parameters<PlaywrightPage['goto']>[1] | undefined =>
    options
        ? {
              ...options,
              waitUntil: normalizeWaitUntil(options.waitUntil),
          }
        : options;

const withDefaultCookiePath = (cookie: SetCookieParam): SetCookieParam => ('domain' in cookie && !('path' in cookie) ? { ...cookie, path: '/' } : cookie);

const proxyServerFromUrl = (proxyUrl: URL) => {
    const protocol = proxyUrl.protocol.replace('socks5h:', 'socks5:').replace('socks4a:', 'socks4:');
    return `${protocol}//${proxyUrl.host}`;
};

const getProxyOptions = (currentProxy: ProxyState | null | undefined) => {
    if (!currentProxy) {
        return {};
    }

    const username = currentProxy.urlHandler?.username;
    const password = currentProxy.urlHandler?.password;
    if (username || password) {
        if (currentProxy.urlHandler.protocol !== 'http:') {
            logger.warn('SOCKS/HTTPS proxy with authentication is not supported by playwright, continue without proxy');
            return {};
        }

        return {
            proxy: {
                password: decodeURIComponent(password ?? ''),
                server: proxyServerFromUrl(currentProxy.urlHandler),
                username: decodeURIComponent(username ?? ''),
            },
        } satisfies Pick<LaunchOptions, 'proxy'>;
    }

    return {
        proxy: {
            server: currentProxy.uri.replace('socks5h://', 'socks5://').replace('socks4a://', 'socks4://').replace(/\/$/, ''),
        },
    } satisfies Pick<LaunchOptions, 'proxy'>;
};

const getLaunchOptions = (currentProxy?: ProxyState | null): LaunchOptions => ({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-position=0,0', '--ignore-certificate-errors', '--ignore-certificate-errors-spki-list', `--user-agent=${config.ua}`],
    executablePath: config.chromiumExecutablePath || undefined,
    headless: true,
    ...getProxyOptions(currentProxy),
});

const getContextOptions = (): BrowserContextOptions => ({
    ignoreHTTPSErrors: true,
    userAgent: config.ua,
});

const createRouteRequest = (route: Route): HandledRouteRequest => {
    const request = route.request();
    const routeRequest = {
        abort: async (errorCode) => {
            routeRequest.handled = true;
            await route.abort(errorCode);
        },
        continue: async (options) => {
            routeRequest.handled = true;
            await route.continue(options);
        },
        handled: false,
        resourceType: () => request.resourceType(),
        url: () => request.url(),
    };
    return routeRequest;
};

const runRequestHandlers = async (handlers: RequestHandler[], request: HandledRouteRequest, index = 0): Promise<void> => {
    if (request.handled || index >= handlers.length) {
        return;
    }

    await handlers[index](request);
    await runRequestHandlers(handlers, request, index + 1);
};

const createFinishedRequest = (request: PlaywrightRequest, response: PlaywrightResponse | null): FinishedRequest => ({
    response: () =>
        response
            ? {
                  status: () => response.status(),
              }
            : null,
    url: () => request.url(),
});

const patchPage = (page: PlaywrightPage, context: BrowserContext): Page => {
    const compatPage = page as Page;
    const requestHandlers: RequestHandler[] = [];
    const originalGoto = page.goto.bind(page);
    const originalOn = page.on.bind(page);
    const originalRoute = page.route.bind(page);
    const originalUnroute = page.unroute.bind(page);
    let routeHandler: ((route: Route) => Promise<void>) | undefined;
    let requestInterceptionEnabled = false;

    compatPage.goto = (url, options) => originalGoto(url, normalizeGotoOptions(options));
    compatPage.cookies = (urls) => context.cookies(urls);
    compatPage.setCookie = async (...cookies) => {
        await context.addCookies(cookies.map((cookie) => withDefaultCookiePath(cookie)));
    };
    compatPage.authenticate = async () => {};
    compatPage.setUserAgent = async (userAgent) => {
        const contextWithCDP = context as BrowserContext & {
            newCDPSession?: (page: PlaywrightPage) => Promise<{
                detach: () => Promise<void>;
                send: (method: string, params?: Record<string, unknown>) => Promise<void>;
            }>;
        };
        if (contextWithCDP.newCDPSession) {
            const session = await contextWithCDP.newCDPSession(page);
            await session.send('Network.setUserAgentOverride', { userAgent });
            await session.detach();
            return;
        }
        await page.setExtraHTTPHeaders({
            'User-Agent': userAgent,
        });
    };
    compatPage.setRequestInterception = async (enabled) => {
        requestInterceptionEnabled = enabled;
        if (enabled && !routeHandler) {
            routeHandler = async (route) => {
                const request = createRouteRequest(route);
                await runRequestHandlers(requestHandlers, request);
                if (request.handled) {
                    return;
                }
                await route.continue();
            };
            await originalRoute('**/*', routeHandler);
        } else if (!enabled && routeHandler) {
            await originalUnroute('**/*', routeHandler);
            routeHandler = undefined;
        }
    };
    compatPage.on = ((event: string, handler: (...args: any[]) => any) => {
        if (event === 'request') {
            requestHandlers.push(handler as RequestHandler);
            if (!requestInterceptionEnabled) {
                originalOn(event, handler);
            }
            return compatPage;
        }
        if (event === 'requestfinished') {
            originalOn(event, async (request) => {
                const response = await request.response();
                await (handler as RequestFinishedHandler)(createFinishedRequest(request, response));
            });
            return compatPage;
        }
        originalOn(event, handler);
        return compatPage;
    }) as Page['on'];

    return compatPage;
};

const createCompatBrowser = async (browser: PlaywrightBrowser, contextOptions: BrowserContextOptions): Promise<Browser> => {
    const context = await browser.newContext(contextOptions);
    const compatBrowser = browser as Browser;
    const originalClose = browser.close.bind(browser);

    compatBrowser.newPage = async () => patchPage(await context.newPage(), context);
    compatBrowser.setCookie = async (...cookies) => {
        await context.addCookies(cookies.map((cookie) => withDefaultCookiePath(cookie)));
    };
    compatBrowser.cookies = (urls) => context.cookies(urls);
    compatBrowser.userAgent = () => config.ua;
    compatBrowser.close = async (options) => {
        try {
            await context.close();
        } catch {
            // Ignore already-closed contexts.
        }
        await originalClose(options);
    };

    return compatBrowser;
};

let lightpandaProc: ChildProcess | null = null;

const waitForCDP = (port: number, timeout = 10000): Promise<void> => {
    const deadline = Date.now() + timeout;
    const attempt = async (): Promise<void> => {
        if (Date.now() >= deadline) {
            throw new Error(`Lightpanda CDP not ready on port ${port} after ${timeout}ms`);
        }
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (res.ok) {
                return;
            }
        } catch {
            // not ready yet
        }
        await new Promise<void>((r) => setTimeout(r, 100));
        return attempt();
    };
    return attempt();
};

const ensureLightpanda = async (): Promise<void> => {
    if (lightpandaProc) {
        return;
    }
    try {
        await access(config.lightpandaExecutablePath);
    } catch {
        logger.error(
            `Lightpanda binary not found at ${config.lightpandaExecutablePath}. Install it with: curl -fsSL https://pkg.lightpanda.io/install.sh | bash`
        );
        throw new Error(`Lightpanda binary not found at ${config.lightpandaExecutablePath}`);
    }
    lightpandaProc = spawn(config.lightpandaExecutablePath, ['serve', '--host', '127.0.0.1', '--port', String(config.lightpandaPort), '--log-level', 'info'], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    lightpandaProc.on('exit', () => {
        lightpandaProc = null;
    });
    await waitForCDP(config.lightpandaPort);
    logger.debug(`Lightpanda CDP server ready on port ${config.lightpandaPort}`);
};

const launchLightpanda = async (): Promise<Browser> => {
    await ensureLightpanda();
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.lightpandaPort}`);
    return createCompatBrowser(browser, getContextOptions());
};

const launchBrowser = async (currentProxy?: ProxyState | null) => {
    if (config.useLightpanda) {
        return launchLightpanda();
    }
    const launchOptions = getLaunchOptions(currentProxy);
    const browser = config.playwrightWSEndpoint ? await chromium.connectOverCDP(getEndpointWithLaunchOptions(config.playwrightWSEndpoint, launchOptions)) : await chromium.launch(launchOptions);
    return createCompatBrowser(browser, getContextOptions());
};

const getEndpointWithLaunchOptions = (endpoint: string, launchOptions: LaunchOptions) => {
    const endpointURL = new URL(endpoint);
    endpointURL.searchParams.set('launch', JSON.stringify(launchOptions));
    return endpointURL.toString();
};

const scheduleClose = (browser: Browser) => {
    setTimeout(() => {
        void browser.close();
    }, 30000);
};

/**
 * @returns Playwright browser
 */
const outPlaywright = async () => {
    const currentProxy = proxy.getCurrentProxy();
    const browser = await launchBrowser(currentProxy && proxy.proxyObj.url_regex === '.*' ? currentProxy : null);
    scheduleClose(browser);
    return browser;
};

export default outPlaywright;

// No-op in Node.js environment (used by Worker build via alias)
export const setBrowserBinding = (_binding: any) => {};

/**
 * @returns Playwright page
 */
export const getPlaywrightPage = async (
    url: string,
    instanceOptions: {
        gotoConfig?: GotoOptions;
        noGoto?: boolean;
        onBeforeLoad?: (page: Page, browser?: Browser) => Promise<void> | void;
    } = {}
) => {
    let allowProxy = false;
    const proxyRegex = new RegExp(proxy.proxyObj.url_regex);
    let urlHandler: URL | undefined;
    try {
        urlHandler = new URL(url);
    } catch {
        // ignore invalid URLs such as about:blank
    }

    if (proxyRegex.test(url) && url.startsWith('http') && !(urlHandler && urlHandler.host === proxy.proxyUrlHandler?.host)) {
        allowProxy = true;
    }

    const currentProxy = proxy.getCurrentProxy();
    const currentProxyState = currentProxy && allowProxy ? currentProxy : null;
    const hasProxy = Boolean(getProxyOptions(currentProxyState).proxy);
    const browser = await launchBrowser(currentProxyState);
    scheduleClose(browser);
    const page = await browser.newPage();

    if (hasProxy && currentProxyState) {
        logger.debug(`Proxying request in playwright via ${currentProxyState.uri}: ${url}`);
    }

    if (instanceOptions.onBeforeLoad) {
        await instanceOptions.onBeforeLoad(page, browser);
    }

    if (!instanceOptions.noGoto) {
        try {
            await page.goto(url, instanceOptions.gotoConfig || { waitUntil: 'domcontentloaded' });
        } catch (error) {
            if (hasProxy && currentProxyState && proxy.multiProxy) {
                logger.warn(`Playwright navigation failed with proxy ${currentProxyState.uri}, marking as failed: ${error}`);
                proxy.markProxyFailed(currentProxyState.uri);
                throw error;
            }
            throw error;
        }
    }

    return {
        browser,
        destroy: async () => {
            await browser.close();
        },
        page,
    };
};

export const getPuppeteerPage = getPlaywrightPage;
