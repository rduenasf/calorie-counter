import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";

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
  additionalProperties: false,
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

// Small thumbnail kept with the log entry.
export async function makeThumb(file) {
  const { dataUrl } = await prepareImage(file, 160, 0.7);
  return dataUrl;
}

export async function estimateCalories({ apiKey, description, weight, imageBase64 }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const lines = [];
  if (description) lines.push(`Description: ${description}`);
  if (weight) lines.push(`Weight: ${weight}`);
  if (!description && !weight) lines.push("Estimate the calories of the food in the photo.");

  const content = [];
  if (imageBase64) {
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } });
  }
  content.push({ type: "text", text: lines.join("\n") });

  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error("Invalid API key. Check it in Settings.");
    if (err instanceof Anthropic.RateLimitError) throw new Error("Rate limited. Try again in a moment.");
    if (err instanceof Anthropic.APIConnectionError) throw new Error("Couldn't reach the API. Are you online?");
    if (err instanceof Anthropic.APIError) throw new Error(`API error ${err.status ?? ""}: ${err.message}`);
    throw err;
  }

  if (response.stop_reason === "refusal") throw new Error("The model declined to estimate this one.");
  if (response.stop_reason === "max_tokens") throw new Error("The response was cut off. Try again.");

  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const result = JSON.parse(text);
  return { name: result.name, kcal: Math.round(result.kcal), notes: result.notes };
}
