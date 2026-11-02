import { GoogleGenAI } from "@google/genai";

const MODEL = "gemini-3.8-flash";

const SYSTEM = `You estimate the calories of food for a personal calorie log.
The user gives a short description, optionally a weight, and optionally a photo.
Use the weight when given; otherwise infer a typical portion from the photo or description.
Account for visible cooking oil, sauces, dressings and drinks.
Give a single best-estimate number of kilocalories for everything described or shown, not a range.
Keep "name" short (a few words) and "notes" to one or two sentences explaining the main assumptions.`;

const SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Short name of the food or meal" },
    kcal: { type: "integer", description: "Best estimate of total kilocalories" },
    notes: { type: "string", description: "Brief explanation of the assumptions" },
  },
  required: ["name", "kcal", "notes"],
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

export async function estimateCalories({ apiKey, description, weight, imageBase64 }) {
  const client = new GoogleGenAI({ apiKey });

  const lines = [];
  if (description) lines.push(`Description: ${description}`);
  if (weight) lines.push(`Weight: ${weight}`);
  if (!description && !weight) lines.push("Estimate the calories of the food in the photo.");

  // Text before the image, as the Gemini docs recommend for a single image.
  const input = [{ type: "text", text: lines.join("\n") }];
  if (imageBase64) input.push({ type: "image", data: imageBase64, mime_type: "image/jpeg" });

  let interaction;
  try {
    interaction = await client.interactions.create({
      model: MODEL,
      system_instruction: SYSTEM,
      input,
      response_format: { type: "text", mime_type: "application/json", schema: SCHEMA },
    });
  } catch (err) {
    // The interactions client throws its own error class, so match on status rather than type.
    const status = err?.status;
    const msg = String(err?.message ?? "");
    if (status === 401 || status === 403 || /api key/i.test(msg)) throw new Error("Invalid API key. Check it in Settings.");
    if (status === 429) throw new Error("Rate limited. Try again in a moment.");
    if (!status && (err instanceof TypeError || /failed to fetch|unable to make request|network/i.test(msg))) throw new Error("Couldn't reach the API. Are you online?");
    throw new Error(status ? `API error ${status}: ${msg}` : msg || "Something went wrong. Try again.");
  }

  const text = interaction.output_text;
  if (!text) throw new Error("The model didn't return an estimate. Try again.");
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error("Couldn't read the model's answer. Try again.");
  }
  // The schema isn't strictly enforced, so check the fields before using them.
  const kcal = Number(result.kcal);
  if (!Number.isFinite(kcal)) throw new Error("The model didn't return a calorie number. Try again.");
  return { name: String(result.name ?? ""), kcal: Math.round(kcal), notes: String(result.notes ?? "") };
}
