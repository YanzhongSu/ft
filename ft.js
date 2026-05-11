#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_DEBUG_URL = 'http://127.0.0.1:9222';
const FT_HOME = 'https://www.ft.com/';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`Usage:
  node ft.js headlines [--limit 10] [--include-opinion] [--format json|text] [--cache-dir data] [--transport extension|cdp]
  node ft.js article (--url URL | --rank N) [--format json|text] [--cache-dir data] [--transport extension|cdp]
  node ft.js topic --query QUERY [--limit 30] [--article-limit 5] [--include-opinion] [--format json|text] [--cache-dir data] [--transport extension|cdp]

Examples:
  node ft.js headlines --limit 10
  node ft.js headlines --limit 10 --include-opinion
  node ft.js article --rank 5
  node ft.js article --url https://www.ft.com/content/f66186e7-8e14-466d-b4de-114ee70c3e62 --format text
  node ft.js topic --query commodities --article-limit 5 --format text`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function contentIdFromUrl(url) {
  return String(url).match(/\/content\/([^/?#]+)/)?.[1] || encodeURIComponent(url).slice(0, 80);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function createJsonRpcRequest(id, method, params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

async function findMcpCli() {
  const candidates = [
    path.join(__dirname, 'node_modules', '@playwright', 'mcp', 'cli.js'),
    path.join(process.cwd(), 'node_modules', '@playwright', 'mcp', 'cli.js')
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, 'playwright-mcp');
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try next PATH entry.
    }
  }
  throw new Error('Could not find @playwright/mcp. Run npm install in this repo, install playwright-mcp on PATH, or use --transport cdp.');
}

class McpExtensionClient {
  constructor(mcpCli) {
    this.mcpCli = mcpCli;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
  }

  async connect() {
    const command = this.mcpCli.endsWith('.js') ? 'node' : this.mcpCli;
    const args = this.mcpCli.endsWith('.js') ? [this.mcpCli, '--extension'] : ['--extension'];
    this.proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });
    this.proc.stdout.on('data', chunk => this.onStdout(chunk));
    this.proc.stderr.on('data', chunk => {
      this.stderr = (this.stderr + chunk.toString()).slice(-12000);
    });
    this.proc.on('close', code => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`Playwright MCP exited before response${code == null ? '' : ` (code ${code})`}`));
      }
      this.pending.clear();
    });

    const init = await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ft-tools', version: '0.1.0' }
    }, 30000);
    if (init.error) {
      throw new Error(`MCP initialize failed: ${init.error.message || JSON.stringify(init.error)}\n${this.stderr}`.trim());
    }
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  onStdout(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const { resolve, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    }
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    this.proc.stdin.write(createJsonRpcRequest(id, method, params));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timed out waiting for MCP ${method}. ${this.stderr}`.trim()));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async tool(name, args = {}) {
    const resp = await this.send('tools/call', { name, arguments: args }, 60000);
    if (resp.error) throw new Error(`MCP ${name} failed: ${resp.error.message || JSON.stringify(resp.error)}`);
    return this.parseToolResult(resp.result);
  }

  parseToolResult(result) {
    const text = result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
    let clean = text;
    const codeMarker = clean.indexOf('### Ran Playwright code');
    if (codeMarker !== -1) clean = clean.slice(0, codeMarker).trim();
    const resultMarker = clean.indexOf('### Result\n');
    if (resultMarker !== -1) clean = clean.slice(resultMarker + '### Result\n'.length).trim();
    if (clean.startsWith('- [Evaluation result]')) return clean;
    try {
      return JSON.parse(clean);
    } catch {
      return clean;
    }
  }

  async navigate(url) {
    await this.tool('browser_navigate', { url });
  }

  async evaluate(expression) {
    return this.tool('browser_evaluate', { function: `() => (${expression})` });
  }

  async close() {
    if (!this.proc || this.proc.killed) return;
    this.proc.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 1500);
      this.proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (!this.proc.killed) {
      try { this.proc.kill('SIGKILL'); } catch {}
    }
  }
}

function isPortReachable(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise(resolve => {
    const sock = net.createConnection({ port, host });
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

async function discoverChromeWsEndpoint(debugUrl) {
  if (process.env.FT_CDP_ENDPOINT) return process.env.FT_CDP_ENDPOINT;
  if (process.env.OPENCLI_CDP_ENDPOINT) return process.env.OPENCLI_CDP_ENDPOINT;

  const candidates = [];
  if (process.env.CHROME_USER_DATA_DIR) {
    candidates.push(path.join(process.env.CHROME_USER_DATA_DIR, 'DevToolsActivePort'));
  }
  if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'DevToolsActivePort'));
    candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'Microsoft Edge', 'DevToolsActivePort'));
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(path.join(localAppData, 'Google', 'Chrome', 'User Data', 'DevToolsActivePort'));
    candidates.push(path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'DevToolsActivePort'));
  } else {
    candidates.push(path.join(os.homedir(), '.config', 'google-chrome', 'DevToolsActivePort'));
    candidates.push(path.join(os.homedir(), '.config', 'chromium', 'DevToolsActivePort'));
    candidates.push(path.join(os.homedir(), '.config', 'microsoft-edge', 'DevToolsActivePort'));
  }

  for (const filePath of candidates) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const [portLine, browserPath] = content.trim().split('\n');
      const port = Number(portLine);
      if (port > 0 && browserPath?.startsWith('/devtools/browser/') && await isPortReachable(port)) {
        return `ws://127.0.0.1:${port}${browserPath}`;
      }
    } catch {
      // Try the next known Chrome profile path.
    }
  }

  try {
    const versionRes = await fetch(`${debugUrl.replace(/\/$/, '')}/json/version`);
    if (versionRes.ok) {
      const version = await versionRes.json();
      if (version.webSocketDebuggerUrl) return version.webSocketDebuggerUrl;
    }
  } catch {
    // Fall through to the explicit error below.
  }

  throw new Error(`Could not discover Chrome CDP endpoint. Set FT_CDP_ENDPOINT=ws://... or enable Chrome remote debugging.`);
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Chrome CDP')), 10000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', event => this.onMessage(event));
  }

  onMessage(event) {
    const msg = JSON.parse(event.data);
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message || 'CDP error'} ${msg.error.data || ''}`.trim()));
      else resolve(msg.result || {});
      return;
    }
    if (msg.sessionId) {
      const listeners = this.sessions.get(msg.sessionId) || [];
      for (const listener of listeners) listener(msg);
    }
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}`));
        }
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  onSession(sessionId, listener) {
    const listeners = this.sessions.get(sessionId) || [];
    listeners.push(listener);
    this.sessions.set(sessionId, listeners);
  }

  close() {
    this.ws?.close();
  }
}

