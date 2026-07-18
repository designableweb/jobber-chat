import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const MODEL = "claude-sonnet-4-6"; // if the API returns a model error, change this line
const JOBBER_API = "https://api.getjobber.com/api/graphql";
const JOBBER_VERSION = process.env.JOBBER_API_VERSION || "2025-04-16";
const REDIRECT_URI = process.env.JOBBER_REDIRECT_URI || "http://localhost:3000/callback";

// --- OAuth token management ---
let cachedAccessToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  // Reuse cached token if it has more than 2 minutes left
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 120000) {
    return cachedAccessToken;
  }
  const refreshToken = process.env.JOBBER_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error("No JOBBER_REFRESH_TOKEN set. Visit /auth once to authorize.");
  }
  const body = new URLSearchParams({
    client_id: process.env.JOBBER_CLIENT_ID,
    client_secret: process.env.JOBBER_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });
  const r = await fetch("https://api.getjobber.com/api/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) {
    throw new Error("Token refresh failed: " + JSON.stringify(data));
  }
  cachedAccessToken = data.access_token;
  // JWT exp is in the token; default to 60 min if we can't read it
  tokenExpiresAt = Date.now() + 60 * 60 * 1000;
  return cachedAccessToken;
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
  const { firstName, lastName, companyName, email, phone,
          street1, street2, city, province, postalCode, country } = req.body;

  const input = {};
  if (firstName) input.firstName = firstName;
  if (lastName) input.lastName = lastName;
  if (companyName) input.companyName = companyName;
  if (email) input.emails = [{ description: "MAIN", primary: true, address: email }];
  if (phone) input.phones = [{ description: "MAIN", number: phone, primary: true, smsAllowed: true }];

  const addr = {};
  if (street1) addr.street1 = street1;
  if (street2) addr.street2 = street2;
  if (city) addr.city = city;
  if (province) addr.province = province;
  if (postalCode) addr.postalCode = postalCode;
  if (country) addr.country = country;
  if (Object.keys(addr).length) {
    input.billingAddress = addr;
    input.properties = [{ address: addr }];
  }

  const query = `
    mutation CreateClient($input: ClientCreateInput!) {
      clientCreate(input: $input) {
        client {
          id firstName lastName companyName
          clientProperties(first: 1) { nodes { id } }
        }
        userErrors { message path }
      }
    }`;

  try {
    const token = await getAccessToken();
    const r = await fetch(JOBBER_API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${token}`,
        "X-JOBBER-GRAPHQL-VERSION": JOBBER_VERSION
      },
      body: JSON.stringify({ query, variables: { input } })
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 3) Create a quote for the client + property
app.post("/create-quote", async (req, res) => {
  const { clientId, propertyId, lineItemName, unitPrice, quantity } = req.body;

  const attributes = {
    clientId,
    propertyId,
    lineItems: [{
      name: lineItemName || "Service",
      unitPrice: unitPrice ? parseFloat(unitPrice) : 0,
      quantity: quantity ? parseFloat(quantity) : 1,
      saveToProductsAndServices: false
    }]
  };

  const query = `
    mutation CreateQuote($attributes: QuoteCreateAttributes!) {
      quoteCreate(attributes: $attributes) {
        quote { id quoteNumber }
        userErrors { message path }
      }
    }`;

  try {
    const token = await getAccessToken();
    const r = await fetch(JOBBER_API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${token}`,
        "X-JOBBER-GRAPHQL-VERSION": JOBBER_VERSION
      },
      body: JSON.stringify({ query, variables: { attributes } })
    });
    const data = await r.json();
    res.json(data);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));