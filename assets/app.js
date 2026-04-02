const MODEL_ID = "Xenova/bge-small-zh-v1.5";
const PREVIEW_LIMIT = 200;
const ASSET_VERSION = "20260402-2";
const COMMON_PINYIN_CHARS = "āáǎà ōóǒò ēéěè īíǐì ūúǔù ü ǖǘǚǜ ê ńňǹ";
const SEARCH_MANIFEST_PATH = "./data/search/yusuo.search.manifest.json";
const APPEND_CSV_PATH = "./data/yusuo.append.csv";

const SEARCH_ASSET_CACHE_NAME = "yusuo-search-asset-cache";
const SEARCH_META_CACHE_VERSION = "20260402-2";
const SEARCH_EMBEDDINGS_CACHE_VERSION = "20260402-2";

const state = {
  rows: [],
  filtered: [],
  page: 1,
  pageSize: 50,
  mode: "keyword",
  worker: null,
  workerReady: false,
  semanticReady: false,
  embeddingsLoaded: false,
  embeddingDimension: 0,
  embeddingCount: 0,
  searchManifest: null,
  searchManifestPath: SEARCH_MANIFEST_PATH,
  embeddingDtype: "float16",
  appendCount: 0,
  appendEmbeddingCount: 0,
};

const searchInput = document.querySelector("#searchInput");
const searchButton = document.querySelector("#searchButton");
const clearButton = document.querySelector("#clearButton");
const keywordModeButton = document.querySelector("#keywordModeButton");
const semanticModeButton = document.querySelector("#semanticModeButton");
const statusText = document.querySelector("#statusText");
const semanticStatus = document.querySelector("#semanticStatus");
const progressFill = document.querySelector("#progressFill");
const progressText = document.querySelector("#progressText");
const resultMeta = document.querySelector("#resultMeta");
const results = document.querySelector("#results");
const template = document.querySelector("#resultTemplate");
const prevButton = document.querySelector("#prevButton");
const nextButton = document.querySelector("#nextButton");
const pageInfo = document.querySelector("#pageInfo");
const limitSelect = document.querySelector("#limitSelect");
const copyPinyinCharsButton = document.querySelector("#copyPinyinCharsButton");
const clearEmbeddingCacheButton = document.querySelector("#clearEmbeddingCacheButton");
const resultsPanel = document.querySelector(".results-panel");

function setProgress(percent, label = `${percent}%`) {
  progressFill.style.width = `${percent}%`;
  progressText.textContent = label;
}

function setMode(mode) {
  state.mode = mode;
  keywordModeButton.classList.toggle("is-active", mode === "keyword");
  semanticModeButton.classList.toggle("is-active", mode === "semantic");
  semanticModeButton.disabled = false;
}

function resolveManifestAssetPath(relativePath) {
  const manifestUrl = new URL(state.searchManifestPath, window.location.href);
  return new URL(relativePath, manifestUrl).toString();
}

function buildVersionedCacheUrl(url, version) {
  const cacheUrl = new URL(url, window.location.href);
  cacheUrl.searchParams.set("__local_cache_version__", version);
  return cacheUrl.toString();
}

function getMetaCacheKey(url) {
  return buildVersionedCacheUrl(url, SEARCH_META_CACHE_VERSION);
}

function getEmbeddingsCacheKey(url) {
  return buildVersionedCacheUrl(url, SEARCH_EMBEDDINGS_CACHE_VERSION);
}

async function requestPersistentStorage() {
  if (!navigator.storage?.persist) {
    return false;
  }

  try {
    const alreadyPersistent = navigator.storage.persisted
      ? await navigator.storage.persisted()
      : false;

    if (alreadyPersistent) {
      return true;
    }

    return await navigator.storage.persist();
  } catch (error) {
    console.warn("persist() failed:", error);
    return false;
  }
}

async function fetchCachedAssetOnce(url, cacheKey, responseType = "binary") {
  if (!window.caches) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`加载 ${url} 失败：${response.status}`);
    }
    return { response, fromCache: false, responseType };
  }

  await requestPersistentStorage();

  const cache = await caches.open(SEARCH_ASSET_CACHE_NAME);
  const cached = await cache.match(cacheKey);
  if (cached) {
    return { response: cached.clone(), fromCache: true, responseType };
  }

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`加载 ${url} 失败：${response.status}`);
  }

  await cache.put(cacheKey, response.clone());
  return { response, fromCache: false, responseType };
}

