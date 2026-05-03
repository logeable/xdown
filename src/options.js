const DEFAULT_SETTINGS = {
  endpoint: "",
  token: ""
};

const elements = {
  status: document.querySelector("#status"),
  endpoint: document.querySelector("#endpoint"),
  token: document.querySelector("#token"),
  save: document.querySelector("#save")
};

init();

async function init() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  elements.endpoint.value = settings.endpoint;
  elements.token.value = settings.token;
  elements.save.addEventListener("click", saveSettings);
}

async function saveSettings() {
  await chrome.storage.sync.set({
    endpoint: elements.endpoint.value.trim(),
    token: elements.token.value.trim()
  });

  setStatus("配置已保存");
}

function setStatus(value) {
  elements.status.textContent = value;
}
