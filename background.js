'use strict';

// ============================================================
//  Filter lists (Adblock Plus / uBlock syntax)
// ============================================================
const LISTS = [
  { id: 'easylist',    name: 'EasyList',    url: 'https://easylist.to/easylist/easylist.txt' },
  { id: 'easyprivacy', name: 'EasyPrivacy', url: 'https://easylist.to/easylist/easyprivacy.txt' },
  // Domain blocklist (ads, trackers, telemetry, malware) — ~200k hosts, packed into few DNR rules
  { id: 'hagezi',      name: 'HaGeZi Pro',  url: 'https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/adblock/pro.txt' }
];

// "||example.com^" with no options = block the whole host. These are packed into
// requestDomains arrays instead of one rule each, so they don't eat the dynamic-rule cap.
const PLAIN_DOMAIN = /^\|\|([a-z0-9][a-z0-9.-]*\.[a-z0-9-]+)\^$/i;
const DOMAINS_PER_RULE = 5000;

const PAUSE_RULE_ID = 1;          // allowAllRequests rule used when the blocker is OFF
const FIRST_LIST_RULE_ID = 1000;  // dynamic rules converted from the lists start here
const UPDATE_ALARM = 'update-lists';
const UPDATE_PERIOD_MIN = 24 * 60;
const CSS_CHUNK = 250;            // selectors per CSS rule (one bad selector only kills its chunk)

// ABP option -> declarativeNetRequest resourceType
const TYPE_MAP = {
  script: 'script', image: 'image', stylesheet: 'stylesheet', css: 'stylesheet',
  object: 'object', xmlhttprequest: 'xmlhttprequest', xhr: 'xmlhttprequest',
  subdocument: 'sub_frame', frame: 'sub_frame', ping: 'ping', media: 'media',
  font: 'font', websocket: 'websocket', other: 'other'
};
const ALL_TYPES = [...new Set(Object.values(TYPE_MAP))];