async function connectToChrome(debugUrl) {
  const wsEndpoint = await discoverChromeWsEndpoint(debugUrl);
  const cdp = new CdpClient(wsEndpoint);
  await cdp.connect();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  return { cdp, sessionId, targetId };
}

async function connectBrowser(args) {
  const transport = args.transport || 'extension';
  if (transport === 'cdp') {
    const debugUrl = args['debug-url'] || DEFAULT_DEBUG_URL;
    const cdpSession = await connectToChrome(debugUrl);
    return {
      async navigate(url) {
        await navigate(cdpSession.cdp, cdpSession.sessionId, url);
      },
      async evaluate(expression) {
        return evaluate(cdpSession.cdp, cdpSession.sessionId, expression);
      },
      async close() {
        await cdpSession.cdp.send('Target.closeTarget', { targetId: cdpSession.targetId }).catch(() => {});
        cdpSession.cdp.close();
      }
    };
  }
  if (transport !== 'extension') {
    throw new Error(`Unknown transport "${transport}". Use extension or cdp.`);
  }
  const mcpCli = await findMcpCli();
  const mcp = new McpExtensionClient(mcpCli);
  await mcp.connect();
  return mcp;
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function navigate(cdp, sessionId, url) {
  await cdp.send('Page.navigate', { url }, sessionId);
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const ready = await evaluate(cdp, sessionId, 'document.readyState', { timeoutOk: true });
      if (ready === 'complete' || ready === 'interactive') break;
    } catch {
      // Navigation may still be swapping documents.
    }
  }
  await sleep(1500);
}

async function evaluate(cdp, sessionId, expression, options = {}) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 30000
  }, sessionId);
  if (result.exceptionDetails && !options.timeoutOk) {
    throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
  }
  return result.result?.value;
}

