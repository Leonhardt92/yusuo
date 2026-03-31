import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

let extractorPromise = null;

async function getExtractor(model) {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", model);
  }
  return extractorPromise;
}

function tensorToVectors(output) {
  if (typeof output.tolist === "function") {
    return output.tolist();
  }

  if (Array.isArray(output)) {
    return output;
  }

  if (output?.data && Array.isArray(output.dims) && output.dims.length === 2) {
    const [rows, cols] = output.dims;
    const vectors = [];
    for (let row = 0; row < rows; row += 1) {
      const start = row * cols;
      vectors.push(Array.from(output.data.slice(start, start + cols)));
    }
    return vectors;
  }

  throw new Error("Unsupported embedding output format.");
}

async function embedTexts(model, texts) {
  const extractor = await getExtractor(model);
  const output = await extractor(texts, {
    pooling: "mean",
    normalize: true,
  });
  return tensorToVectors(output);
}

self.addEventListener("message", async (event) => {
  const { messageId, type, payload } = event.data;

  try {
    if (type === "load-model") {
      await getExtractor(payload.model);
      self.postMessage({ messageId, type: "ok", payload: { ready: true } });
      return;
    }

    if (type === "embed-query") {
      const vectors = await embedTexts(payload.model || "Xenova/bge-small-zh-v1.5", [payload.text]);
      self.postMessage({ messageId, type: "ok", payload: { vector: vectors[0] } });
      return;
    }

    if (type === "embed-documents") {
      const vectors = await embedTexts(payload.model || "Xenova/bge-small-zh-v1.5", payload.texts);
      self.postMessage({ messageId, type: "ok", payload: { vectors } });
    }
  } catch (error) {
    self.postMessage({
      messageId,
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