// Extended / procedural cosmetic syntax the CSS engine can't express
const UNSUPPORTED_SELECTOR = /:(-abp-|has-text|xpath|matches-|upward|remove|style|min-text|watch-attr|others)|^\+js\(/;

// ============================================================
//  Network filter -> DNR rule
// ============================================================
function parseDomains(value) {
  const include = [], exclude = [];
  for (let d of value.split('|')) {
    const neg = d.startsWith('~');
    d = (neg ? d.slice(1) : d).trim().toLowerCase();
    if (!d || d.includes('*') || !/^[a-z0-9.-]+$/.test(d)) return null; // wildcards / non-punycode
    (neg ? exclude : include).push(d);
  }
  return { include, exclude };
}

function parseNetwork(line) {
  let allow = false;
  if (line.startsWith('@@')) { allow = true; line = line.slice(2); }

  // Regex filters are skipped: DNR caps regex rules at 1000 and RE2 rejects many of them
  if (line.startsWith('/') && (line.endsWith('/') || line.includes('/$'))) return null;

  let pattern = line, opts = '';
  const dollar = line.lastIndexOf('$');
  if (dollar !== -1) { pattern = line.slice(0, dollar); opts = line.slice(dollar + 1); }

  const condition = { isUrlFilterCaseSensitive: false };
  const types = [], excluded = [];
  let priority = allow ? 2 : 1;
  let docAllow = false;

  if (opts) {
    for (const raw of opts.split(',')) {
      const neg = raw.startsWith('~');
      const opt = (neg ? raw.slice(1) : raw).trim();
      const eq = opt.indexOf('=');
      const key = eq === -1 ? opt : opt.slice(0, eq);
      const val = eq === -1 ? '' : opt.slice(eq + 1);

      if (TYPE_MAP[key]) (neg ? excluded : types).push(TYPE_MAP[key]);
      else if (key === 'third-party' || key === '3p') condition.domainType = neg ? 'firstParty' : 'thirdParty';
      else if (key === 'first-party' || key === '1p') condition.domainType = neg ? 'thirdParty' : 'firstParty';
      else if (key === 'domain' && val) {
        const d = parseDomains(val);
        if (!d) return null;
        if (d.include.length) condition.initiatorDomains = d.include;
        if (d.exclude.length) condition.excludedInitiatorDomains = d.exclude;
      }
      else if (key === 'match-case') condition.isUrlFilterCaseSensitive = true;
      else if (key === 'important') priority += 10;
      else if (key === 'document' && allow && !neg) docAllow = true;
      else if (key === 'all' && !neg) types.push(...ALL_TYPES);
      else return null; // popup, csp, redirect, removeparam, elemhide, … — not expressible
    }
  }

  pattern = pattern.trim();
  if (/[^\x20-\x7e]/.test(pattern)) return null;
  while (pattern.startsWith('**')) pattern = pattern.slice(1);
  if (pattern === '*') pattern = '';
  if (pattern) condition.urlFilter = pattern;
  else if (!condition.initiatorDomains) return null; // would match everything
  if (pattern && pattern.replace(/[|^*]/g, '').length < 4 && !condition.initiatorDomains) return null;

  let action;
  if (docAllow) {
    action = { type: 'allowAllRequests' };
    condition.resourceTypes = ['main_frame', 'sub_frame'];
  } else {
    action = { type: allow ? 'allow' : 'block' };
    const finalTypes = types.filter(t => !excluded.includes(t));
    if (types.length) {
      if (!finalTypes.length) return null;
      condition.resourceTypes = [...new Set(finalTypes)];
    } else if (excluded.length) {
      condition.excludedResourceTypes = [...new Set(excluded)];
    }
  }

  // Score decides what survives the dynamic-rule cap.
  // Allow rules always win (they prevent breakage); script/iframe blocks on ad servers come next.
  let score = 0;
  if (allow) score = 1000;
  else {
    const rt = condition.resourceTypes;
    if (!rt || rt.includes('script') || rt.includes('sub_frame')) score += 50;
    if (rt && (rt.includes('xmlhttprequest') || rt.includes('image'))) score += 10;
    if (pattern.startsWith('||')) score += 20;
    if (condition.domainType === 'thirdParty') score += 10;
    if (condition.initiatorDomains) score -= 25; // site-specific: narrower reach
    score += priority;
  }

  return { rule: { priority, action, condition }, score };
}

// ============================================================
//  Parse a whole list
// ============================================================
function parseList(text, out) {
  let network = 0, cosmetic = 0;
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('!') || line.startsWith('[')) continue;

    // Cosmetic: "##", "#@#". Extended (#?#, #$#, #%#, #@$#…) are skipped.
    const hashIdx = line.indexOf('#');
    if (hashIdx !== -1 && /#@?#/.test(line)) {
      if (/#@?[?$%]#/.test(line)) continue;
      const m = line.match(/^([^#]*)(#@?#)(.+)$/);
      if (!m) continue;
      const [, domainStr, sep, selector] = m;
      if (UNSUPPORTED_SELECTOR.test(selector)) continue;
      const isException = sep === '#@#';
      if (!domainStr) {
        if (isException) out.genericExceptions.add(selector);
        else out.generic.add(selector);
      } else {
        const target = isException ? out.exceptions : out.specific;
        for (let d of domainStr.split(',')) {
          d = d.trim().toLowerCase();
          if (!d || d.startsWith('~') || d.includes('*')) continue;
          (target[d] ||= []).push(selector);
        }
      }
      cosmetic++;
      continue;
    }

    const plain = line.match(PLAIN_DOMAIN);
    if (plain) { out.domains.add(plain[1].toLowerCase()); network++; continue; }

    const parsed = parseNetwork(line);
    if (parsed) { out.network.push(parsed); network++; }
  }
  return { network, cosmetic };
}

// ============================================================
//  Install rules into declarativeNetRequest (native matching, no JS per request)
// ============================================================
// Drop hosts already covered by a listed parent (requestDomains matches subdomains too).
function collapseDomains(domains) {
  const kept = [];
  for (const d of domains) {
    let covered = false;
    for (let i = d.indexOf('.'); i !== -1; i = d.indexOf('.', i + 1)) {
      if (domains.has(d.slice(i + 1))) { covered = true; break; }
    }
    if (!covered) kept.push(d);
  }
  return kept.sort();
}

async function installNetworkRules(parsed, domainSet) {
  const domains = collapseDomains(domainSet);
  const packed = [];
  for (let i = 0; i < domains.length; i += DOMAINS_PER_RULE) {
    packed.push({
      priority: 1,
      action: { type: 'block' },
      condition: { requestDomains: domains.slice(i, i + DOMAINS_PER_RULE), resourceTypes: ALL_TYPES }
    });
  }

  const seen = new Set();
  const unique = [];
  for (const p of parsed) {
    const key = JSON.stringify(p.rule);
    if (!seen.has(key)) { seen.add(key); unique.push(p); }
  }
  unique.sort((a, b) => b.score - a.score);

  const max = (chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES || 5000) - 10 - packed.length;
  const rules = [...packed, ...unique.slice(0, max).map(p => p.rule)]
    .map((r, i) => ({ id: FIRST_LIST_RULE_ID + i, ...r }));

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.filter(r => r.id >= FIRST_LIST_RULE_ID).map(r => r.id)
  });

  // Add in batches; if Chrome rejects a batch (one invalid rule fails the whole call), bisect it.
  let added = 0;
  async function add(batch) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules: batch });
      added += batch.length;
    } catch (e) {
      if (batch.length === 1) return;
      const mid = batch.length >> 1;
      await add(batch.slice(0, mid));
      await add(batch.slice(mid));
    }
  }
  for (let i = 0; i < rules.length; i += 2000) await add(rules.slice(i, i + 2000));
  return { added: added - packed.length, total: unique.length, domains: domains.length };
}

