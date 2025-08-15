// /api/callback.js  (Vercel Serverless Function - CommonJS, Node runtime)

function html(msg, color = "black", title = "Status") {
  return `
  <html>
    <body style="font-family: Arial, sans-serif; text-align:center; padding:40px;">
      <h1 style="color:${color};">${title}</h1>
      <div style="max-width:780px;margin:0 auto;text-align:left;">
        ${msg}
      </div>
      <script>setTimeout(() => window.close(), 7000);</script>
    </body>
  </html>`;
}

function suggestUri(req) {
  const host = process.env.VERCEL_URL || req.headers.host || "YOUR_DOMAIN.vercel.app";
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  return `${proto}://${host}/api/callback`;
}

module.exports = async (req, res) => {
  // --- CORS ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const { code, state, error } = req.query || {};

  if (error) {
    return res
      .status(400)
      .send(html(`Authorization failed: ${String(error)}`, "red", "❌ Authorization Failed"));
  }

  if (!code) {
    return res
      .status(400)
      .send(html("Missing authorization code", "red", "❌ Missing Parameters"));
  }

  // --- Required env vars ---
  const APP_ID = process.env.INSTAGRAM_APP_ID;
  const APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
  const ORBIT_UPDATE_URL = process.env.ORBIT_UPDATE_URL;
  const REDIRECT_URI = process.env.REDIRECT_URI; // MUST be set exactly as this name

  // Debug log for env visibility in Vercel logs
  console.log("ENV scope:", process.env.VERCEL_ENV, "VERCEL_URL:", process.env.VERCEL_URL);
  console.log("ENV has INSTAGRAM_APP_ID:", !!APP_ID, "INSTAGRAM_APP_SECRET:", !!APP_SECRET, "ORBIT_UPDATE_URL:", !!ORBIT_UPDATE_URL, "REDIRECT_URI:", !!REDIRECT_URI);

  if (!APP_ID || !APP_SECRET) {
    return res
      .status(500)
      .send(html(
        "Server not configured: missing <code>INSTAGRAM_APP_ID</code> / <code>INSTAGRAM_APP_SECRET</code>.",
        "red",
        "❌ Server Misconfigured"
      ));
  }
  if (!ORBIT_UPDATE_URL) {
    return res
      .status(500)
      .send(html(
        "Server not configured: missing <code>ORBIT_UPDATE_URL</code>.",
        "red",
        "❌ Server Misconfigured"
      ));
  }
  if (!REDIRECT_URI) {
    const suggestion = suggestUri(req);
    console.error("Missing REDIRECT_URI. Suggested:", suggestion);
    return res
      .status(500)
      .send(html(
        `
        Server not configured: missing <code>REDIRECT_URI</code>.<br><br>
        Set this in <b>Vercel → Project → Settings → Environment Variables (Production)</b><br>
        <ul>
          <li>Name: <code>REDIRECT_URI</code></li>
          <li>Value: <code>${suggestion}</code></li>
        </ul>
        Then redeploy and add this exact URL in <b>Facebook Login → Settings → Valid OAuth Redirect URIs</b>.<br><br>
        <b>Tip:</b> Use the production domain only (avoid preview URLs).`,
        "red",
        "❌ Server Misconfigured: REDIRECT_URI"
      ));
  }

  // --- Decode optional state ---
  let clientId = null;
  if (state) {
    try {
      const parsed = JSON.parse(decodeURIComponent(state));
      clientId = parsed.clientId || null;
    } catch {
      // ignore
    }
  }

  try {
    // 1) Exchange code -> short-lived token (Graph v23.0)
    const tokenParams = new URLSearchParams({
      client_id: APP_ID,
      client_secret: APP_SECRET,
      redirect_uri: REDIRECT_URI, // must match the OAuth dialog's redirect_uri exactly
      code
    });

    const tokenUrl = `https://graph.facebook.com/v23.0/oauth/access_token?${tokenParams.toString()}`;
    console.log("🔍 Token exchange URL:", tokenUrl);

    const tokenResp = await fetch(tokenUrl);
    const tokenTxt = await tokenResp.text();
    let tokenJson;
    try { tokenJson = JSON.parse(tokenTxt); } catch { tokenJson = { raw: tokenTxt }; }

    if (!tokenResp.ok) {
      const msg = tokenJson?.error?.message || "Token exchange failed";
      console.error("❌ Token exchange error body:", tokenTxt);
      return res
        .status(400)
        .send(html(
          `Token exchange failed: ${msg}<br><br>
           Ensure this exact URL is configured in <b>Facebook Login → Valid OAuth Redirect URIs</b>:<br>
           <code>${REDIRECT_URI}</code><br><br>
           <details><summary>Raw error</summary><pre>${String(tokenTxt).replace(/[<>]/g, "")}</pre></details>`,
          "red",
          "❌ Redirect URI / Token Exchange Error"
        ));
    }

    let userAccessToken = tokenJson.access_token;

    // 2) Exchange for long-lived token
    const llParams = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: APP_ID,
      client_secret: APP_SECRET,
      fb_exchange_token: userAccessToken
    });
    const llResp = await fetch(`https://graph.facebook.com/v23.0/oauth/access_token?${llParams.toString()}`);
    const llJson = await llResp.json();
    if (llResp.ok && llJson.access_token) {
      userAccessToken = llJson.access_token;
    }

    // 3) Fetch Pages
    const pagesResp = await fetch(`https://graph.facebook.com/v23.0/me/accounts?access_token=${encodeURIComponent(userAccessToken)}`);
    const pagesJson = await pagesResp.json();
    if (!pagesResp.ok) {
      throw new Error(pagesJson?.error?.message || "Failed to fetch pages");
    }

    // 4) Find Instagram Business Account
    let igAccount = null;
    let pageAccessToken = null;
    let igDetails = null;

    for (const page of pagesJson.data || []) {
      const igResp = await fetch(
        `https://graph.facebook.com/v23.0/${page.id}?fields=instagram_business_account&access_token=${encodeURIComponent(page.access_token)}`
      );
      const igJson = await igResp.json();
      if (igJson?.instagram_business_account?.id) {
        igAccount = igJson.instagram_business_account;
        pageAccessToken = page.access_token;

        const detailsResp = await fetch(
          `https://graph.facebook.com/v23.0/${igAccount.id}?fields=username,profile_picture_url&access_token=${encodeURIComponent(pageAccessToken)}`
        );
        igDetails = await detailsResp.json();
        break;
      }
    }

    if (!igAccount) {
      throw new Error("No Instagram Business Account found. Connect one to a Facebook Page you manage and try again.");
    }

    // 5) Notify your app
    const payload = {
      client_id: clientId,
      instagram_account_id: igAccount.id,
      instagram_access_token: pageAccessToken,
      instagram_account_name: igDetails?.username || null,
      instagram_profile_picture_url: igDetails?.profile_picture_url || null
    };

    const updResp = await fetch(process.env.ORBIT_UPDATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.BASE44_API_KEY ? { Authorization: `Bearer ${process.env.BASE44_API_KEY}` } : {})
      },
      body: JSON.stringify(payload)
    });

    if (!updResp.ok) {
      const t = await updResp.text();
      throw new Error(`Failed to update main app: ${t}`);
    }

    return res
      .status(200)
      .send(html(
        `Instagram account @${igDetails?.username || igAccount.id} connected successfully. You can close this window.`,
        "green",
        "✅ Connected Successfully"
      ));

  } catch (e) {
    console.error("OAuth callback error:", e);
    return res
      .status(500)
      .send(html(String(e?.message || e), "red", "❌ Connection Failed"));
  }
};