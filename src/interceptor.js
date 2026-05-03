(() => {
  const STORE_KEY = "__xPostExtractVideoUrls";
  const VIDEO_URL_RE = /https:(?:\\\/\\\/|\\u002[Ff]\\u002[Ff]|\/\/)video\.twimg\.com[^"'<>\s]+/g;

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function" && !window.__xPostExtractFetchPatched) {
    window.__xPostExtractFetchPatched = true;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      collectFromResponse(response);
      return response;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  if (originalOpen && originalSend && !window.__xPostExtractXhrPatched) {
    window.__xPostExtractXhrPatched = true;

    XMLHttpRequest.prototype.open = function open(...args) {
      this.__xPostExtractUrl = args[1] || "";
      return originalOpen.apply(this, args);
    };

    XMLHttpRequest.prototype.send = function send(...args) {
      this.addEventListener("load", () => {
        try {
          collectFromText(this.responseText || "");
        } catch (_error) {
          // Ignore opaque/binary responses.
        }
      });

      return originalSend.apply(this, args);
    };
  }

  function collectFromResponse(response) {
    const contentType = response.headers?.get("content-type") || "";
    if (!contentType.includes("json") && !contentType.includes("text")) {
      return;
    }

    response.clone().text()
      .then(collectFromText)
      .catch(() => {});
  }

  function collectFromText(text) {
    if (!text || !text.includes("video.twimg.com")) {
      return;
    }

    const urls = Array.from(text.matchAll(VIDEO_URL_RE), (match) => normalizeVideoUrl(match[0]))
      .filter(Boolean);

    if (!urls.length) {
      return;
    }

    const existing = readStoredUrls();
    writeStoredUrls([...existing, ...urls]);
  }

  function readStoredUrls() {
    try {
      return JSON.parse(window.sessionStorage.getItem(STORE_KEY) || "[]");
    } catch (_error) {
      return [];
    }
  }

  function writeStoredUrls(urls) {
    const unique = Array.from(new Set(urls)).slice(-100);
    window.sessionStorage.setItem(STORE_KEY, JSON.stringify(unique));
  }

  function normalizeVideoUrl(rawUrl) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = rawUrl
      .replaceAll("\\/", "/")
      .replaceAll("\\u002F", "/")
      .replaceAll("\\u002f", "/")
      .replaceAll("\\u0026", "&")
      .replaceAll("\\u003d", "=")
      .replaceAll("\\u003D", "=");

    return textarea.value
      .replaceAll("&amp;", "&")
      .replaceAll("&#x3D;", "=")
      .replaceAll("&#x3d;", "=")
      .split("\"")[0]
      .split("'")[0]
      .split("#")[0];
  }
})();
