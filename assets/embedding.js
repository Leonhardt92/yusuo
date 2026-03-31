const MODEL_ID = "Xenova/bge-small-zh-v1.5";
const ASSET_VERSION = "20260331-5";

const csvRowInput = document.querySelector("#csvRowInput");
const parseCsvRowButton = document.querySelector("#parseCsvRowButton");
const headwordInput = document.querySelector("#headwordInput");
const pinyinToneInput = document.querySelector("#pinyinToneInput");
const pinyinPlainInput = document.querySelector("#pinyinPlainInput");
const definitionInput = document.querySelector("#definitionInput");
const generateButton = document.querySelector("#generateButton");
const suggestPinyinButton = document.querySelector("#suggestPinyinButton");
const fillSampleButton = document.querySelector("#fillSampleButton");
const clearFormButton = document.querySelector("#clearFormButton");
const copyEmbeddingButton = document.querySelector("#copyEmbeddingButton");
const copyCsvRowButton = document.querySelector("#copyCsvRowButton");
const generatorStatus = document.querySelector("#generatorStatus");
const pinyinSuggestionStatus = document.querySelector("#pinyinSuggestionStatus");
const semanticTextPreview = document.querySelector("#semanticTextPreview");
const embeddingOutput = document.querySelector("#embeddingOutput");
const csvPreviewOutput = document.querySelector("#csvPreviewOutput");
const generatorProgressFill = document.querySelector("#generatorProgressFill");
const generatorProgressText = document.querySelector("#generatorProgressText");
const batchSourceInput = document.querySelector("#batchSourceInput");
const batchOutputNameInput = document.querySelector("#batchOutputNameInput");
const batchStartRowInput = document.querySelector("#batchStartRowInput");
const batchLimitInput = document.querySelector("#batchLimitInput");
const exportBatchButton = document.querySelector("#exportBatchButton");
const exportNextBatchButton = document.querySelector("#exportNextBatchButton");
const exportFullBatchButton = document.querySelector("#exportFullBatchButton");
const presetYusuoButton = document.querySelector("#presetYusuoButton");
const presetIdiomButton = document.querySelector("#presetIdiomButton");
const batchStatus = document.querySelector("#batchStatus");
const batchProgressFill = document.querySelector("#batchProgressFill");
const batchProgressText = document.querySelector("#batchProgressText");

let worker = null;
let workerReady = false;
const BATCH_SIZE = 100;
const DEFAULT_EXPORT_LIMIT = 1000;

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

function hasChinese(text) {
  return /[\u3400-\u9fff]/.test(text);
}

function suggestPinyin(applyWhenEmptyOnly = false) {
  const headword = headwordInput.value.trim();
  if (!headword || !hasChinese(headword)) {
    pinyinSuggestionStatus.textContent = "当前词条不是中文，暂时不给出拼音建议。";
    return;
  }

  if (!window.pinyinPro?.pinyin) {
    pinyinSuggestionStatus.textContent = "拼音建议库未加载成功。";
    return;
  }

  const tone = window.pinyinPro.pinyin(headword, { type: "array" }).join("");
  const plain = window.pinyinPro.pinyin(headword, { toneType: "none", type: "array" }).join("");

  const toneEmpty = !pinyinToneInput.value.trim();
  const plainEmpty = !pinyinPlainInput.value.trim();
  const shouldApply = !applyWhenEmptyOnly || toneEmpty || plainEmpty;

  if (shouldApply) {
    if (!applyWhenEmptyOnly || toneEmpty) {
      pinyinToneInput.value = tone;
    }
    if (!applyWhenEmptyOnly || plainEmpty) {
      pinyinPlainInput.value = plain;
    }
  }

  pinyinSuggestionStatus.textContent = `建议拼音：${tone} / ${plain}。你可以直接使用，也可以手动修改。`;
}

function parseExistingCsvRow() {
  const raw = csvRowInput.value.trim();
  if (!raw) {
    generatorStatus.textContent = "请先粘贴一整行 CSV。";
    return;
  }

  const values = parseCsvLine(raw);
  if (values.length < 4) {
    generatorStatus.textContent = "这一行看起来不是有效的词条 CSV。";
    return;
  }

  headwordInput.value = values[0] ?? "";
  pinyinToneInput.value = values[1] ?? "";
  pinyinPlainInput.value = values[2] ?? "";
  definitionInput.value = values[3] ?? "";
  embeddingOutput.value = values[4] ?? "";
  csvPreviewOutput.value = raw;
  semanticTextPreview.textContent = buildSemanticText() || "尚未生成。";

  if (!pinyinToneInput.value.trim() || !pinyinPlainInput.value.trim()) {
    suggestPinyin(true);
  }

  generatorStatus.textContent = "CSV 行已解析，你可以直接修改 definition 或拼音后重新生成。";
}

