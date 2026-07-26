import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const MODEL = "claude-sonnet-4-6"; // if the API returns a model error, change this line
const REALTIME_MODEL = "gpt-realtime"; // if the API returns a model error, change this line
const REALTIME_VOICE = "cedar"; // try "marin" or "alloy" if this one is rejected
const JOBBER_API = "https://api.getjobber.com/api/graphql";
const JOBBER_VERSION = process.env.JOBBER_API_VERSION || "2025-04-16";
const REDIRECT_URI = process.env.JOBBER_REDIRECT_URI || "http://localhost:3000/callback";

// --- OAuth token management ---
let cachedAccessToken = null;
let tokenExpiresAt = 0;
let currentRefreshToken = process.env.JOBBER_REFRESH_TOKEN || null;

async function getAccessToken() {
  // Reuse cached token if it has more than 2 minutes left
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 120000) {
    return cachedAccessToken;
  }
  if (!currentRefreshToken) {
    throw new Error("No JOBBER_REFRESH_TOKEN set. Visit /auth once to authorize.");
  }
  const body = new URLSearchParams({
    client_id: process.env.JOBBER_CLIENT_ID,
    client_secret: process.env.JOBBER_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: currentRefreshToken
  });
  const r = await fetch("https://api.getjobber.com/api/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Jobber token endpoint returned non-JSON (HTTP ${r.status}): ${text.slice(0, 300)}`);
  }
  if (!r.ok || !data.access_token) {
    throw new Error("Token refresh failed: " + JSON.stringify(data));
  }
  // Rotation ON returns a NEW refresh token; the old one is dead. Keep the new one.
  if (data.refresh_token && data.refresh_token !== currentRefreshToken) {
    currentRefreshToken = data.refresh_token;
    console.log("\n=== ROTATED REFRESH TOKEN (update JOBBER_REFRESH_TOKEN) ===");
    console.log(currentRefreshToken + "\n");
  }
  if (data.warning) console.log("Jobber token warning:", data.warning);
  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + 60 * 60 * 1000;
  return cachedAccessToken;
}

// --- Shared Jobber GraphQL helper ---
async function jobberGraphQL(query, variables) {
  const token = await getAccessToken();
  const r = await fetch(JOBBER_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Authorization": `Bearer ${token}`,
      "X-JOBBER-GRAPHQL-VERSION": JOBBER_VERSION
    },
    body: JSON.stringify({ query, variables })
  });
  const text = await r.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Jobber returned non-JSON (HTTP ${r.status}): ${text.slice(0, 300)}`);
  }
  if (payload.errors?.length) {
    throw new Error(payload.errors.map(e => e.message).join("; "));
  }
  return payload.data;
}

const CLIENT_CREATE_MUTATION = `
  mutation CreateClient($input: ClientCreateInput!) {
    clientCreate(input: $input) {
      client {
        id firstName lastName companyName
        clientProperties(first: 1) { nodes { id } }
      }
      userErrors { message path }
    }
  }`;

const QUOTE_CREATE_MUTATION = `
  mutation CreateQuote($attributes: QuoteCreateAttributes!) {
    quoteCreate(attributes: $attributes) {
      quote { id quoteNumber }
      userErrors { message path }
    }
  }`;

function buildClientInput(a) {
  const input = {};
  if (a.firstName) input.firstName = a.firstName;
  if (a.lastName) input.lastName = a.lastName;
  if (a.companyName) input.companyName = a.companyName;
  if (a.email) input.emails = [{ description: "MAIN", primary: true, address: a.email }];
  if (a.phone) input.phones = [{ description: "MAIN", number: a.phone, primary: true, smsAllowed: true }];

  const addr = {};
  if (a.street1) addr.street1 = a.street1;
  if (a.street2) addr.street2 = a.street2;
  if (a.city) addr.city = a.city;
  if (a.province) addr.province = a.province;
  if (a.postalCode) addr.postalCode = a.postalCode;
  if (a.country) addr.country = a.country;
  if (Object.keys(addr).length) {
    input.billingAddress = addr;
    input.properties = [{ address: addr }];
  }
  return input;
}

function buildQuoteAttributes(a) {
  return {
    clientId: a.clientId,
    propertyId: a.propertyId,
    lineItems: [{
      name: a.lineItemName || "Service",
      unitPrice: a.unitPrice ? parseFloat(a.unitPrice) : 0,
      quantity: a.quantity ? parseFloat(a.quantity) : 1,
      saveToProductsAndServices: false
    }]
  };
}

// Step 1: kick off authorization (visit this once in your browser)
app.get("/auth", (req, res) => {
  const url = "https://api.getjobber.com/api/oauth/authorize"
    + "?response_type=code"
    + "&client_id=" + encodeURIComponent(process.env.JOBBER_CLIENT_ID)
    + "&redirect_uri=" + encodeURIComponent(REDIRECT_URI)
    + "&state=demo123";
  res.redirect(url);
});

// Step 2: Jobber redirects here with the code; exchange it for tokens
app.get("/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send("No code received.");
  if (state !== "demo123") return res.status(400).send("State mismatch.");
  try {
    const body = new URLSearchParams({
      client_id: process.env.JOBBER_CLIENT_ID,
      client_secret: process.env.JOBBER_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI
    });
    const r = await fetch("https://api.getjobber.com/api/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const data = await r.json();
    if (!data.refresh_token) {
      return res.status(500).send("No refresh token returned: " + JSON.stringify(data));
    }
    // Cache the access token now, and print the refresh token for you to save
    cachedAccessToken = data.access_token;
    tokenExpiresAt = Date.now() + 60 * 60 * 1000;
    currentRefreshToken = data.refresh_token;
    console.log("\n=== SAVE THIS REFRESH TOKEN ===");
    console.log(data.refresh_token);
    console.log("Set it as JOBBER_REFRESH_TOKEN and restart.\n");
    res.send("Authorized. Check your terminal for the refresh token, then set JOBBER_REFRESH_TOKEN and restart.");
  } catch (e) {
    res.status(500).send("Auth error: " + String(e));
  }
});

// 1) Parse plain English into structured client fields
app.post("/parse", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "No text provided" });

  const system = `You extract new-client details from a service contractor's plain-English request.
