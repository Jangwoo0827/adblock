const $ = id => document.getElementById(id);
const LIST_NAMES = { easylist: 'EasyList', easyprivacy: 'EasyPrivacy', hagezi: 'HaGeZi Pro' };
const fmt = n => (n || 0).toLocaleString();

function renderEnabled(enabled) {
  $('toggle').checked = enabled;
  document.body.classList.toggle('off', !enabled);
  $('status').textContent = enabled ? 'Protection is on' : 'Paused on all sites';
}

function renderStats(stats) {
  const { network = 0, cosmetic = 0, youtube = 0 } = stats || {};
  $('total').textContent = fmt(network + cosmetic + youtube);
  $('network').textContent = fmt(network);
  $('cosmetic').textContent = fmt(cosmetic);
  $('youtube').textContent = fmt(youtube);
}

function timeAgo(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function renderMeta(meta) {
  const lists = $('lists');
  lists.textContent = '';
  for (const [id, name] of Object.entries(LIST_NAMES)) {
    const info = meta?.lists?.[id];
    const row = document.createElement('div');
    row.className = 'list';
    const left = document.createElement('span');
    const dot = document.createElement('i');
    dot.className = 'dot' + (info ? (info.ok ? ' ok' : ' err') : '');
    left.append(dot, name);
    const right = document.createElement('span');
    right.className = 'n';
    right.textContent = !info ? '—' : info.ok
      ? `${fmt(info.network)} net · ${fmt(info.cosmetic)} css`
      : 'failed';
    if (info && !info.ok) right.title = info.error;
    row.append(left, right);
    lists.append(row);
  }
  $('meta').textContent = meta
    ? `${fmt(meta.networkRules)} rules + ${fmt(meta.blockedDomains)} domains · updated ${timeAgo(meta.updatedAt)}`
    : 'Not downloaded yet — lists fetch automatically after install.';
}

function setUpdating(on) {
  $('update').disabled = on;
  $('update').textContent = on ? 'Updating…' : 'Update lists';
}

chrome.storage.local.get({ enabled: true, stats: null, meta: null }, ({ enabled, stats, meta }) => {
  renderEnabled(enabled);
  renderStats(stats);
  renderMeta(meta);
});

chrome.runtime.sendMessage({ type: 'isUpdating' }, res => {
  if (!chrome.runtime.lastError && res?.updating) setUpdating(true);
});

$('toggle').addEventListener('change', () => {
  chrome.storage.local.set({ enabled: $('toggle').checked });
  renderEnabled($('toggle').checked);
});

$('update').addEventListener('click', () => {
  setUpdating(true);
  chrome.runtime.sendMessage({ type: 'update' }, res => {
    setUpdating(false);
    if (chrome.runtime.lastError || !res?.ok) {
      $('meta').textContent = 'Update failed: ' + (res?.error || chrome.runtime.lastError?.message || 'unknown error');
    }
  });
});

$('reset').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'resetStats' });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.enabled) renderEnabled(changes.enabled.newValue);
  if (changes.stats) renderStats(changes.stats.newValue);
  if (changes.meta) { renderMeta(changes.meta.newValue); setUpdating(false); }
});
