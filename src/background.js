const DEFAULT_SETTINGS = {
  endpoint: "",
  token: ""
};

const SUPPORTED_HOSTS = new Set(["x.com", "twitter.com"]);

chrome.runtime.onInstalled.addListener(async () => {
  await setupActionRules();
  await updateAllTabs();
});
chrome.runtime.onStartup.addListener(updateAllTabs);
chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateActionForTab(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    updateActionForTab(tabId, tab);
  }
});

async function setupActionRules() {
  await chrome.action.disable();
  await chrome.declarativeContent.onPageChanged.removeRules();
  await chrome.declarativeContent.onPageChanged.addRules([
    {
      conditions: [
        new chrome.declarativeContent.PageStateMatcher({
          pageUrl: {
            schemes: ["https"],
            hostEquals: "x.com"
          }
        }),
        new chrome.declarativeContent.PageStateMatcher({
          pageUrl: {
            schemes: ["https"],
            hostEquals: "twitter.com"
          }
        })
      ],
      actions: [
        new chrome.declarativeContent.ShowAction()
      ]
    }
  ]);
}

async function updateAllTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map((tab) => updateActionForTab(tab.id, tab)));
}

async function updateActionForTab(tabId, tab) {
  if (!tabId) {
    return;
  }

  const targetTab = tab || await chrome.tabs.get(tabId).catch(() => null);
  const supported = isSupportedPage(targetTab?.url);

  if (supported) {
    await safeActionCall(() => chrome.action.enable(tabId));
    await safeActionCall(() => chrome.action.setBadgeText({ tabId, text: "X" }));
    await safeActionCall(() => chrome.action.setBadgeBackgroundColor({ tabId, color: "#247DB8" }));
    await safeActionCall(() => chrome.action.setTitle({ tabId, title: "X帖子提取：可用" }));
    return;
  }

  await safeActionCall(() => chrome.action.disable(tabId));
  await safeActionCall(() => chrome.action.setBadgeText({ tabId, text: "" }));
  await safeActionCall(() => chrome.action.setTitle({ tabId, title: "X帖子提取：仅支持 X 页面" }));
}

async function safeActionCall(call) {
  try {
    await call();
  } catch (_error) {
    // Tab lifecycle events can race with action updates when a tab closes or navigates.
  }
}

function isSupportedPage(url) {
  try {
    const parsed = new URL(url || "");
    return parsed.protocol === "https:" && SUPPORTED_HOSTS.has(parsed.hostname);
  } catch (_error) {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "X_POST_EXTRACT_DOWNLOAD") {
    downloadMedia(message.payload)
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "X_POST_EXTRACT_PUSH") {
    pushPost(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function downloadMedia(payload) {
  if (!payload?.url) {
    throw new Error("没有可下载的媒体 URL");
  }

  return chrome.downloads.download({
    url: payload.url,
    filename: payload.filename || getFilenameFromUrl(payload.url),
    conflictAction: "uniquify",
    saveAs: false
  });
}

function getFilenameFromUrl(url) {
  const parsed = new URL(url);
  return decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "media");
}

async function pushPost(payload) {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);

  if (!settings.endpoint) {
    throw new Error("请先在配置页面设置推送地址");
  }

  const headers = {
    "content-type": "application/json"
  };

  if (settings.token) {
    headers.authorization = `Bearer ${settings.token}`;
  }

  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`推送失败：${response.status} ${body}`.trim());
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  return response.text();
}
