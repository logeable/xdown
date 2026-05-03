(() => {
  if (window.__xPostExtractContentLoaded) {
    return;
  }

  window.__xPostExtractContentLoaded = true;

  const STATUS_PATH_RE = /^\/[^/]+\/status\/(\d+)/;
  const TWITTER_IMAGE_RE = /^https:\/\/pbs\.twimg\.com\/media\//;
  const TWITTER_VIDEO_RE = /^https:\/\/video\.twimg\.com\//;
  const TWITTER_VIDEO_URL_RE = /https:(?:\\\/\\\/|\\u002[Ff]\\u002[Ff]|\/\/)video\.twimg\.com[^"'<>\s]+/g;
  const VIDEO_STORE_KEY = "__xPostExtractVideoUrls";

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "X_POST_EXTRACT_EXTRACT") {
      return false;
    }

    extractFromPage()
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  async function extractFromPage() {
    await waitForTweetArticle();

    const article = getPrimaryTweetArticle();
    if (!article) {
      throw new Error("未找到帖子内容，请确认当前页面是 X 帖子详情页");
    }

    await waitForVideoUrls(article);

    const tweetText = getTweetText(article);
    const images = getTweetImages(article);
    const videos = getTweetVideos(article);
    const canonicalUrl = getCanonicalStatusUrl();

    return {
      source: "x",
      url: canonicalUrl,
      statusId: getStatusId(canonicalUrl),
      author: getAuthor(article),
      text: tweetText,
      images,
      videos,
      debug: getDebugInfo(article, videos),
      extractedAt: new Date().toISOString()
    };
  }

  function waitForVideoUrls(article) {
    return new Promise((resolve) => {
      if (!hasVideoSignal(article) || hasKnownVideoUrls()) {
        resolve();
        return;
      }

      const timeout = window.setTimeout(() => {
        observer.disconnect();
        resolve();
      }, 8000);

      const observer = new MutationObserver(() => {
        if (hasKnownVideoUrls()) {
          window.clearTimeout(timeout);
          observer.disconnect();
          resolve();
        }
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    });
  }

  function hasVideoSignal(article) {
    return Boolean(
      article.querySelector("video") ||
      article.innerText.includes("嵌入式视频") ||
      article.innerText.toLowerCase().includes("embedded video") ||
      hasKnownVideoUrls()
    );
  }

  function hasKnownVideoUrls() {
    return getKnownVideoUrls().length > 0;
  }

  function waitForTweetArticle() {
    return new Promise((resolve, reject) => {
      if (getPrimaryTweetArticle()) {
        resolve();
        return;
      }

      const timeout = window.setTimeout(() => {
        observer.disconnect();
        reject(new Error("等待帖子加载超时"));
      }, 10000);

      const observer = new MutationObserver(() => {
        if (getPrimaryTweetArticle()) {
          window.clearTimeout(timeout);
          observer.disconnect();
          resolve();
        }
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    });
  }

  function getPrimaryTweetArticle() {
    const statusId = getStatusId(window.location.href);
    const articles = Array.from(document.querySelectorAll("article"));

    if (!statusId) {
      return articles[0] || null;
    }

    return articles.find((article) => {
      const links = Array.from(article.querySelectorAll('a[href*="/status/"]'));
      return links.some((link) => link.href.includes(`/status/${statusId}`));
    }) || articles[0] || null;
  }

  function getTweetText(article) {
    const textNode = article.querySelector('[data-testid="tweetText"]');

    if (!textNode) {
      return "";
    }

    return normalizeText(textNode.innerText);
  }

  function getTweetImages(article) {
    const seen = new Set();
    const images = [];

    for (const img of article.querySelectorAll("img")) {
      if (!belongsToPrimaryTweetMedia(img)) {
        continue;
      }

      const rawUrl = img.currentSrc || img.src;

      if (!rawUrl || !TWITTER_IMAGE_RE.test(rawUrl)) {
        continue;
      }

      const url = toHighestQualityImageUrl(rawUrl);
      if (seen.has(url)) {
        continue;
      }

      seen.add(url);
      images.push({
        url,
        alt: img.alt || "",
        width: img.naturalWidth || null,
        height: img.naturalHeight || null
      });
    }

    return images;
  }

  function getTweetVideos(article) {
    const videos = [];
    const seen = new Set();
    const bestVideoUrls = getBestVideoUrlsByMedia(getKnownVideoUrls());

    for (const video of article.querySelectorAll("video")) {
      if (!belongsToPrimaryTweetMedia(video)) {
        continue;
      }

      const rawUrl = getVideoElementUrl(video);
      const url = isUsableVideoUrl(rawUrl) ? rawUrl : getMatchingVideoUrl(video, bestVideoUrls);
      const posterUrl = getVideoPosterUrl(video);
      const key = url || posterUrl;

      if (!key || seen.has(key)) {
        continue;
      }

      seen.add(key);
      const dimensions = getVideoDimensions(url);
      videos.push({
        url,
        posterUrl,
        width: video.videoWidth || dimensions.width,
        height: video.videoHeight || dimensions.height,
        duration: Number.isFinite(video.duration) ? video.duration : null,
        sourceKind: getVideoSourceKind(rawUrl, url)
      });
    }

    return videos;
  }

  function belongsToPrimaryTweetMedia(element) {
    const currentStatusId = getStatusId(window.location.href);
    const statusLink = element.closest('a[href*="/status/"]');

    if (!currentStatusId || !statusLink) {
      return true;
    }

    return getStatusId(statusLink.href) === currentStatusId;
  }

  function getMatchingVideoUrl(video, urls) {
    const videoWidth = video.videoWidth || null;
    const videoHeight = video.videoHeight || null;

    if (!videoWidth || !videoHeight) {
      return "";
    }

    return urls.find((url) => {
      const dimensions = getVideoDimensions(url);
      return dimensions.width === videoWidth && dimensions.height === videoHeight;
    }) || "";
  }

  function getVideoElementUrl(video) {
    const source = video.querySelector("source");
    return video.currentSrc || video.src || source?.src || "";
  }

  function getVideoPosterUrl(video) {
    const poster = video.poster || "";
    if (poster) {
      return poster;
    }

    const wrapper = video.closest('[data-testid="videoPlayer"], [data-testid="previewInterstitial"]');
    const image = wrapper?.querySelector("img");
    return image?.currentSrc || image?.src || "";
  }

  function getKnownVideoUrls() {
    return sortVideoUrls([
      ...getStoredVideoUrls(),
      ...getLoadedVideoUrls(),
      ...getEmbeddedVideoUrls()
    ]);
  }

  function getStoredVideoUrls() {
    try {
      return JSON.parse(window.sessionStorage.getItem(VIDEO_STORE_KEY) || "[]")
        .map(normalizeVideoUrl)
        .filter(isDownloadableVideoUrl);
    } catch (_error) {
      return [];
    }
  }

  function getLoadedVideoUrls() {
    return performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => TWITTER_VIDEO_RE.test(url))
      .map(normalizeVideoUrl)
      .filter(isDownloadableVideoUrl);
  }

  function getEmbeddedVideoUrls() {
    return Array.from(document.documentElement.innerHTML.matchAll(TWITTER_VIDEO_URL_RE))
      .map((match) => normalizeVideoUrl(match[0]))
      .filter(isDownloadableVideoUrl);
  }

  function hasEmbeddedVideoUrl() {
    TWITTER_VIDEO_URL_RE.lastIndex = 0;
    return TWITTER_VIDEO_URL_RE.test(document.documentElement.innerHTML);
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

  function isDownloadableVideoUrl(url) {
    if (!TWITTER_VIDEO_RE.test(url)) {
      return false;
    }

    if (url.includes("/aud/") || url.endsWith(".m4s") || isSegmentedVideoUrl(url)) {
      return false;
    }

    return /\.(mp4|m3u8)(\?|$)/.test(url);
  }

  function isSegmentedVideoUrl(url) {
    return /\/vid\/[^/]+\/\d+\/\d+\/\d+x\d+\//.test(url);
  }

  function sortVideoUrls(urls) {
    return Array.from(new Set(urls))
      .sort((left, right) => getVideoUrlScore(right) - getVideoUrlScore(left));
  }

  function getVideoUrlScore(url) {
    const { width, height } = getVideoDimensions(url);
    const isMp4 = url.includes(".mp4") ? 1 : 0;
    const isPlaylist = url.includes("/pl/") ? 1 : 0;
    const hasVariantTag = /[?&]tag=/.test(url) ? 1 : 0;

    return width * height + isMp4 * 10_000_000 + hasVariantTag * 1_000_000 - isPlaylist * 1_000_000;
  }

  function getVideoDimensions(url) {
    const sizeMatch = url.match(/\/(\d+)x(\d+)\//);
    return {
      width: sizeMatch ? Number(sizeMatch[1]) : null,
      height: sizeMatch ? Number(sizeMatch[2]) : null
    };
  }

  function getBestVideoUrlsByMedia(urls) {
    const bestByMedia = new Map();

    for (const url of urls) {
      const mediaId = getVideoMediaId(url) || url;
      const current = bestByMedia.get(mediaId);

      if (!current || getVideoUrlScore(url) > getVideoUrlScore(current)) {
        bestByMedia.set(mediaId, url);
      }
    }

    return Array.from(bestByMedia.values())
      .sort((left, right) => getVideoUrlScore(right) - getVideoUrlScore(left));
  }

  function getVideoMediaId(url) {
    return url.match(/\/(?:amplify_video|ext_tw_video|tweet_video)\/(\d+)\//)?.[1] || "";
  }

  function isUsableVideoUrl(url) {
    return Boolean(url && !url.startsWith("blob:") && TWITTER_VIDEO_RE.test(url));
  }

  function getVideoSourceKind(rawUrl, url) {
    const value = url || rawUrl || "";
    if (value.startsWith("blob:")) {
      return "blob";
    }

    if (value.includes(".m3u8")) {
      return "hls";
    }

    if (value.includes(".mp4")) {
      return "mp4";
    }

    return value ? "url" : "unknown";
  }

  function getDebugInfo(article, videos) {
    if (videos.some((video) => video.url)) {
      return undefined;
    }

    return {
      hasVideoElement: Boolean(article.querySelector("video")),
      videoElementSource: article.querySelector("video") ? getVideoElementUrl(article.querySelector("video")) : "",
      videoElementDimensions: getArticleVideoDimensions(article),
      storedVideoUrlCount: getStoredVideoUrls().length,
      loadedVideoUrlCount: getLoadedVideoUrls().length,
      embeddedVideoUrlCount: getEmbeddedVideoUrls().length,
      matchingVideoUrlCount: getMatchingVideoUrlCount(article)
    };
  }

  function getArticleVideoDimensions(article) {
    const video = article.querySelector("video");
    return video ? {
      width: video.videoWidth || null,
      height: video.videoHeight || null
    } : null;
  }

  function getMatchingVideoUrlCount(article) {
    const video = article.querySelector("video");
    if (!video?.videoWidth || !video?.videoHeight) {
      return 0;
    }

    return getKnownVideoUrls().filter((url) => {
      const dimensions = getVideoDimensions(url);
      return dimensions.width === video.videoWidth && dimensions.height === video.videoHeight;
    }).length;
  }

  function getAuthor(article) {
    const userNameNode = article.querySelector('[data-testid="User-Name"]');
    const text = userNameNode ? normalizeText(userNameNode.innerText) : "";
    const handleMatch = text.match(/@[\w_]+/);

    return {
      displayName: handleMatch ? text.slice(0, handleMatch.index).trim() : text,
      handle: handleMatch ? handleMatch[0] : ""
    };
  }

  function getCanonicalStatusUrl() {
    const statusId = getStatusId(window.location.href);

    if (!statusId) {
      return window.location.href.split("?")[0];
    }

    const authorPath = getStatusAuthorPath(statusId);
    if (!authorPath) {
      return window.location.href.split("?")[0].replace(new RegExp(`(/status/${statusId}).*$`), "$1");
    }

    return `${window.location.origin}/${authorPath}/status/${statusId}`;
  }

  function getStatusAuthorPath(statusId) {
    const currentPathMatch = window.location.pathname.match(new RegExp(`^/([^/]+)/status/${statusId}`));
    if (currentPathMatch?.[1]) {
      return currentPathMatch[1];
    }

    const statusLink = document.querySelector(`a[href*="/status/${statusId}"]`);
    if (!statusLink) {
      return "";
    }

    const parsed = new URL(statusLink.getAttribute("href"), window.location.origin);
    return parsed.pathname.match(new RegExp(`^/([^/]+)/status/${statusId}`))?.[1] || "";
  }

  function getStatusId(url) {
    const parsed = new URL(url, window.location.origin);
    return parsed.pathname.match(STATUS_PATH_RE)?.[1] || "";
  }

  function normalizeText(value) {
    return value
      .replace(/\u00a0/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function toHighestQualityImageUrl(rawUrl) {
    const url = new URL(rawUrl);
    url.searchParams.set("name", "orig");
    return url.href;
  }
})();