async function fetchCachedJsonOnce(url) {
  return fetchCachedAssetOnce(url, getMetaCacheKey(url), "json");
}

async function fetchCachedBinaryOnce(url) {
  return fetchCachedAssetOnce(url, getEmbeddingsCacheKey(url), "binary");
}

function resetMainEmbeddingVectors() {
  const count = Math.min(state.embeddingCount, state.rows.length);
  for (let index = 0; index < count; index += 1) {
    state.rows[index].embeddingVector = null;
  }
  state.embeddingsLoaded = false;
  inspectSemanticState();
}

async function clearCachedSearchAssets() {
  if (!window.caches) {
    return;
  }

  const cache = await caches.open(SEARCH_ASSET_CACHE_NAME);

  const embeddingsPath = state.searchManifest?.embeddings || "./data/search/yusuo.search.embeddings.bin";
  const metaPath = state.searchManifest?.meta || "./data/search/yusuo.search.meta.json";

  const embeddingsUrl = resolveManifestAssetPath(embeddingsPath);
  const metaUrl = resolveManifestAssetPath(metaPath);

  await Promise.all([
    cache.delete(getEmbeddingsCacheKey(embeddingsUrl)),
    cache.delete(getMetaCacheKey(metaUrl)),
  ]);
}

function decodeFloat16Bits(bits) {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x03ff;

  if (exponent === 0) {
    if (fraction === 0) {
      return sign * 0;
    }
    return sign * 2 ** (-14) * (fraction / 1024);
  }

  if (exponent === 0x1f) {
    return fraction === 0 ? sign * Infinity : Number.NaN;
  }

  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function decodeEmbeddingsBuffer(buffer, dtype, expectedLength) {
  if (dtype === "float16") {
    const source = new Uint16Array(buffer);
    if (source.length < expectedLength) {
      throw new Error("Float16 向量文件长度异常。");
    }

    const decoded = new Float32Array(expectedLength);
    for (let index = 0; index < expectedLength; index += 1) {
      decoded[index] = decodeFloat16Bits(source[index]);
    }
    return decoded;
  }

  const vectors = new Float32Array(buffer);
  if (vectors.length < expectedLength) {
    throw new Error("Float32 向量文件长度异常。");
  }
  return vectors;
}

function parseEmbeddingJson(text) {
  if (!text) {
    return null;
  }

  try {
    const vector = JSON.parse(text);
    if (!Array.isArray(vector) || vector.length === 0) {
      return null;
    }
    return Float32Array.from(vector);
  } catch (_error) {
    return null;
  }
}

function scrollResultsToTop() {
  if (!resultsPanel) {
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  window.requestAnimationFrame(() => {
    resultsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

async function copyText(text, successMessage) {
  await navigator.clipboard.writeText(text);
  statusText.textContent = successMessage;
}

function parseCsvLine(line) {
  const cells = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (quoted && next === '"') {
        value += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === "," && !quoted) {
      cells.push(value);
      value = "";
      continue;
    }

    value += char;
  }

  cells.push(value);
  return cells;
}

function normalize(text) {
  return (text || "").toLowerCase().trim();
}

function parseKeywordRegex(query) {
  const trimmed = (query || "").trim();
  if (!trimmed) {
    return { regex: null, error: null };
  }

  const slashMatch = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
  try {
    if (slashMatch) {
      return {
        regex: new RegExp(slashMatch[1], slashMatch[2]),
        error: null,
      };
    }

    if (/[\\^$.*+?()[\]{}|]/.test(trimmed)) {
      return {
        regex: new RegExp(trimmed, "i"),
        error: null,
      };
    }
  } catch (error) {
    return {
      regex: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return { regex: null, error: null };
}

function scoreKeywordRow(row, query, regex = null) {
  if (!query) {
    return 1;
  }

  const headword = normalize(row.headword);
  const pinyinTone = normalize(row.pinyin_tone);
  const pinyinPlain = normalize(row.pinyin_plain);
  const definition = normalize(row.definition);

  if (regex) {
    const rawHeadword = row.headword || "";
    const rawPinyinTone = row.pinyin_tone || "";
    const rawPinyinPlain = row.pinyin_plain || "";

    if (regex.test(rawHeadword)) {
      regex.lastIndex = 0;
      return 100;
    }
    regex.lastIndex = 0;

    if (regex.test(rawPinyinTone) || regex.test(rawPinyinPlain)) {
      regex.lastIndex = 0;
      return 80;
    }
    regex.lastIndex = 0;
  }

  if (headword === query || pinyinTone === query || pinyinPlain === query) {
    return 100;
  }
  if (headword.startsWith(query) || pinyinTone.startsWith(query) || pinyinPlain.startsWith(query)) {
    return 60;
  }
  if (headword.includes(query)) {
    return 40;
  }
  if (pinyinTone.includes(query) || pinyinPlain.includes(query)) {
    return 30;
  }
  if (definition.includes(query)) {
    return 10;
  }
  return 0;
}

function cosineSimilarity(a, b) {
  const length = Math.min(a.length, b.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    total += a[index] * b[index];
  }
  return total;
}

function createWorker() {
  if (state.worker) {
    return state.worker;
  }
  state.worker = new Worker(`./assets/worker.js?v=${ASSET_VERSION}`, { type: "module" });
  return state.worker;
}

function callWorker(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const worker = createWorker();
    const messageId = `${type}-${crypto.randomUUID()}`;

    const handleMessage = (event) => {
      const message = event.data;
      if (message.messageId !== messageId) {
        return;
      }
      worker.removeEventListener("message", handleMessage);
      if (message.type === "error") {
        reject(new Error(message.error));
        return;
      }
      resolve(message.payload);
    };

    worker.addEventListener("message", handleMessage);
    worker.postMessage({ messageId, type, payload });
  });
}

async function ensureWorkerLoaded() {
  if (state.workerReady) {
    return;
  }
  statusText.textContent = "正在加载语义模型…";
  setProgress(25, "loading");
  await callWorker("load-model", { model: MODEL_ID });
  state.workerReady = true;
  statusText.textContent = "语义模型已就绪。";
  setProgress(100, "ready");
}

function render() {
  const total = state.filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / state.pageSize));
  state.page = Math.min(state.page, pageCount);

  const start = (state.page - 1) * state.pageSize;
  const end = start + state.pageSize;
  const pageRows = state.filtered.slice(start, end);

  results.innerHTML = "";

  if (pageRows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.mode === "semantic"
      ? "CSV 中没有可用的语义匹配结果。"
      : "没有匹配结果，试试换一个汉字、拼音或释义关键词。";
    results.appendChild(empty);
  } else {
    const fragment = document.createDocumentFragment();
    pageRows.forEach((row) => {
      const card = template.content.firstElementChild.cloneNode(true);
      card.querySelector(".headword").textContent = row.headword;
      card.querySelector(".pinyin-tone").textContent = row.pinyin_tone || " ";
      card.querySelector(".pinyin-plain").textContent = row.pinyin_plain || " ";
      card.querySelector(".definition").textContent = row.definition || " ";
      const badge = card.querySelector(".score-badge");
      if (typeof row.semanticScore === "number") {
        badge.textContent = `相似度 ${(row.semanticScore * 100).toFixed(1)}`;
      } else {
        badge.textContent = state.mode === "keyword" ? "关键词" : "";
      }
      fragment.appendChild(card);
    });
    results.appendChild(fragment);
  }

  resultMeta.textContent = `共 ${total.toLocaleString()} 条结果`;
  pageInfo.textContent = `第 ${state.page} / ${pageCount} 页`;
  prevButton.disabled = state.page <= 1;
  nextButton.disabled = state.page >= pageCount;
}

function runKeywordSearch() {
  const query = normalize(searchInput.value);
  const { regex, error } = parseKeywordRegex(searchInput.value);
  const ranked = state.rows
    .map((row, index) => ({ row, index, score: scoreKeywordRow(row, query, regex) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => ({ ...item.row, semanticScore: null }));

  state.filtered = ranked;
  state.page = 1;
  if (error) {
    statusText.textContent = `正则写法有误，已按普通关键词搜索：${error}`;
  } else if (regex) {
    statusText.textContent = `正则关键词检索完成，命中 ${ranked.length.toLocaleString()} 条结果。`;
  } else {
    statusText.textContent = query
      ? `关键词检索完成，命中 ${ranked.length.toLocaleString()} 条结果。`
      : `已加载 ${state.rows.length.toLocaleString()} 条词条。`;
  }
  render();
}

async function runSemanticSearch() {
  const query = searchInput.value.trim();
  if (!query) {
    statusText.textContent = "请输入语义搜索内容。";
    return;
  }

  if (!state.semanticReady) {
    statusText.textContent = "当前搜索索引里没有可用 embedding，无法直接做语义搜索。";
    return;
  }

  await ensureEmbeddingsLoaded();
  await ensureWorkerLoaded();
  statusText.textContent = "正在计算查询向量…";
  setProgress(50, "query");
  const { vector } = await callWorker("embed-query", { text: query, model: MODEL_ID });

  statusText.textContent = "正在匹配 CSV 中的 embedding…";
  const ranked = state.rows
    .map((row) => ({
      ...row,
      semanticScore: row.embeddingVector ? cosineSimilarity(vector, row.embeddingVector) : -1,
    }))
    .filter((row) => row.semanticScore > 0)
    .sort((a, b) => b.semanticScore - a.semanticScore)
    .slice(0, PREVIEW_LIMIT);

  state.filtered = ranked;
  state.page = 1;
  statusText.textContent = `语义检索完成，使用 CSV 内 embedding 命中 ${ranked.length.toLocaleString()} 条结果。`;
  setProgress(100, "done");
  render();
}

async function runSearch() {
  if (state.mode === "semantic") {
    await runSemanticSearch();
    return;
  }
  runKeywordSearch();
}

function inspectSemanticState() {
  const inlineCount = state.embeddingCount + state.appendEmbeddingCount;
  state.semanticReady = inlineCount > 0;
  if (state.semanticReady) {
    semanticStatus.textContent = state.embeddingsLoaded
      ? `搜索索引中已加载 ${inlineCount.toLocaleString()} 条 ${state.embeddingDtype.toUpperCase()} embedding 向量。`
      : `搜索索引中检测到 ${inlineCount.toLocaleString()} 条 ${state.embeddingDtype.toUpperCase()} embedding，切换到语义搜索时再加载向量。`;
    statusText.textContent = state.embeddingsLoaded
      ? `已加载 ${state.rows.length.toLocaleString()} 条词条与 ${inlineCount.toLocaleString()} 条 ${state.embeddingDtype.toUpperCase()} 向量。`
      : `已加载 ${state.rows.length.toLocaleString()} 条词条，${state.embeddingDtype.toUpperCase()} 语义向量将在需要时再读取。`;
  } else {
    semanticStatus.textContent = "搜索索引中没有检测到可用的 embedding 数据。";
    statusText.textContent = `已加载 ${state.rows.length.toLocaleString()} 条词条，但没有可用 embedding。`;
  }
}

async function loadAppendRows(startId) {
  const response = await fetch(APPEND_CSV_PATH, { cache: "no-store" });
  if (!response.ok) {
    if (response.status === 404) {
      state.appendCount = 0;
      state.appendEmbeddingCount = 0;
      return [];
    }
    throw new Error(`加载 ${APPEND_CSV_PATH} 失败：${response.status}`);
  }

  const raw = await response.text();
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) {
    state.appendCount = 0;
    state.appendEmbeddingCount = 0;
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line, index) => {
    const values = parseCsvLine(line);
    const row = headers.reduce((acc, header, valueIndex) => {
      acc[header] = values[valueIndex] ?? "";
      return acc;
    }, {});
    const embeddingVector = parseEmbeddingJson(row.embedding || "");
    return {
      id: startId + index,
      headword: row.headword || "",
      pinyin_tone: row.pinyin_tone || "",
      pinyin_plain: row.pinyin_plain || "",
      definition: row.definition || "",
      embeddingVector,
    };
  });

  state.appendCount = rows.length;
  state.appendEmbeddingCount = rows.filter((row) => row.embeddingVector).length;
  return rows;
}

async function loadSearchMeta() {
  const response = await fetch(state.searchManifestPath, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`加载 ${state.searchManifestPath} 失败：${response.status}`);
  }

  statusText.textContent = "正在读取搜索索引清单…";
  setProgress(5, "loading");
  state.searchManifest = await response.json();
  state.embeddingDimension = Number(state.searchManifest.dimension || 0);
  state.embeddingCount = Number(state.searchManifest.count || 0);
  state.embeddingDtype = state.searchManifest.dtype || "float32";

  const metaUrl = resolveManifestAssetPath(state.searchManifest.meta);

  statusText.textContent = "正在检查本地元数据缓存…";
  setProgress(20, "meta-cache");

  const { response: metaResponse, fromCache } = await fetchCachedJsonOnce(metaUrl);

  statusText.textContent = fromCache
    ? "正在从本地缓存读取搜索元数据…"
    : "首次下载搜索元数据…";
  setProgress(fromCache ? 35 : 30, fromCache ? "meta-cached" : "meta");

  const metaRows = await metaResponse.json();
  const baseRows = metaRows.map((row, index) => ({
    id: row.id ?? index,
    headword: row.headword || "",
    pinyin_tone: row.pinyin_tone || "",
    pinyin_plain: row.pinyin_plain || "",
    definition: row.definition || "",
    embeddingVector: null,
  }));

  const appendRows = await loadAppendRows(baseRows.length);
  state.rows = baseRows.concat(appendRows);
  state.filtered = [...state.rows];
  setProgress(100, "ready");
  inspectSemanticState();
  render();
}

async function ensureEmbeddingsLoaded() {
  if (state.embeddingsLoaded) {
    return;
  }

  if (!state.searchManifest?.embeddings || !state.embeddingDimension || !state.embeddingCount) {
    throw new Error("搜索索引清单不完整，无法加载 embedding 向量。");
  }

  const embeddingsUrl = resolveManifestAssetPath(state.searchManifest.embeddings);

  statusText.textContent = "正在检查本地语义向量缓存…";
  setProgress(10, "cache");

  const { response, fromCache } = await fetchCachedBinaryOnce(embeddingsUrl);

  statusText.textContent = fromCache
    ? "正在从本地缓存读取语义向量…"
    : "首次下载语义向量文件…";
  setProgress(fromCache ? 40 : 15, fromCache ? "cached" : "vectors");

  const buffer = await response.arrayBuffer();
  const expectedLength = state.embeddingCount * state.embeddingDimension;
  const allVectors = decodeEmbeddingsBuffer(buffer, state.embeddingDtype, expectedLength);

  for (let index = 0; index < state.rows.length; index += 1) {
    if (index >= state.embeddingCount) {
      break;
    }
    const start = index * state.embeddingDimension;
    const end = start + state.embeddingDimension;
    state.rows[index].embeddingVector = allVectors.subarray(start, end);
  }

  state.embeddingsLoaded = true;
  inspectSemanticState();

  statusText.textContent = fromCache
    ? `已从本地缓存加载 ${state.embeddingCount.toLocaleString()} 条 ${state.embeddingDtype.toUpperCase()} 向量。`
    : `语义向量首次下载完成，后续刷新将直接优先使用本地缓存。`;
  setProgress(100, fromCache ? "cached" : "done");
}

searchButton.addEventListener("click", () => {
  runSearch().catch(handleError);
});

searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    runSearch().catch(handleError);
  }
});