const headlineExtractor = String.raw`
(() => {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const main = document.querySelector('main') || document.body;
  const anchors = [...main.querySelectorAll('a[href]')].map((a, domIndex) => {
    const href = new URL(a.getAttribute('href'), location.href).href.replace(/\?.*$/, '');
    const rect = a.getBoundingClientRect();
    const text = clean(a.innerText || a.textContent);
    return {
      domIndex,
      text,
      href,
      top: Math.round(rect.top + scrollY),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      visible: rect.width > 0 && rect.height > 0
    };
  }).filter(a => a.text && /^https:\/\/www\.ft\.com\/content\/[0-9a-f-]+/i.test(a.href));

  const groups = new Map();
  for (const a of anchors) {
    const isOpinionText = /^opinion content\.?/i.test(a.text);
    if (!groups.has(a.href)) {
      groups.set(a.href, {
        url: a.href,
        title: '',
        standfirst: '',
        allText: [],
        isOpinion: false,
        firstVisibleTop: Number.POSITIVE_INFINITY,
        firstVisibleLeft: Number.POSITIVE_INFINITY,
        firstDomIndex: a.domIndex
      });
    }
    const group = groups.get(a.href);
    if (isOpinionText) group.isOpinion = true;
    if (!group.allText.includes(a.text)) group.allText.push(a.text);
    if (a.visible && a.top > 0) {
      group.firstVisibleTop = Math.min(group.firstVisibleTop, a.top);
      group.firstVisibleLeft = Math.min(group.firstVisibleLeft, a.left);
      if (!group.title) group.title = a.text;
    }
    group.firstDomIndex = Math.min(group.firstDomIndex, a.domIndex);
  }

  const stories = [...groups.values()].map(group => {
    const nonOpinion = group.allText.filter(t => !/^opinion content\.?/i.test(t));
    const candidates = nonOpinion.length ? nonOpinion : group.allText;
    const title = group.title || candidates[0] || group.allText[0] || '';
    const standfirst = candidates.find(t => t !== title && t.length > 30) || '';
    return {
      url: group.url,
      title: clean(title.replace(/^opinion content\.?\s*/i, '')),
      standfirst,
      isOpinion: group.isOpinion,
      texts: group.allText,
      top: Number.isFinite(group.firstVisibleTop) ? group.firstVisibleTop : 999999,
      left: Number.isFinite(group.firstVisibleLeft) ? group.firstVisibleLeft : 999999,
      domIndex: group.firstDomIndex
    };
  }).filter(s => s.title && !/^Print this page$/i.test(s.title));

  stories.sort((a, b) => (a.top - b.top) || (a.left - b.left) || (a.domIndex - b.domIndex));

  return {
    source: location.href,
    fetchedAt: new Date().toISOString(),
    title: document.title,
    stories
  };
})()
`;

const articleExtractor = String.raw`
(() => {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const meta = sel => clean(document.querySelector(sel)?.getAttribute('content') || '');
  const title = clean(document.querySelector('h1')?.innerText) || meta('meta[property="og:title"]') || document.title;
  const standfirst = clean(document.querySelector('[data-testid="article-standfirst"], .article__standfirst, [data-trackable="standfirst"]')?.innerText)
    || meta('meta[name="description"]')
    || meta('meta[property="og:description"]');
  const byline = clean(document.querySelector('[data-testid="article-byline"], .article-info__byline, [class*="byline"]')?.innerText);
  const published = document.querySelector('time')?.getAttribute('datetime') || meta('meta[property="article:published_time"]');
  const updated = meta('meta[property="article:modified_time"]');
  const section = meta('meta[property="article:section"]');
  const paragraphSelectors = [
    'article p',
    '[data-trackable="article-body"] p',
    '.article__content-body p',
    '[class*="article"] p'
  ];
  const stopPatterns = [
    /^Exclusively for subscribers/i,
    /^See key events linked to this article/i,
    /^Market graph unavailable/i,
    /^Campus news, management research/i,
    /^Exploring the effects of AI investment/i
  ];
  const rawParagraphs = [...document.querySelectorAll(paragraphSelectors.join(','))]
    .map(p => clean(p.innerText || p.textContent))
    .filter(Boolean)
    .filter(t => t !== 'Recommended')
    .filter(t => !/^Published|^Updated|^Roula Khalaf|^Explore more offers|^Your delivery channels/i.test(t));
  const unique = [];
  for (const p of rawParagraphs) {
    if (stopPatterns.some(pattern => pattern.test(p))) break;
    if (!unique.includes(p)) unique.push(p);
  }
  return {
    url: location.href.replace(/\?.*$/, ''),
    fetchedAt: new Date().toISOString(),
    title,
    standfirst,
    byline,
    published,
    updated,
    section,
    paragraphCount: unique.length,
    paragraphs: unique
  };
})()
`;