Return ONLY a JSON object, no markdown, no commentary, with exactly these keys:
{"firstName":"","lastName":"","companyName":"","email":"","phone":"","street1":"","street2":"","city":"","province":"","postalCode":"","country":"","lineItemName":"","unitPrice":"","quantity":""}
Rules:
- Fill only what is explicitly stated. If something is not mentioned, use an empty string.
- Do NOT invent names, emails, or companies. Never guess an email address. Spoken emails may contain "at" for @ and "dot" for . — convert them (e.g. "dave at miller plumbing dot com" becomes "dave@millerplumbing.com"), and remove spaces inside the email.
- If the person clearly represents a business, put it in companyName; otherwise leave it blank.
- For province use the 2-letter state code (e.g. "NJ"). If a US address is given but country is unstated, set country to "United States".
- Never invent a phone number or street address.
- lineItemName is the work being quoted (e.g. "Water heater replacement"). unitPrice is a number only, no dollar sign. If a price is mentioned, use it; if quantity is not mentioned, use "1". If no work/price is mentioned, leave these blank.`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system,
        messages: [{ role: "user", content: text }]
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: "Anthropic error", detail: data });

    const raw = (data.content?.[0]?.text || "").trim().replace(/```json|```/g, "").trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return res.status(500).json({ error: "Could not parse model output", raw }); }
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 2) Create the client in Jobber
app.post("/create-client", async (req, res) => {
  const { firstName, lastName, companyName } = req.body;
  // Guard: Jobber needs at least a name or company, or it errors
  if (!firstName && !lastName && !companyName) {
    return res.status(400).json({
      error: "A client needs at least a first name, last name, or company. Please add a name and try again."
    });
  }
  try {
    const data = await jobberGraphQL(CLIENT_CREATE_MUTATION, { input: buildClientInput(req.body) });
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 3) Create a quote for the client + property
app.post("/create-quote", async (req, res) => {
  try {
    const data = await jobberGraphQL(QUOTE_CREATE_MUTATION, { attributes: buildQuoteAttributes(req.body) });
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 4) Transcribe audio via Groq Whisper
app.post("/transcribe", express.raw({ type: "audio/*", limit: "25mb" }), async (req, res) => {
  if (!process.env.GROQ_API_KEY) {
    return res.status(401).json({ error: "No Groq key set. Set GROQ_API_KEY and restart." });
  }
  try {
    const form = new FormData();
    form.append("file", new Blob([req.body], { type: "audio/webm" }), "audio.webm");
    form.append("model", "whisper-large-v3-turbo");

    const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
      body: form
    });
    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: "Groq error", detail: data });
    res.json({ text: data.text || "" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ============================================================
// VOICE AGENT
// ============================================================

const AGENT_INSTRUCTIONS = `You are a job intake assistant for a service contractor using Jobber. The contractor is talking to you hands-free, often from a truck or a job site.

Your job is to collect what's needed to create a client and a quote in Jobber, then create them.

How to talk:
- Be brief. One or two sentences per turn. This is a conversation, not a form.
- Ask for one missing piece of information at a time.
- Never invent a name, phone number, email address, or street address. If you did not hear something clearly, ask again.
- Spoken emails often use "at" for @ and "dot" for the period. Convert them and remove spaces: "dave at miller plumbing dot com" becomes "dave@millerplumbing.com". Always read an email address back to confirm it.
- Use the 2-letter state code for province, for example "NJ". If a US address is given and no country is stated, use "United States".

