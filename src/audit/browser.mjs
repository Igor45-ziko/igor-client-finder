import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import robotsParser from 'robots-parser';
import { chromium } from 'playwright';
import { siteEvidence, isDirectory } from './matching.mjs';
import { linkContact } from './contacts.mjs';

export function publicIp(ip) {
  ip = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
  }
  // Only global-unicast IPv6; reject mapped IPv4 and local/transition addresses.
  return isIP(ip) === 6 && /^[23][0-9a-f]{3}:/.test(ip) && !/^200[12]:/.test(ip);
}
export async function publicUrl(raw, resolver = lookup) {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port))) throw new Error('UNSAFE_URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host.includes('.') && !isIP(host)) throw new Error('UNSAFE_HOST');
  if (/(^|\.)(localhost|local|internal|test|invalid)$/.test(host)) throw new Error('UNSAFE_HOST');
  const addresses = isIP(host) ? [{ address: host }] : await resolver(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(x => !publicIp(x.address))) throw new Error('NON_PUBLIC_ADDRESS');
  return url;
}

export async function launchBrowser({ env = process.env } = {}) {
  const options = { headless: true };
  if (env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) options.executablePath = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  else if (process.platform === 'win32') {
    const candidates = [env['PROGRAMFILES(X86)'], env.PROGRAMFILES, env.LOCALAPPDATA].filter(Boolean).map(p => join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    for (const path of candidates) if (await access(path).then(() => true, () => false)) { options.executablePath = path; break; }
  }
  const proxyValue = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  if (proxyValue) {
    const proxy = new URL(proxyValue);
    // Only local fixture/health servers use loopback directly. All public destinations
    // retain the configured proxy; production publicUrl rejects loopback candidates.
    options.proxy = { server: `${proxy.protocol}//${proxy.host}`, bypass: '127.0.0.1,localhost,[::1]' };
    if (proxy.username) options.proxy.username = decodeURIComponent(proxy.username);
    if (proxy.password) options.proxy.password = decodeURIComponent(proxy.password);
  }
  return chromium.launch(options);
}

export function createAuditor({ browser, guard = publicUrl, fetchImpl = fetch, pause = sleep, clock = Date.now } = {}) {
  const policies = new Map(); const lastVisit = new Map(); const limited = new Set();
  async function policy(raw) {
    const url = await guard(raw); const origin = url.origin;
    if (policies.has(origin)) return policies.get(origin);
    const robotsUrl = origin + '/robots.txt';
    let r; let current = robotsUrl;
    for (let redirect = 0; redirect < 4; redirect++) {
      await guard(current);
      r = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'IgorClientFinder/0.2' } });
      if (![301, 302, 303, 307, 308].includes(r.status) || !r.headers.get('location')) break;
      current = new URL(r.headers.get('location'), current).href; await r.body?.cancel();
    }
    let value;
    if (r.status === 404 || r.status === 410) value = { allowed: true, robots: robotsParser(robotsUrl, ''), delay: 2000 };
    else if (!r.ok || r.status >= 300) value = { allowed: false, reason: `robots.txt HTTP ${r.status}` };
    else {
      let text = ''; let length = 0;
      for await (const chunk of r.body) { length += chunk.length; if (length > 512000) throw new Error('ROBOTS_TOO_LARGE'); text += Buffer.from(chunk).toString('utf8'); }
      if (/<!doctype html|<html[\s>]/i.test(text)) value = { allowed: false, reason: 'Вместо robots.txt получена HTML-страница; правила не подтверждены.' };
      else {
        const robots = robotsParser(robotsUrl, text); const delay = Math.max(2000, (robots.getCrawlDelay('IgorClientFinder') || 0) * 1000);
        value = delay > 30000 ? { allowed: false, reason: 'Crawl-delay больше 30 секунд; сайт оставлен для ручной проверки.' } : { allowed: true, robots, delay };
      }
    }
    policies.set(origin, value); return value;
  }
  return async function audit(row, candidate, { outputDir, slug, signal } = {}) {
    const result = { candidate, status: 'unverified', checkedAt: new Date(clock()).toISOString(), pages: [], issues: [], screenshots: [], matched: [], blockedRequests: 0 };
    let context; let routeReason = ''; let stage = 'address';
    try {
      const initial = await guard(candidate.url);
      stage = 'robots';
      const rule = await policy(initial.href);
      if (!rule.allowed || rule.robots.isAllowed(initial.href, 'IgorClientFinder') === false)
        return { ...result, status: 'access_limited', reason: rule.reason || 'robots.txt запрещает проверку.' };
      context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', acceptDownloads: false,
        userAgent: 'Mozilla/5.0 (compatible; IgorClientFinder/0.2; read-only website audit)', ignoreHTTPSErrors: false });
      await context.routeWebSocket('**/*', ws => ws.close());
      const vetted = new Set(); let requests = 0;
      await context.route('**/*', async route => {
        const request = route.request();
        try {
          if (signal?.aborted || ++requests > 300 || !['GET', 'HEAD'].includes(request.method()) || ['media', 'eventsource'].includes(request.resourceType()))
            throw new Error('READ_ONLY_LIMIT');
          const url = new URL(request.url());
          if (!vetted.has(url.origin)) { await guard(url.href); vetted.add(url.origin); }
          if (request.isNavigationRequest()) {
            if (limited.has(url.origin)) throw new Error('SERVER_LIMIT');
            const p = await policy(url.href);
            if (!p.allowed || p.robots.isAllowed(url.href, 'IgorClientFinder') === false) throw new Error('ROBOTS_DENIED');
            const wait = Math.max(0, p.delay - (clock() - (lastVisit.get(url.origin) || 0)));
            if (wait) await pause(wait);
            lastVisit.set(url.origin, clock());
          }
          await route.continue();
        } catch (error) {
          result.blockedRequests++;
          if (request.isNavigationRequest()) routeReason = error.message;
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage(); const brokenImages = new Set();
      page.on('response', response => {
        if ([401, 403, 429].includes(response.status()) && response.request().isNavigationRequest()) limited.add(new URL(response.url()).origin);
        if (response.status() === 404 && response.request().resourceType() === 'image') brokenImages.add(response.url());
      });
      async function visit(url) {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(800);
        const status = response?.status() || 0;
        let text = (await page.locator('body').innerText({ timeout: 4000 })).slice(0, 200000);
        const links = await page.locator('a[href]').evaluateAll(links => links.slice(0, 1000).map(a => a.href));
        const contacts = links.map(linkContact).filter(Boolean);
        text += '\n' + contacts.filter(c => ['phone', 'email'].includes(c.channel)).map(c => c.value).join('\n');
        const record = { url: page.url(), http: status, title: await page.title(), textExcerpt: text.slice(0, 2000), contacts, signals: siteEvidence(row, text) };
        result.pages.push(record);
        if ([401, 403, 429].includes(status) || (text.length < 3000 && /подтвердите.{0,30}(человек|робот)|checking your browser|access denied|verify you are human/i.test(text)))
          throw new Error('ACCESS_LIMITED');
        return { text, status };
      }
      stage = 'homepage';
      const home = await visit(initial.href); const homeUrl = page.url();
      if (isDirectory(homeUrl)) return { ...result, finalUrl: homeUrl, status: 'unverified', reason: 'Адрес перенаправляет в соцсеть или каталог; самостоятельный сайт не подтверждён.' };
      const contact = await page.locator('a[href]').evaluateAll(links => links.map(a => ({ url: a.href, text: a.textContent || '' }))
        .find(a => /контакт|contacts?/i.test(a.text) && /^https?:/.test(a.url) && new URL(a.url).origin === location.origin && new URL(a.url).pathname !== location.pathname));
      let combined = home.text;
      if (contact && !/logout|delete|remove|unsubscribe|submit|send|add-to-cart/i.test(contact.url)) {
        try {
          const checked = await visit(contact.url); combined += '\n' + checked.text;
          if (checked.status === 404) result.issues.push({ code: 'contact_404', label: 'Ссылка «Контакты» вернула HTTP 404', url: page.url(), weight: 4 });
        } catch { result.contactCheck = 'Не удалось проверить страницу контактов; это не доказательство неисправности сайта.'; }
      }
      const evidence = siteEvidence(row, combined);
      result.evidence = evidence; result.matched = evidence.matched;
      result.status = evidence.confirmed ? 'confirmed' : 'unverified';
      if (!evidence.confirmed) result.reason = `Принадлежность сайта не подтверждена. Совпали: ${evidence.matched.join(', ') || 'нет достаточных данных'}. Нужны дополнительные совпадения названия, контакта или адреса.`;
      result.finalUrl = homeUrl;
      if (evidence.confirmed && home.status === 404) result.issues.push({ code: 'home_404', label: 'Проверенный адрес вернул HTTP 404', url: homeUrl, weight: 4 });
      // Reload the home page only when visiting contacts changed it.
      if (page.url() !== homeUrl) await visit(homeUrl);
      stage = 'screenshots-and-mobile';
      await page.screenshot({ path: join(outputDir, `${slug}-desktop.png`), fullPage: false, timeout: 10000 });
      result.screenshots.push(`${slug}-desktop.png`);
      await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(500);
      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth, layoutWidth: document.documentElement.clientWidth,
        innerWidth, hasViewport: /width\s*=\s*device-width/i.test(document.querySelector('meta[name="viewport"]')?.content || ''),
      }));
      result.mobile = metrics;
      if (!metrics.hasViewport) result.issues.push({ code: 'viewport', label: 'Нет настройки viewport width=device-width для телефона', url: homeUrl, weight: 2 });
      if (metrics.scrollWidth > metrics.layoutWidth + 8) result.issues.push({ code: 'overflow', label: `Переполнение на телефоне: ${metrics.scrollWidth}px при ширине области ${metrics.layoutWidth}px`, url: homeUrl, weight: 3 });
      const renderedImages = new Set(await page.locator('img').evaluateAll(images => images.map(img => img.currentSrc || img.src)));
      for (const url of [...brokenImages].filter(url => renderedImages.has(url)).slice(0, 5)) result.issues.push({ code: 'image_404', label: 'Изображение на странице вернуло HTTP 404', url, weight: 2 });
      await page.screenshot({ path: join(outputDir, `${slug}-mobile.png`), fullPage: false, timeout: 10000 });
      result.screenshots.push(`${slug}-mobile.png`);
      return result;
    } catch (error) {
      const errorCode = (error.message + ' ' + routeReason).match(/UNSAFE_URL|UNSAFE_HOST|NON_PUBLIC_ADDRESS|ENOTFOUND|EAI_AGAIN|ERR_[A-Z_]+|ACCESS_LIMITED|ROBOTS_DENIED|SERVER_LIMIT/)?.[0] ||
        (/timeout|timed out/i.test(error.message) ? 'TIMEOUT' : 'BROWSER_OR_NETWORK');
      return { ...result, status: /ACCESS_LIMITED|ROBOTS|SERVER_LIMIT/.test(error.message + routeReason) ? 'access_limited' : 'unavailable',
        reason: `Проверка ограничена или страница не загрузилась (этап: ${stage}, код: ${errorCode}). Это не доказывает, что сайт неисправен у клиентов.`, errorCode, failureStage: stage };
    } finally { await context?.close(); }
  };
}