// ============================================================
//  Update pipeline
// ============================================================
let updating = null;

function updateLists() {
  if (updating) return updating;
  updating = (async () => {
    const results = await Promise.allSettled(LISTS.map(async l => {
      const res = await fetch(l.url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${l.name}: HTTP ${res.status}`);
      return res.text();
    }));
    if (results.every(r => r.status === 'rejected')) throw new Error('All filter lists failed to download');

    const out = { network: [], domains: new Set(), generic: new Set(), genericExceptions: new Set(), specific: {}, exceptions: {} };
    const perList = {};
    results.forEach((r, i) => {
      perList[LISTS[i].id] = r.status === 'fulfilled'
        ? { ok: true, ...parseList(r.value, out) }
        : { ok: false, error: String(r.reason?.message || r.reason) };
    });

    const net = await installNetworkRules(out.network, out.domains);

    for (const s of out.genericExceptions) out.generic.delete(s);
    const cosmeticData = {
      generic: [...out.generic],
      specific: out.specific,
      exceptions: out.exceptions
    };
    const meta = {
      updatedAt: Date.now(),
      networkRules: net.added,
      networkParsed: net.total,
      blockedDomains: net.domains,
      genericSelectors: cosmeticData.generic.length,
      specificDomains: Object.keys(cosmeticData.specific).length,
      lists: perList
    };
    await chrome.storage.local.set({ cosmeticData, meta });
    cosmetic = null; // reload cache lazily
    return meta;
  })().finally(() => { updating = null; });
  return updating;
}

// ============================================================
//  Cosmetic filtering: inject user-origin CSS on navigation commit
// ============================================================
let cosmetic = null;       // { generic, genericCss, specific, exceptions }
let enabledCache = null;

async function getCosmetic() {
  if (cosmetic) return cosmetic;
  const { cosmeticData } = await chrome.storage.local.get('cosmeticData');
  const data = cosmeticData || { generic: [], specific: {}, exceptions: {} };
  cosmetic = { ...data, genericCss: toCss(data.generic) };
  return cosmetic;
}

function toCss(selectors) {
  let css = '';
  for (let i = 0; i < selectors.length; i += CSS_CHUNK) {
    css += selectors.slice(i, i + CSS_CHUNK).join(',\n') + '{display:none!important}\n';
  }
  return css;
}

function hostChain(host) {
  const parts = host.split('.');
  const chain = [];
  for (let i = 0; i < parts.length - 1; i++) chain.push(parts.slice(i).join('.'));
  return chain;
}

function cssForHost(c, host) {
  const specific = [], excepted = new Set();
  for (const d of hostChain(host)) {
    if (c.specific[d]) specific.push(...c.specific[d]);
    if (c.exceptions[d]) c.exceptions[d].forEach(s => excepted.add(s));
  }
  const generic = excepted.size ? toCss(c.generic.filter(s => !excepted.has(s))) : c.genericCss;
  return generic + toCss(specific.filter(s => !excepted.has(s)));
}

async function isEnabled() {
  if (enabledCache === null) {
    enabledCache = (await chrome.storage.local.get({ enabled: true })).enabled;
  }
  return enabledCache;
}

chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId, url }) => {
  if (!/^https?:/.test(url) || !(await isEnabled())) return;
  const css = cssForHost(await getCosmetic(), new URL(url).hostname);
  if (!css) return;
  chrome.scripting.insertCSS({ target: { tabId, frameIds: [frameId] }, css, origin: 'USER' })
    .catch(() => {}); // tab closed / restricted page
});

// ============================================================
//  ON / OFF
// ============================================================
// Each step is independent: one rejected call (e.g. a ruleset Chrome refuses) must not
// stop the others — the page scriptlets in particular were silently never registered before.
async function applyEnabled(enabled) {
  enabledCache = enabled;

  try {
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: ['scriptlets'] });
    if (enabled && !registered.length) {
      await chrome.scripting.registerContentScripts([{
        id: 'scriptlets',
        js: ['scriptlets.js'],
        matches: ['<all_urls>'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: true,
        matchOriginAsFallback: true,
        persistAcrossSessions: true
      }]);
    } else if (!enabled && registered.length) {
      await chrome.scripting.unregisterContentScripts({ ids: ['scriptlets'] });
    }
  } catch (e) { console.warn('[AdSkipper] scriptlet registration failed:', e); }

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [PAUSE_RULE_ID],
      addRules: enabled ? [] : [{
        id: PAUSE_RULE_ID,
        priority: 100000,
        action: { type: 'allowAllRequests' },
        condition: { resourceTypes: ['main_frame', 'sub_frame'] }
      }]
    });
  } catch (e) { console.warn('[AdSkipper] pause rule update failed:', e); }

  const { blockConsent, blockStrict } = await chrome.storage.local.get({ blockConsent: true, blockStrict: true });
  const want = { baseline: enabled, trackers: enabled, consent: enabled && blockConsent, strict: enabled && blockStrict };
  for (const [id, on] of Object.entries(want)) {
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets(on ? { enableRulesetIds: [id] } : { disableRulesetIds: [id] });
    } catch (e) { console.warn(`[AdSkipper] ruleset "${id}" failed:`, e); }
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.enabled) applyEnabled(changes.enabled.newValue);
  else if (changes.blockConsent || changes.blockStrict) isEnabled().then(applyEnabled);
});

// ============================================================
//  Stats (single writer → no cross-tab races)
// ============================================================
const pending = { network: 0, cosmetic: 0, youtube: 0 };
let flushTimer = null;

function bump(key, n = 1) {
  pending[key] += n;
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const { stats } = await chrome.storage.local.get({ stats: { network: 0, cosmetic: 0, youtube: 0 } });
    for (const k in pending) { stats[k] += pending[k]; pending[k] = 0; }
    await chrome.storage.local.set({ stats });
  }, 1000);
}

// Only fires for unpacked installs (declarativeNetRequestFeedback); badge counts work everywhere.
chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener(({ rule }) => {
  if (rule.rulesetId === '_dynamic' && rule.ruleId < FIRST_LIST_RULE_ID) return;
  bump('network');
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case 'stat':
      if (msg.key in pending) bump(msg.key, msg.n || 1);
      return;
    case 'update':
      updateLists().then(meta => sendResponse({ ok: true, meta }),
                         err => sendResponse({ ok: false, error: err.message }));
      return true;
    case 'resetStats':
      for (const k in pending) pending[k] = 0;
      chrome.storage.local.set({ stats: { network: 0, cosmetic: 0, youtube: 0 } })
        .then(() => sendResponse({ ok: true }));
      return true;
    case 'isUpdating':
      sendResponse({ updating: !!updating });
      return;
  }
});

// ============================================================
//  Lifecycle
// ============================================================
chrome.runtime.onInstalled.addListener(async () => {
  chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true });
  chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: UPDATE_PERIOD_MIN });
  await applyEnabled(await isEnabled());
  updateLists().catch(e => console.warn('[AdSkipper] list update failed:', e));
});

// Re-assert state whenever the worker wakes (covers reloads where onInstalled ordering failed)
isEnabled().then(applyEnabled);

chrome.runtime.onStartup.addListener(async () => {
  await applyEnabled(await isEnabled());
});

chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === UPDATE_ALARM) updateLists().catch(e => console.warn('[AdSkipper] list update failed:', e));
});