Before creating a client you need at least a first name, last name, or company name. Phone and service address are optional but ask for them if they weren't given.

Before creating a quote you need the clientId and propertyId returned by create_client, plus a description of the work and a price.

Confirmation rule, no exceptions: before calling create_client or create_quote, read back everything you have collected and ask the contractor to confirm out loud. Only after they clearly say yes do you call the tool with confirmed set to true. If they correct something, update it and read it back again.

After a tool succeeds, say what was created in one short sentence, including the quote number if there is one. If a tool comes back with ok set to false, explain the problem in plain language and ask what they want to do.`;

const TOOL_DEFS = [
  {
    type: "function",
    name: "create_client",
    description: "Create a new client and their service property in Jobber. Only call after the contractor has verbally confirmed the details.",
    parameters: {
      type: "object",
      properties: {
        firstName: { type: "string" },
        lastName: { type: "string" },
        companyName: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        street1: { type: "string" },
        street2: { type: "string" },
        city: { type: "string" },
        province: { type: "string", description: "2-letter state code, e.g. NJ" },
        postalCode: { type: "string" },
        country: { type: "string" },
        confirmed: { type: "boolean", description: "True only after the contractor verbally confirmed these details." }
      },
      required: ["confirmed"]
    }
  },
  {
    type: "function",
    name: "create_quote",
    description: "Create a quote in Jobber for an existing client and property. Only call after the contractor has verbally confirmed the work and price.",
    parameters: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "The clientId returned by create_client." },
        propertyId: { type: "string", description: "The propertyId returned by create_client." },
        lineItemName: { type: "string", description: "The work being quoted, e.g. Water heater replacement" },
        unitPrice: { type: "number" },
        quantity: { type: "number" },
        confirmed: { type: "boolean", description: "True only after the contractor verbally confirmed the work and price." }
      },
      required: ["clientId", "propertyId", "lineItemName", "confirmed"]
    }
  }
];

// Mint a short-lived credential for the browser. Your OpenAI key never leaves the server.
app.get("/session", async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(401).json({ error: "No OPENAI_API_KEY set." });
  }
  try {
    const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: REALTIME_MODEL,
          instructions: AGENT_INSTRUCTIONS,
          tools: TOOL_DEFS,
          audio: { output: { voice: REALTIME_VOICE } }
        }
      })
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(500).json({ error: `OpenAI returned non-JSON (HTTP ${r.status}): ${text.slice(0, 300)}` });
    }
    if (!r.ok) return res.status(500).json({ error: "OpenAI session error", detail: data });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Tool execution. Always returns HTTP 200 with an ok flag so the agent
// gets something readable to say instead of choking on an error status.
app.post("/tool/:name", async (req, res) => {
  const name = req.params.name;
  const a = req.body || {};
  console.log(`[tool] ${name}`, JSON.stringify(a));

  try {
    if (name === "create_client") {
      if (a.confirmed !== true) {
        return res.json({ ok: false, error: "Not confirmed. Read the details back to the contractor and get a verbal yes first." });
      }
      if (!a.firstName && !a.lastName && !a.companyName) {
        return res.json({ ok: false, error: "A client needs at least a first name, last name, or company name." });
      }
      const data = await jobberGraphQL(CLIENT_CREATE_MUTATION, { input: buildClientInput(a) });
      const errs = data.clientCreate?.userErrors || [];
      if (errs.length) return res.json({ ok: false, error: errs.map(e => e.message).join("; ") });

      const c = data.clientCreate.client;
      return res.json({
        ok: true,
        clientId: c.id,
        propertyId: c.clientProperties?.nodes?.[0]?.id || null,
        name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || "client"
      });
    }

    if (name === "create_quote") {
      if (a.confirmed !== true) {
        return res.json({ ok: false, error: "Not confirmed. Read the work and price back to the contractor and get a verbal yes first." });
      }
      if (!a.clientId || !a.propertyId) {
        return res.json({ ok: false, error: "Missing clientId or propertyId. Create the client first." });
      }
      const data = await jobberGraphQL(QUOTE_CREATE_MUTATION, { attributes: buildQuoteAttributes(a) });
      const errs = data.quoteCreate?.userErrors || [];
      if (errs.length) return res.json({ ok: false, error: errs.map(e => e.message).join("; ") });

      const q = data.quoteCreate.quote;
      return res.json({ ok: true, quoteId: q.id, quoteNumber: q.quoteNumber });
    }

    return res.json({ ok: false, error: `Unknown tool: ${name}` });
  } catch (e) {
    console.error(`[tool] ${name} failed:`, e);
    return res.json({ ok: false, error: String(e.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));