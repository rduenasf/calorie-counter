import { GoogleGenAI } from "@google/genai";

const MODEL = "gemini-3.8-flash";
const FALLBACK_MODEL = "gemini-3.6-flash";
const PRIMARY_TIMEOUT_MS = 35000;
const FALLBACK_TIMEOUT_MS = 35000;

const SYSTEM = `You estimate the calories and protein of food for a personal calorie log.
The user gives a short description, which may include a weight, and optionally a photo.
Use the weight when given; otherwise infer a typical portion from the photo or description.
Account for visible cooking oil, sauces, dressings and drinks.
Give a single best-estimate number of kilocalories, and of grams of protein, for everything described or shown, not a range.
Keep "name" short (a few words) and "notes" to one or two sentences explaining the main assumptions.`;

const SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Short name of the food or meal" },
    kcal: { type: "integer", description: "Best estimate of total kilocalories" },
    protein: { type: "integer", description: "Best estimate of total grams of protein" },
    notes: { type: "string", description: "Brief explanation of the assumptions" },
  },
  required: ["name", "kcal", "protein", "notes"],
};

// Downscale the photo before sending: smaller upload, faster response, and the
// model does not need more than ~1568px on the long edge.
export async function prepareImage(file, maxEdge = 1568, quality = 0.85) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  return { base64: dataUrl.split(",")[1], dataUrl };
}

// The SDK's error message is generic; the useful text is in the JSON body,
// which Google sends as either {error:{message}} or [{error:{message}}].
function apiMessage(err) {
  try {
    const body = JSON.parse(err.body);
    const message = (Array.isArray(body) ? body[0] : body)?.error?.message;
    if (message) return message;
  } catch {}
  return String(err?.message ?? "");
}

// An error the user sees; `fallback` marks failures worth retrying on another model.
function fail(message, fallback = false) {
  const err = new Error(message);
  err.fallback = fallback;
  return err;
}

// One request to one model. Resolves to the answer text, or throws a `fail` error.
async function callModel(client, model, timeoutMs, input) {
  // Our own deadline: abort the fetch and stop waiting, since the SDK's
  // timeout option doesn't reliably end a stalled request in the browser.
  const timeoutMessage = `No answer from Gemini after ${timeoutMs / 1000}s. Try again.`;
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(fail(timeoutMessage, true));
    }, timeoutMs);
  });

  let interaction;
  try {
    interaction = await Promise.race([deadline, client.interactions.create(
      {
        model,
        system_instruction: SYSTEM,
        input,
        // A calorie estimate doesn't need deep reasoning; low thinking keeps it fast.
        generation_config: { thinking_level: "low" },
        response_format: { type: "text", mime_type: "application/json", schema: SCHEMA },
      },
      // One quick retry at most, so a rate limit surfaces as an error instead of a long wait.
      { fetch_options: { signal: controller.signal }, retries: { strategy: "attempt-count-backoff", maxRetries: 1, backoff: { initialInterval: 1000, maxInterval: 4000, exponent: 2, maxElapsedTime: 10000 }, retryConnectionErrors: true } },
    )]);
  } catch (err) {
    console.error(`Gemini call failed (${model})`, err);
    if (controller.signal.aborted) throw fail(timeoutMessage, true);
    // The interactions client throws its own error class, so match on status rather than type.
    const status = err?.status;
    const msg = apiMessage(err);
    if (status === 401 || status === 403 || /api key/i.test(msg)) throw fail("Invalid API key. Check it in Settings.");
    // Each model has its own quota, so a rate limit is worth trying elsewhere.
    if (status === 429) throw fail("Rate limited. Try again in a moment.", true);
    if (!status && (err instanceof TypeError || /failed to fetch|unable to make request|network/i.test(msg))) throw fail("Couldn't reach the API. Are you online?");
    // Server errors and an unavailable model are the other cases another model may get past.
    throw fail(status ? `API error ${status}: ${msg}` : msg || "Something went wrong. Try again.", status === 404 || status >= 500);
  } finally {
    clearTimeout(timer);
  }

  if (interaction.status && interaction.status !== "completed") {
    console.error(`Gemini interaction not completed (${model})`, interaction);
    throw fail(`Gemini stopped early (${interaction.status}). Try again.`, true);
  }
  const text = interaction.output_text;
  if (!text) throw fail("The model didn't return an estimate. Try again.", true);
  return text;
}

export async function estimateCalories({ apiKey, description, imageBase64 }) {
  const client = new GoogleGenAI({ apiKey });

  const lines = [];
  if (description) lines.push(`Description: ${description}`);
  if (!description) lines.push("Estimate the calories of the food in the photo.");

  // Text before the image, as the Gemini docs recommend for a single image.
  const input = [{ type: "text", text: lines.join("\n") }];
  if (imageBase64) input.push({ type: "image", data: imageBase64, mime_type: "image/jpeg" });

  // Try the primary model; if it times out or the service fails, ask the
  // fallback model once. Errors the fallback can't fix (bad key, offline) stop here.
  let text;
  try {
    text = await callModel(client, MODEL, PRIMARY_TIMEOUT_MS, input);
  } catch (err) {
    if (!err.fallback) throw err;
    console.warn(`${MODEL} failed, retrying with ${FALLBACK_MODEL}:`, err.message);
    text = await callModel(client, FALLBACK_MODEL, FALLBACK_TIMEOUT_MS, input);
  }
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error("Couldn't read the model's answer. Try again.");
  }
  // The schema isn't strictly enforced, so check the fields before using them.
  const kcal = Number(result.kcal);
  if (!Number.isFinite(kcal)) throw new Error("The model didn't return a calorie number. Try again.");
  // Protein is a bonus: a missing or odd value leaves the field blank rather than failing the estimate.
  const protein = Number(result.protein);
  return {
    name: String(result.name ?? ""),
    kcal: Math.round(kcal),
    protein: result.protein != null && Number.isFinite(protein) && protein >= 0 ? Math.round(protein) : null,
    notes: String(result.notes ?? ""),
  };
}
