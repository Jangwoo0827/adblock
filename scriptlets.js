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

  // ---- AdSense ----
  if (!w.adsbygoogle || Array.isArray(w.adsbygoogle)) {
    w.adsbygoogle = { loaded: true, push: noop };
  }
})();