clearButton.addEventListener("click", () => {
  searchInput.value = "";
  state.filtered = [...state.rows];
  state.page = 1;
  statusText.textContent = "已清空查询。";
  setProgress(0, "0%");
  render();
  searchInput.focus();
});

copyPinyinCharsButton?.addEventListener("click", () => {
  copyText(COMMON_PINYIN_CHARS, "常用拼音字符已复制。").catch((error) => {
    console.error(error);
    statusText.textContent = "复制常用拼音字符失败。";
  });
});

clearEmbeddingCacheButton?.addEventListener("click", () => {
  clearCachedSearchAssets()
    .then(() => {
      resetMainEmbeddingVectors();
      statusText.textContent = "已删除本地语义缓存，下次会重新下载 meta.json 和 embeddings.bin。";
      setProgress(0, "0%");
    })
    .catch(handleError);
});

keywordModeButton.addEventListener("click", () => {
  setMode("keyword");
  runKeywordSearch();
});

semanticModeButton.addEventListener("click", () => {
  setMode("semantic");
  if (!state.embeddingsLoaded && state.semanticReady) {
    ensureEmbeddingsLoaded().catch(handleError);
  }
});

limitSelect.addEventListener("change", () => {
  state.pageSize = Number(limitSelect.value);
  state.page = 1;
  render();
});

prevButton.addEventListener("click", () => {
  if (state.page > 1) {
    state.page -= 1;
    render();
    scrollResultsToTop();
  }
});

nextButton.addEventListener("click", () => {
  const pageCount = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
  if (state.page < pageCount) {
    state.page += 1;
    render();
    scrollResultsToTop();
  }
});

function handleError(error) {
  console.error(error);
  statusText.textContent = error.message || "发生未知错误";
}

loadSearchMeta().catch((error) => {
  console.error(error);
  statusText.textContent = "搜索数据加载失败";
  results.innerHTML = '<div class="empty-state">请用本地静态服务器打开页面，例如运行 `python3 -m http.server 8000`。</div>';
  resultMeta.textContent = "未加载";
});