const state = {
  payload: null
};

const elements = {
  status: document.querySelector("#status"),
  extract: document.querySelector("#extract"),
  options: document.querySelector("#options"),
  send: document.querySelector("#send"),
  copy: document.querySelector("#copy"),
  downloadText: document.querySelector("#downloadText"),
  downloadAll: document.querySelector("#downloadAll"),
  text: document.querySelector("#text"),
  images: document.querySelector("#images"),
  videos: document.querySelector("#videos"),
  imageCount: document.querySelector("#imageCount"),
  videoCount: document.querySelector("#videoCount")
};

init();

async function init() {
  updateActionState();
  elements.extract.addEventListener("click", extract);
  elements.options.addEventListener("click", openOptions);
  elements.send.addEventListener("click", pushCurrentPayload);
  elements.copy.addEventListener("click", copyPayload);
  elements.downloadText.addEventListener("click", downloadText);
  elements.downloadAll.addEventListener("click", downloadAll);
  elements.text.addEventListener("input", syncEditedText);

  await extract();
}

async function extract() {
  setStatus("正在抓取...");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !isSupportedUrl(tab.url)) {
      throw new Error("请在 X 帖子详情页打开扩展");
    }

    const response = await sendExtractMessage(tab.id);

    if (!response?.ok) {
      throw new Error(response?.error || "抓取失败");
    }

    state.payload = response.payload;
    renderPayload(response.payload);
    updateActionState();
    setStatus(`已抓取：${response.payload.images?.length || 0} 张图片，${response.payload.videos?.length || 0} 个视频`);
  } catch (error) {
    state.payload = null;
    renderPayload(null);
    updateActionState();
    setStatus(error.message);
  }
}

async function pushCurrentPayload() {
  if (!state.payload) {
    setStatus("没有可推送内容");
    return;
  }

  setStatus("正在推送...");

  const response = await chrome.runtime.sendMessage({
    type: "X_POST_EXTRACT_PUSH",
    payload: state.payload
  });

  if (!response?.ok) {
    setStatus(response?.error || "推送失败");
    return;
  }

  setStatus("推送完成");
}

function openOptions() {
  chrome.runtime.openOptionsPage();
}

async function copyPayload() {
  if (!state.payload) {
    setStatus("没有可复制内容");
    return;
  }

  await navigator.clipboard.writeText(JSON.stringify(state.payload, null, 2));
  setStatus("JSON 已复制");
}

async function downloadText() {
  if (!state.payload?.text) {
    setStatus("没有可下载正文");
    return;
  }

  await downloadMedia(
    getTextDataUrl(state.payload.text),
    getTextFilename(state.payload)
  );
}

async function downloadAll() {
  if (!state.payload) {
    setStatus("没有可下载内容");
    return;
  }

  const tasks = [];

  if (state.payload.text) {
    tasks.push({
      url: getTextDataUrl(state.payload.text),
      filename: getTextFilename(state.payload)
    });
  }

  tasks.push({
    url: getJsonDataUrl(state.payload),
    filename: getMetaFilename(state.payload)
  });

  state.payload.images?.forEach((image, index) => {
    if (!image.url) {
      return;
    }

    tasks.push({
      url: image.url,
      filename: getMediaFilename(state.payload, "image", index, image.url)
    });
  });

  state.payload.videos?.forEach((video, index) => {
    if (!video.url) {
      return;
    }

    tasks.push({
      url: video.url,
      filename: getMediaFilename(state.payload, "video", index, video.url)
    });
  });

  if (!tasks.length) {
    setStatus("没有可下载内容");
    return;
  }

  let started = 0;
  for (const task of tasks) {
    const ok = await downloadMedia(task.url, task.filename, { silent: true });
    if (ok) {
      started += 1;
    }
  }

  setStatus(`已开始 ${started} 个下载`);
}

