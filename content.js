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
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-slot button',
    '.ytp-ad-skip-button-container button',
    '[id^="skip-button"] button',
    'button[id^="skip-button"]'
  ].join(',');

  let enabled = true;
  let observer = null;
  let scheduled = false;
  let styleEl = null;
  let pendingCount = 0;
  let flushTimer = null;
  let adActive = false;
  let savedMuted = false;
  let savedRate = 1;

  // ---- Counter: batched, sent to the background (single writer) ----
  function bump(n = 1) {
    pendingCount += n;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const n = pendingCount;
      pendingCount = 0;
      try {
        chrome.runtime.sendMessage({ type: 'stat', key: 'cosmetic', n }).catch(() => {});
      } catch (_) { /* extension reloaded */ }
    }, 500);
  }

  function bumpYouTube() {
    try {
      chrome.runtime.sendMessage({ type: 'stat', key: 'youtube', n: 1 }).catch(() => {});
    } catch (_) {}
  }

  // ---- Instant CSS at document_start: hides ad slots before first paint.
  // The full EasyList cosmetic sheet is injected by the background on navigation commit.
  function injectBaselineCss() {
    if (styleEl || IS_YOUTUBE) return;
    styleEl = document.createElement('style');
    styleEl.textContent = `${AD_SELECTORS}{display:none!important}`;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  function removeBaselineCss() {
    if (styleEl) { styleEl.remove(); styleEl = null; }
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
  let adPoll = null;

  function clickSkip() {
    for (const btn of document.querySelectorAll(SKIP_BUTTONS)) {
      const rect = btn.getBoundingClientRect();
      if (!rect.width || !rect.height) continue; // still hidden behind the countdown
      // Full pointer sequence: YouTube's handlers listen on pointer/mouse events, not just click
      const opts = {
        bubbles: true, cancelable: true, composed: true, view: window, button: 0,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
      };
      btn.dispatchEvent(new PointerEvent('pointerdown', opts));
      btn.dispatchEvent(new MouseEvent('mousedown', opts));
      btn.dispatchEvent(new PointerEvent('pointerup', opts));
      btn.dispatchEvent(new MouseEvent('mouseup', opts));
      btn.click();
      return;
    }
  }
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
        bumpYouTube();
      }
      video.muted = true;
      if (video.playbackRate !== 16) video.playbackRate = 16;
      if (isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.1) {
        video.currentTime = video.duration - 0.1;
      }
      clickSkip();
      // The skip button is revealed by an inline-style change after the countdown,
      // which the observer doesn't see — poll lightly only while an ad is on screen.
      if (!adPoll) adPoll = setInterval(handleYouTubeAd, 250);
    } else if (adActive) {
      adActive = false;
      clearInterval(adPoll);
      adPoll = null;
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
    injectBaselineCss();
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
    removeBaselineCss();
    clearInterval(adPoll);
    adPoll = null;
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