function headlineOutputFromExtracted(extracted, args = {}) {
  const limit = Number(args.limit || 10);
  const includeOpinion = Boolean(args['include-opinion']);
  const sourceStories = includeOpinion ? extracted.stories : extracted.stories.filter(story => !story.isOpinion);
  const stories = sourceStories.slice(0, limit).map((story, index) => ({
      rank: index + 1,
      title: story.title,
      standfirst: story.standfirst,
      url: story.url,
      isOpinion: story.isOpinion,
      texts: story.texts || [],
      top: story.top,
      left: story.left
    }));
  return {
    source: extracted.source,
    fetchedAt: extracted.fetchedAt,
    selectionBasis: `Distinct FT homepage /content story links sorted by visible page position, with duplicate link text folded into standfirst candidates.${includeOpinion ? ' Opinion links included.' : ' Opinion links excluded by default; pass --include-opinion to include them.'}`,
    count: stories.length,
    stories
  };
}

async function writeHeadlinesCache(cacheDir, output) {
  await fs.writeFile(path.join(cacheDir, 'headlines_latest.json'), JSON.stringify(output, null, 2));
  await fs.writeFile(path.join(cacheDir, `headlines_${todayStamp()}.json`), JSON.stringify(output, null, 2));
}

async function fetchHeadlines(browser, args) {
  await browser.navigate(FT_HOME);
  const extracted = await browser.evaluate(headlineExtractor);
  return headlineOutputFromExtracted(extracted, args);
}

async function fetchArticle(browser, cacheDir, url) {
  await browser.navigate(url);
  const output = await browser.evaluate(articleExtractor);
  const articlePath = path.join(cacheDir, 'articles', `${contentIdFromUrl(output.url)}.json`);
  await fs.writeFile(articlePath, JSON.stringify(output, null, 2));
  return output;
}

async function runHeadlines(args) {
  const format = args.format || 'json';
  const cacheDir = path.resolve(args['cache-dir'] || 'data');
  await ensureDir(cacheDir);

  const browser = await connectBrowser(args);
  try {
    const output = await fetchHeadlines(browser, args);
    await writeHeadlinesCache(cacheDir, output);
    printHeadlines(output, format);
  } finally {
    await browser.close();
  }
}

async function findUrlFromRank(cacheDir, rank) {
  const latestPath = path.join(cacheDir, 'headlines_latest.json');
  const raw = await fs.readFile(latestPath, 'utf8');
  const latest = JSON.parse(raw);
  const story = latest.stories.find(s => s.rank === Number(rank));
  if (!story) throw new Error(`No rank ${rank} in ${latestPath}. Run headlines first.`);
  return story.url;
}

async function runArticle(args) {
  const format = args.format || 'json';
  const cacheDir = path.resolve(args['cache-dir'] || 'data');
  await ensureDir(path.join(cacheDir, 'articles'));
  const url = args.url || (args.rank ? await findUrlFromRank(cacheDir, args.rank) : undefined);
  if (!url) throw new Error('article requires --url URL or --rank N');

  const browser = await connectBrowser(args);
  try {
    const output = await fetchArticle(browser, cacheDir, url);
    printArticle(output, format);
  } finally {
    await browser.close();
  }
}

function topicTerms(query) {
  const normalized = String(query || '').toLowerCase().trim();
  const aliases = {
    commodities: [
      'commodity', 'commodities', 'oil', 'crude', 'brent', 'wti', 'gas', 'lng',
      'fuel', 'gasoline', 'diesel', 'jet fuel', 'coal', 'power', 'electricity',
      'metals', 'copper', 'aluminium', 'iron ore', 'steel', 'gold', 'silver',
      'agriculture', 'wheat', 'corn', 'soyabean', 'sugar', 'coffee', 'shipping',
      'freight', 'trading desk', 'opec', 'aramco', 'hormuz'
    ],
    energy: [
      'energy', 'oil', 'crude', 'brent', 'wti', 'gas', 'lng', 'fuel', 'gasoline',
      'diesel', 'jet fuel', 'coal', 'power', 'electricity', 'opec', 'aramco',
      'hormuz'
    ],
    markets: [
      'market', 'markets', 'stocks', 'shares', 'bond', 'bonds', 'yield', 'yields',
      'currency', 'currencies', 'dollar', 'euro', 'sterling', 'rate', 'rates',
      'trading', 'volatility'
    ]
  };
  if (aliases[normalized]) return aliases[normalized];
  return normalized.split(/[,\s]+/).map(term => term.trim()).filter(Boolean);
}

