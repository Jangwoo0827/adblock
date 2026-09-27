const toggle = document.getElementById('toggle');
const status = document.getElementById('status');
const count = document.getElementById('count');
const reset = document.getElementById('reset');

function render({ enabled, blockedCount }) {
  if (enabled !== undefined) {
    toggle.checked = enabled;
    status.textContent = enabled ? 'Enabled' : 'Disabled';
  }
  if (blockedCount !== undefined) {
    count.textContent = blockedCount.toLocaleString();
  }
}

chrome.storage.local.get({ enabled: true, blockedCount: 0 }, render);

toggle.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: toggle.checked });
  render({ enabled: toggle.checked });
});

reset.addEventListener('click', () => {
  chrome.storage.local.set({ blockedCount: 0 });
});

// Live updates while the popup is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  render({
    enabled: changes.enabled?.newValue,
    blockedCount: changes.blockedCount?.newValue
  });
});
