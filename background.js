// Toolbar button: toggle the scoreboard panel on the current YouTube tab.
// (Clicking the button grants access to the tab, and the content script only runs on YouTube.)
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel' }).catch(() => {});
});