function setProgress(percent, label = `${percent}%`) {
  generatorProgressFill.style.width = `${percent}%`;
  generatorProgressText.textContent = label;
}

function setBatchProgress(percent, label = `${percent}%`) {
  batchProgressFill.style.width = `${percent}%`;
  batchProgressText.textContent = label;
}

function buildSemanticText() {
  return [
    headwordInput.value.trim(),
    definitionInput.value.trim(),
  ]
    .filter(Boolean)
    .join("；");
}

function buildSemanticTextFromRow(row) {
  return [
    (row.headword || "").trim(),
    (row.definition || "").trim(),
  ]
    .filter(Boolean)
    .join("；");
}

function csvCell(value) {
  const text = value ?? "";
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function rowToCsv(headers, row) {
  return headers.map((header) => csvCell(row[header] ?? "")).join(",");
}

function parseCsvText(raw) {
  const normalized = raw.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return headers.reduce((acc, header, index) => {
      acc[header] = values[index] ?? "";
      return acc;
    }, {});
  });
  return { headers, rows };
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function buildChunkedFilename(filename, startRow, endRow) {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex === -1) {
    return `${filename}.rows-${startRow}-${endRow}.csv`;
  }

  const base = filename.slice(0, dotIndex);
  const extension = filename.slice(dotIndex);
  return `${base}.rows-${startRow}-${endRow}${extension}`;
}

function buildFullFilename(filename, startRow) {
  if (startRow <= 1) {
    return filename;
  }

  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex === -1) {
    return `${filename}.from-${startRow}.csv`;
  }

  const base = filename.slice(0, dotIndex);
  const extension = filename.slice(dotIndex);
  return `${base}.from-${startRow}${extension}`;
}

function applyBatchPreset({ source, outputName, startRow = 1, limit = DEFAULT_EXPORT_LIMIT, status }) {
  batchSourceInput.value = source;
  batchOutputNameInput.value = outputName;
  batchStartRowInput.value = String(startRow);
  batchLimitInput.value = String(limit);
  batchStatus.textContent = status;
  setBatchProgress(0, "0%");
}

function createWorker() {
  if (!worker) {
    worker = new Worker(`./assets/worker.js?v=${ASSET_VERSION}`, { type: "module" });
  }
  return worker;
}

function callWorker(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const currentWorker = createWorker();
    const messageId = `${type}-${crypto.randomUUID()}`;

    const handleMessage = (event) => {
      const message = event.data;
      if (message.messageId !== messageId) {
        return;
      }
      currentWorker.removeEventListener("message", handleMessage);
      if (message.type === "error") {
        reject(new Error(message.error));
        return;
      }
      resolve(message.payload);
    };

    currentWorker.addEventListener("message", handleMessage);
    currentWorker.postMessage({ messageId, type, payload });
  });
}

async function ensureWorkerLoaded() {
  if (workerReady) {
    return;
  }
  generatorStatus.textContent = "正在加载模型…";
  setProgress(20, "loading");
  await callWorker("load-model", { model: MODEL_ID });
  workerReady = true;
  generatorStatus.textContent = "模型已就绪，可以开始生成。";
  setProgress(100, "ready");
}

async function generateEmbedding() {
  const semanticText = buildSemanticText();
  if (!semanticText) {
    generatorStatus.textContent = "请先填写至少一个字段。";
    return;
  }

  semanticTextPreview.textContent = semanticText;
  embeddingOutput.value = "";
  csvPreviewOutput.value = "";

  await ensureWorkerLoaded();
  generatorStatus.textContent = "正在生成 embedding…";
  setProgress(55, "embedding");

  const { vectors } = await callWorker("embed-documents", {
    texts: [semanticText],
    model: MODEL_ID,
  });

  const embeddingJson = JSON.stringify(vectors[0]);
  embeddingOutput.value = embeddingJson;

  const csvRow = [
    csvCell(headwordInput.value.trim()),
    csvCell(pinyinToneInput.value.trim()),
    csvCell(pinyinPlainInput.value.trim()),
    csvCell(definitionInput.value.trim()),
    csvCell(embeddingJson),
  ].join(",");

  csvPreviewOutput.value = csvRow;
  generatorStatus.textContent = "embedding 生成完成。";
  setProgress(100, "done");
}