function storyMatchesTopic(story, terms) {
  const haystack = [
    story.title,
    story.standfirst,
    ...(story.texts || [])
  ].join(' ').toLowerCase();
  return terms.some(term => haystack.includes(term.toLowerCase()));
}

async function runTopic(args) {
  const query = args.query || args.topic;
  if (!query) throw new Error('topic requires --query QUERY');
  const format = args.format || 'json';
  const cacheDir = path.resolve(args['cache-dir'] || 'data');
  await ensureDir(cacheDir);
  await ensureDir(path.join(cacheDir, 'articles'));

  const articleLimit = Number(args['article-limit'] || 5);
  const headlineLimit = Number(args.limit || 30);
  const terms = topicTerms(query);
  const browser = await connectBrowser(args);
  try {
    const headlines = await fetchHeadlines(browser, { ...args, limit: headlineLimit });
    await writeHeadlinesCache(cacheDir, headlines);
    const matches = headlines.stories.filter(story => storyMatchesTopic(story, terms));
    const articles = [];
    for (const story of matches.slice(0, articleLimit)) {
      try {
        articles.push({ story, article: await fetchArticle(browser, cacheDir, story.url) });
      } catch (err) {
        articles.push({ story, error: err.message });
      }
    }
    const output = {
      source: headlines.source,
      fetchedAt: new Date().toISOString(),
      query,
      terms,
      count: matches.length,
      articleCount: articles.filter(item => item.article).length,
      matches,
      articles
    };
    printTopic(output, format);
  } finally {
    await browser.close();
  }
}

function printHeadlines(output, format) {
  if (format === 'text') {
    console.log(`FT headlines (${output.count}) fetched ${output.fetchedAt}`);
    for (const story of output.stories) {
      console.log(`${story.rank}. ${story.title}`);
      if (story.standfirst) console.log(`   ${story.standfirst}`);
      console.log(`   ${story.url}`);
    }
    return;
  }
  console.log(JSON.stringify(output, null, 2));
}

function printArticle(output, format) {
  if (format === 'text') {
    console.log(output.title);
    if (output.standfirst) console.log(`\n${output.standfirst}`);
    if (output.byline) console.log(`\n${output.byline}`);
    if (output.published) console.log(output.published);
    console.log(`\n${output.url}\n`);
    console.log(output.paragraphs.join('\n\n'));
    return;
  }
  console.log(JSON.stringify(output, null, 2));
}

function printTopic(output, format) {
  if (format === 'text') {
    console.log(`FT topic "${output.query}" (${output.count} matches, ${output.articleCount} articles) fetched ${output.fetchedAt}`);
    for (const story of output.matches) {
      console.log(`${story.rank}. ${story.title}`);
      if (story.standfirst) console.log(`   ${story.standfirst}`);
      console.log(`   ${story.url}`);
      const item = output.articles.find(candidate => candidate.story.url === story.url);
      if (item?.article) {
        const article = item.article;
        if (article.published) console.log(`   Published: ${article.published}`);
        const summaryParagraphs = article.paragraphs
          .filter(p => p && !/^Get ahead with daily markets updates\.$/i.test(p))
          .slice(0, 4);
        for (const paragraph of summaryParagraphs) console.log(`   ${paragraph}`);
      } else if (item?.error) {
        console.log(`   Article fetch failed: ${item.error}`);
      }
    }
    return;
  }
  console.log(JSON.stringify(output, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || args.help || args.h) {
    usage();
    return;
  }
  if (command === 'headlines') return runHeadlines(args);
  if (command === 'article') return runArticle(args);
  if (command === 'topic') return runTopic(args);
  throw new Error(`Unknown command: ${command}`);
}

main().catch(err => {
  console.error(`ft-tools: ${err.message}`);
  process.exit(1);
});
