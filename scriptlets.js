// Runs in the page's MAIN world at document_start (registered by background.js while enabled).
// Pre-defines harmless stubs for ad/analytics globals so that, once their real scripts are
// blocked, page code calling them neither throws nor waits forever on callbacks.
(() => {
  'use strict';
  const w = window;
  const noop = () => {};
  const later = fn => { if (typeof fn === 'function') setTimeout(() => { try { fn(); } catch (_) {} }, 0); };

  // ---- Google Analytics (analytics.js) ----
  if (typeof w.ga !== 'function') {
    const tracker = { get: noop, set: noop, send: noop };
    const ga = function (...args) {
      const last = args[args.length - 1];
      if (typeof args[0] === 'function') later(() => args[0](tracker));
      else if (last && typeof last === 'object' && last.hitCallback) later(last.hitCallback);
    };
    ga.create = () => tracker;
    ga.getAll = () => [];
    ga.getByName = () => null;
    ga.remove = noop;
    ga.loaded = true;
    w.ga = ga;
  }

  // ---- Legacy GA / gtag ----
  if (!w._gaq) w._gaq = { push: noop, _getAsyncTracker: noop, _createAsyncTracker: noop };
  if (typeof w.gtag !== 'function') {
    w.gtag = function (...args) {
      const params = args.find(a => a && typeof a === 'object');
      if (params && params.event_callback) later(params.event_callback);
    };
  }

  // ---- Google Publisher Tag (googletag) ----
  if (!w.googletag || !w.googletag.apiReady) {
    const queued = (w.googletag && Array.isArray(w.googletag.cmd)) ? w.googletag.cmd : [];
    const slot = {};
    ['addService', 'setTargeting', 'clearTargeting', 'defineSizeMapping', 'setCollapseEmptyDiv',
     'setClickUrl', 'setForceSafeFrame', 'setSafeFrameConfig', 'updateTargetingFromMap']
      .forEach(m => { slot[m] = () => slot; });
    Object.assign(slot, {
      getSlotElementId: () => '', getAdUnitPath: () => '', getTargeting: () => [],
      getTargetingKeys: () => [], getResponseInformation: () => null, getSizes: () => []
    });

    const pubads = {};
    ['addEventListener', 'removeEventListener', 'setTargeting', 'clearTargeting', 'enableSingleRequest',
     'enableAsyncRendering', 'enableLazyLoad', 'collapseEmptyDivs', 'disableInitialLoad', 'refresh',
     'clear', 'setPrivacySettings', 'setRequestNonPersonalizedAds', 'setCentering', 'setLocation',
     'setPublisherProvidedId', 'enableVideoAds', 'setForceSafeFrame', 'setSafeFrameConfig', 'set',
     'updateCorrelator', 'display'].forEach(m => { pubads[m] = () => pubads; });
    Object.assign(pubads, { getSlots: () => [], getTargeting: () => [], getTargetingKeys: () => [], get: () => null });

    const sizeMapping = { addSize: () => sizeMapping, build: () => [] };
    const run = fn => { try { fn(); } catch (_) {} };

    w.googletag = {
      apiReady: true,
      pubadsReady: true,
      cmd: { push: (...fns) => { fns.forEach(run); return 0; } },
      pubads: () => pubads,
      companionAds: () => pubads,
      content: () => pubads,
      defineSlot: () => slot,
      defineOutOfPageSlot: () => slot,
      destroySlots: () => true,
      display: noop,
      enableServices: noop,
      disablePublisherConsole: noop,
      openConsole: noop,
      setAdIframeTitle: noop,
      sizeMapping: () => sizeMapping,
      getVersion: () => ''
    };
    queued.forEach(run);
  }

  // ---- Social / ad pixels (their scripts are blocked; page code still calls them) ----
  // Each stub mimics the loader snippet's queue-function shape so `fbq('track', …)` etc. never throw.
  const queueStub = (name, extra) => {
    if (typeof w[name] === 'function') return;
    const f = function () {};
    f.queue = []; f.push = noop; f.loaded = true; f.version = '2.0';
    Object.assign(f, extra);
    w[name] = f;
  };
  queueStub('fbq', { callMethod: noop, instance: {} });  // Facebook / Meta Pixel
  if (!w._fbq) w._fbq = w.fbq;
  queueStub('twq', { exe: noop });                      // X / Twitter
  queueStub('pintrk');                                  // Pinterest
  queueStub('snaptr', { handleRequest: noop });         // Snapchat
  queueStub('rdt', { sendEvent: noop });                // Reddit
  queueStub('qp');                                      // Quora
  queueStub('uetq');                                    // Bing / Microsoft Ads
  queueStub('obApi');                                   // Outbrain
  queueStub('lintrk');                                  // LinkedIn Insight
  if (!Array.isArray(w._linkedin_data_partner_ids)) w._linkedin_data_partner_ids = [];
  if (!w.ttq) {                                         // TikTok Pixel
    const ttq = { load: noop, page: noop, track: noop, identify: noop, instance: () => ttq,
                  on: noop, off: noop, ready: fn => later(fn), push: noop };
    w.ttq = ttq;
  }
  if (!w._tfa) w._tfa = { push: noop };                 // Taboola
  if (!w.hj) w.hj = function () {};                    // Hotjar
  if (!w.clarity) w.clarity = function () {};          // Microsoft Clarity
  if (!w.mixpanel) w.mixpanel = { init: noop, track: noop, identify: noop, register: noop,
                                  people: { set: noop }, push: noop, __loaded: true };

  // ---- Privacy Sandbox: remove Chromium's in-browser ad-targeting APIs ----
  // Topics, Protected Audience (FLEDGE), Attribution Reporting, Private State Tokens, Shared Storage.
  // Pages feature-detect these, so removing them just looks like an older/other browser.
  const strip = (proto, props) => {
    if (!proto) return;
    for (const p of props) {
      try { if (p in proto) delete proto[p]; } catch (_) {}
    }
  };
  strip(w.Document && Document.prototype, ['browsingTopics', 'hasPrivateToken', 'hasRedemptionRecord']);
  strip(w.Navigator && Navigator.prototype, [
    'joinAdInterestGroup', 'leaveAdInterestGroup', 'clearOriginJoinedAdInterestGroups',
    'updateAdInterestGroups', 'runAdAuction', 'createAuctionNonce', 'canLoadAdAuctionFencedFrame',
    'deprecatedURNToURL', 'deprecatedReplaceInURN', 'getInterestGroupAdAuctionData', 'protectedAudience'
  ]);
  for (const el of ['HTMLAnchorElement', 'HTMLImageElement', 'HTMLScriptElement', 'HTMLAreaElement']) {
    strip(w[el] && w[el].prototype, ['attributionSrc']);
  }
  strip(w.Window && Window.prototype, ['sharedStorage']);
  strip(w, ['sharedStorage']);

  // ---- Global Privacy Control: tell sites "do not sell/share" (legally binding in CA, CO, …) ----
  try {
    if (w.Navigator && !navigator.globalPrivacyControl) {
      Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true });
    }
  } catch (_) {}

  // ---- AdSense ----
  if (!w.adsbygoogle || Array.isArray(w.adsbygoogle)) {
    w.adsbygoogle = { loaded: true, push: noop };
  }
})();