async function exportBatchCsv({ advanceToNext = false } = {}) {
  const source = (batchSourceInput.value || "./data/ci.csv").trim();
  const outputName = (batchOutputNameInput.value || "ci.with_embeddings.csv").trim();
  const startRow = Math.max(1, Number(batchStartRowInput.value || 1));
  const limit = Math.max(1, Number(batchLimitInput.value || DEFAULT_EXPORT_LIMIT));

  batchStatus.textContent = "正在读取源 CSV…";
  setBatchProgress(5, "loading");

  const response = await fetch(source, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`读取 CSV 失败：${response.status}`);
  }

  const raw = await response.text();
  const { headers, rows } = parseCsvText(raw);

  if (!headers.includes("embedding")) {
    headers.push("embedding");
    for (const row of rows) {
      row.embedding = "";
    }
  }

  const startIndex = Math.min(rows.length, startRow - 1);
  const slicedRows = rows.slice(startIndex);
  const targetRows = slicedRows.slice(0, limit);
  if (!targetRows.length) {
    throw new Error("没有可导出的数据。");
  }

  await ensureWorkerLoaded();
  batchStatus.textContent = `开始分段生成，从第 ${startRow} 行开始，本次共 ${targetRows.length} 条…`;
  setBatchProgress(10, "starting");

  for (let offset = 0; offset < targetRows.length; offset += BATCH_SIZE) {
    const batch = targetRows.slice(offset, offset + BATCH_SIZE);
    const texts = batch.map(buildSemanticTextFromRow);
    const { vectors } = await callWorker("embed-documents", {
      texts,
      model: MODEL_ID,
    });

    for (let index = 0; index < batch.length; index += 1) {
      batch[index].embedding = JSON.stringify(vectors[index]);
    }

    const done = offset + batch.length;
    const percent = 10 + Math.round((done / targetRows.length) * 85);
    batchStatus.textContent = `正在生成 embedding：${done}/${targetRows.length}`;
    setBatchProgress(percent, `${done}/${targetRows.length}`);

    // Give the browser time to paint between batches so large exports feel steadier.
    await sleep(0);
  }

  const endRow = startRow + targetRows.length - 1;
  const exportName = buildChunkedFilename(outputName, startRow, endRow);
  const csvText = `\uFEFF${headers.map(csvCell).join(",")}\n${targetRows.map((row) => rowToCsv(headers, row)).join("\n")}\n`;
  downloadTextFile(exportName, csvText);

  if (advanceToNext) {
    batchStartRowInput.value = String(endRow + 1);
    batchStatus.textContent = `导出完成：${exportName}。已跳到下一段起始行 ${endRow + 1}。`;
  } else {
    batchStatus.textContent = `导出完成：${exportName}`;
  }
  setBatchProgress(100, "done");
}

async function writeRemainingCsvToFile() {
  if (typeof window.showSaveFilePicker !== "function") {
    throw new Error("当前浏览器不支持直接流式写文件，请继续使用分段导出。");
  }

  const source = (batchSourceInput.value || "./data/ci.csv").trim();
  const outputName = (batchOutputNameInput.value || "ci.with_embeddings.csv").trim();
  const startRow = Math.max(1, Number(batchStartRowInput.value || 1));

  batchStatus.textContent = "正在读取源 CSV…";
  setBatchProgress(5, "loading");

  const response = await fetch(source, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`读取 CSV 失败：${response.status}`);
  }

  const raw = await response.text();
  const { headers, rows } = parseCsvText(raw);
  if (!headers.includes("embedding")) {
    headers.push("embedding");
    for (const row of rows) {
      row.embedding = "";
    }
  }

  const startIndex = Math.min(rows.length, startRow - 1);
  const targetRows = rows.slice(startIndex);
  if (!targetRows.length) {
    throw new Error("没有可导出的数据。");
  }

  await ensureWorkerLoaded();

  const suggestedName = buildFullFilename(outputName, startRow);
  const handle = await window.showSaveFilePicker({
    suggestedName,
    types: [
      {
        description: "CSV file",
        accept: {
          "text/csv": [".csv"],
        },
      },
    ],
  });

  const writable = await handle.createWritable();

  try {
    await writable.write(`\uFEFF${headers.map(csvCell).join(",")}\n`);
    batchStatus.textContent = `开始完整写入，从第 ${startRow} 行开始，共 ${targetRows.length} 条…`;
    setBatchProgress(10, "starting");

    for (let offset = 0; offset < targetRows.length; offset += BATCH_SIZE) {
      const batch = targetRows.slice(offset, offset + BATCH_SIZE);
      const texts = batch.map(buildSemanticTextFromRow);
      const { vectors } = await callWorker("embed-documents", {
        texts,
        model: MODEL_ID,
      });

      for (let index = 0; index < batch.length; index += 1) {
        batch[index].embedding = JSON.stringify(vectors[index]);
      }

      const chunkText = `${batch.map((row) => rowToCsv(headers, row)).join("\n")}\n`;
      await writable.write(chunkText);

      const done = offset + batch.length;
      const percent = 10 + Math.round((done / targetRows.length) * 85);
      batchStatus.textContent = `正在写入完整 CSV：${done}/${targetRows.length}`;
      setBatchProgress(percent, `${done}/${targetRows.length}`);

      await sleep(0);
    }

    await writable.close();
    batchStatus.textContent = `完整导出完成：${suggestedName}`;
    setBatchProgress(100, "done");
  } catch (error) {
    await writable.abort();
    throw error;
  }
}