function renderPayload(payload) {
  elements.text.value = payload ? payload.text : "";
  elements.images.innerHTML = "";
  elements.videos.innerHTML = "";
  elements.imageCount.textContent = String(payload?.images?.length || 0);
  elements.videoCount.textContent = String(payload?.videos?.length || 0);

  if (!payload?.images?.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "未发现图片";
    elements.images.append(empty);
  } else {
    payload.images.forEach((image, index) => {
      const item = document.createElement("div");
      item.className = "image";

      const img = document.createElement("img");
      img.src = image.url;
      img.alt = image.alt || "tweet image";

      item.append(img);
      item.append(createDownloadButton(
        image.url,
        getMediaFilename(payload, "image", index, image.url)
      ));
      item.append(createRemoveButton("image", index));
      elements.images.append(item);
    });
  }

  if (!payload?.videos?.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "未发现视频";
    elements.videos.append(empty);
    return;
  }

  payload.videos.forEach((video, index) => {
    const item = document.createElement("div");
    item.className = "video";

    if (video.url && video.sourceKind === "mp4") {
      const preview = document.createElement("video");
      preview.src = video.url;
      preview.poster = video.posterUrl || "";
      preview.controls = true;
      preview.muted = true;
      preview.playsInline = true;
      preview.preload = "metadata";
      item.append(preview);
    } else if (video.posterUrl) {
      const poster = document.createElement("img");
      poster.src = video.posterUrl;
      poster.alt = "video poster";
      item.append(poster);
    }

    const meta = document.createElement("span");
    meta.textContent = getVideoLabel(video);
    item.append(meta);

    if (video.url) {
      const link = document.createElement("a");
      link.className = "video-link";
      link.href = video.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "打开视频";
      item.append(link);
      item.append(createDownloadButton(
        video.url,
        getMediaFilename(payload, "video", index, video.url)
      ));
    }

    item.append(createRemoveButton("video", index));
    elements.videos.append(item);
  });
}

function syncEditedText() {
  if (!state.payload) {
    return;
  }

  state.payload = {
    ...state.payload,
    text: elements.text.value
  };
  updateActionState();
}

function createRemoveButton(kind, index) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "remove-button";
  button.title = "删除";
  button.textContent = "×";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    removeMedia(kind, index);
  });

  return button;
}

function removeMedia(kind, index) {
  if (!state.payload) {
    return;
  }

  const key = kind === "image" ? "images" : "videos";
  const nextItems = [...(state.payload[key] || [])];
  nextItems.splice(index, 1);

  state.payload = {
    ...state.payload,
    [key]: nextItems
  };

  renderPayload(state.payload);
  updateActionState();
  setStatus(kind === "image" ? "已删除图片" : "已删除视频");
}

function createDownloadButton(url, filename) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "download-button";
  button.title = "下载";
  button.textContent = "↓";
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await downloadMedia(url, filename);
  });

  return button;
}

async function downloadMedia(url, filename, options = {}) {
  const response = await chrome.runtime.sendMessage({
    type: "X_POST_EXTRACT_DOWNLOAD",
    payload: {
      url,
      filename
    }
  });

  if (!response?.ok) {
    setStatus(response?.error || "下载失败");
    return false;
  }

  if (!options.silent) {
    setStatus("已开始下载");
  }

  return true;
}

function getTextDataUrl(text) {
  return `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
}

function getJsonDataUrl(payload) {
  return `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(payload, null, 2))}`;
}

function getTextFilename(payload) {
  return `x-post-extract/${payload.statusId || "unknown"}/text.txt`;
}

function getMetaFilename(payload) {
  return `x-post-extract/${payload.statusId || "unknown"}/meta.json`;
}

function getMediaFilename(payload, kind, index, url) {
  const statusId = payload.statusId || "unknown";
  const extension = getExtensionFromUrl(url, kind);
  return `x-post-extract/${statusId}/${kind}-${index + 1}.${extension}`;
}

function getExtensionFromUrl(url, kind) {
  const parsed = new URL(url);
  const format = parsed.searchParams.get("format");

  if (format) {
    return format.toLowerCase();
  }

  const pathname = parsed.pathname;
  const match = pathname.match(/\.([a-zA-Z0-9]+)$/);

  if (match) {
    return match[1].toLowerCase();
  }

  return kind === "video" ? "mp4" : "jpg";
}

function getVideoLabel(video) {
  if (!video.url) {
    return "no-url";
  }

  const size = video.width && video.height ? ` ${video.width}x${video.height}` : "";
  return `${video.sourceKind || "video"}${size}`;
}

function updateActionState() {
  const hasPayload = Boolean(state.payload);
  const hasText = Boolean(state.payload?.text);
  const hasDownloads = Boolean(
    state.payload?.text ||
    state.payload?.images?.some((image) => image.url) ||
    state.payload?.videos?.some((video) => video.url)
  );

  elements.copy.disabled = !hasPayload;
  elements.send.disabled = !hasPayload;
  elements.downloadText.disabled = !hasText;
  elements.downloadAll.disabled = !hasDownloads;
}

function isSupportedUrl(url) {
  return /^https:\/\/(x|twitter)\.com\/[^/]+\/status\/\d+/.test(url || "");
}

async function sendExtractMessage(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: "X_POST_EXTRACT_EXTRACT"
    });
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content.js"]
    });

    return chrome.tabs.sendMessage(tabId, {
      type: "X_POST_EXTRACT_EXTRACT"
    });
  }
}

function setStatus(value) {
  elements.status.textContent = value;
}
