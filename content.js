(() => {
  'use strict';

  const IS_YOUTUBE = /(^|\.)youtube\.com$/.test(location.hostname);

  const AD_SELECTORS = [
    '.adsbygoogle',
    'ins.adsbygoogle',
    '[id^="div-gpt-ad"]',
    '[id^="google_ads_iframe"]',
    'iframe[src*="doubleclick.net"]',
    'iframe[src*="googlesyndication.com"]',
    'iframe[id^="aswift_"]',
    '.banner-ad',
    '.ad-banner',
    '.ad-container',
    '.ad-slot',
    '.ad-wrapper',
    '.advertisement',
    '.sponsored-ad',
    '[data-ad-slot]',
    '[data-ad-client]',
    '[data-google-query-id]',
    '.taboola',
    '[id^="taboola-"]',
    '.OUTBRAIN',
    '[data-widget-id^="outbrain"]'
  ].join(',');

  const YT_STATIC_ADS = [
    'ytd-ad-slot-renderer',
    'ytd-banner-promo-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-display-ad-renderer',
    '#player-ads',
    '#masthead-ad'
  ].join(',');

  const SKIP_BUTTONS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    'button[id^="skip-button"]'
  ].join(',');

  let enabled = true;
  let observer = null;
  let scheduled = false;
  let pendingCount = 0;
  let flushTimer = null;
  let adActive = false;
  let savedMuted = false;
  let savedRate = 1;

  // ---- Counter: batch storage writes so we never hammer chrome.storage ----
  function bump(n = 1) {
    pendingCount += n;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const add = pendingCount;
      pendingCount = 0;
      chrome.storage.local.get({ blockedCount: 0 }, ({ blockedCount }) => {
        chrome.storage.local.set({ blockedCount: blockedCount + add });
      });
    }, 500);
  }

  // ---- Web Banner Engine ----
  function removeBanners(root) {
    if (!root.querySelectorAll) return;
    const nodes = root.querySelectorAll(IS_YOUTUBE ? YT_STATIC_ADS : AD_SELECTORS);
    let removed = 0;
    for (const el of nodes) {
      if (el.isConnected) {
        el.remove();
        removed++;
      }
    }
    if (removed) bump(removed);
  }

  // ---- YouTube Engine ----
  function handleYouTubeAd() {
    const player = document.querySelector('.html5-video-player');
    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!player || !video) return;

    const showing = player.classList.contains('ad-showing') ||
                    player.classList.contains('ad-interrupting');

    if (showing) {
      if (!adActive) {
        adActive = true;
        savedMuted = video.muted;
        savedRate = video.playbackRate === 16 ? 1 : video.playbackRate;
        bump();
      }
      video.muted = true;
      if (video.playbackRate !== 16) video.playbackRate = 16;
      if (isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.1) {
        video.currentTime = video.duration - 0.1;
      }
      const skip = document.querySelector(SKIP_BUTTONS);
      if (skip) skip.click();
    } else if (adActive) {
      adActive = false;
      video.muted = savedMuted;
      video.playbackRate = savedRate;
    }

    const overlayClose = document.querySelector('.ytp-ad-overlay-close-button');
    if (overlayClose) overlayClose.click();
  }

  // ---- Scheduling: coalesce mutation bursts into one pass per frame ----
  function runPass() {
    scheduled = false;
    if (!enabled) return;
    if (IS_YOUTUBE) handleYouTubeAd();
    removeBanners(document);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(runPass);
  }

  function start() {
    if (observer) return;
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      // YouTube toggles 'ad-showing' on the player via class changes
      attributes: IS_YOUTUBE,
      attributeFilter: IS_YOUTUBE ? ['class'] : undefined
    });
    schedule();
  }

  function stop() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  // requestAnimationFrame is paused in background tabs; fall back so ads still get skipped.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && enabled) setTimeout(runPass, 0);
  });

  chrome.storage.local.get({ enabled: true }, (data) => {
    enabled = data.enabled;
    if (enabled) start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.enabled) return;
    enabled = changes.enabled.newValue;
    enabled ? start() : stop();
  });
})();