async function copyText(value, successText) {
  if (!value) {
    return;
  }
  await navigator.clipboard.writeText(value);
  generatorStatus.textContent = successText;
}

generateButton.addEventListener("click", () => {
  generateEmbedding().catch((error) => {
    console.error(error);
    generatorStatus.textContent = error.message || "生成失败";
  });
});

parseCsvRowButton.addEventListener("click", () => {
  parseExistingCsvRow();
});

suggestPinyinButton.addEventListener("click", () => {
  suggestPinyin(false);
});

headwordInput.addEventListener("blur", () => {
  suggestPinyin(true);
});

fillSampleButton.addEventListener("click", () => {
  headwordInput.value = "阿姨";
  pinyinToneInput.value = "";
  pinyinPlainInput.value = "";
  definitionInput.value = "称呼跟母亲辈分相同、年纪差不多的无亲属关系的妇女。";
  suggestPinyin(false);
  semanticTextPreview.textContent = buildSemanticText();
  generatorStatus.textContent = "已填入示例数据。";
  setProgress(0, "0%");
});

clearFormButton.addEventListener("click", () => {
  csvRowInput.value = "";
  headwordInput.value = "";
  pinyinToneInput.value = "";
  pinyinPlainInput.value = "";
  definitionInput.value = "";
  embeddingOutput.value = "";
  csvPreviewOutput.value = "";
  semanticTextPreview.textContent = "尚未生成。";
  pinyinSuggestionStatus.textContent = "输入中文词条后，可以自动补出拼音建议。";
  generatorStatus.textContent = "已清空。";
  setProgress(0, "0%");
});

copyEmbeddingButton.addEventListener("click", () => {
  copyText(embeddingOutput.value, "embedding 已复制。").catch((error) => {
    console.error(error);
    generatorStatus.textContent = "复制 embedding 失败";
  });
});

copyCsvRowButton.addEventListener("click", () => {
  copyText(csvPreviewOutput.value, "CSV 行已复制。").catch((error) => {
    console.error(error);
    generatorStatus.textContent = "复制 CSV 行失败";
  });
});

exportBatchButton.addEventListener("click", () => {
  exportBatchCsv().catch((error) => {
    console.error(error);
    batchStatus.textContent = error.message || "批量导出失败";
    setBatchProgress(0, "error");
  });
});

exportNextBatchButton.addEventListener("click", () => {
  exportBatchCsv({ advanceToNext: true }).catch((error) => {
    console.error(error);
    batchStatus.textContent = error.message || "批量导出失败";
    setBatchProgress(0, "error");
  });
});

exportFullBatchButton?.addEventListener("click", () => {
  writeRemainingCsvToFile().catch((error) => {
    console.error(error);
    batchStatus.textContent = error.message || "完整导出失败";
    setBatchProgress(0, "error");
  });
});

presetYusuoButton?.addEventListener("click", () => {
  applyBatchPreset({
    source: "./data/ci.csv",
    outputName: "ci.with_embeddings.csv",
    status: "已切换到 ci.csv 批量导出预设。",
  });
});

presetIdiomButton?.addEventListener("click", () => {
  applyBatchPreset({
    source: "./data/idiom.csv",
    outputName: "idiom.with_embeddings.csv",
    status: "已切换到 idiom.csv 批量导出预设。",
  });
});
