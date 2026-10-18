/* Service worker: only responsible for opening the control panel.
 *
 * All orchestration lives in the dashboard page (src/dashboard.html), because a
 * page context is never reclaimed mid-task — unlike an MV3 service worker.
 */
const DASHBOARD_PATH = 'src/dashboard.html';

async function openDashboard() {
  const url = chrome.runtime.getURL(DASHBOARD_PATH);
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    const tab = tabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url, active: true });
}

chrome.action.onClicked.addListener(() => {
  openDashboard().catch((err) => console.error('open dashboard failed', err));
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') openDashboard().catch(() => {});
});
