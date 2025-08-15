// /api/callback.js (Vercel Serverless Function - CommonJS)

function html(msg, color = "black", title = "Status") {
  return `
  <html>
    <body style="font-family: Arial, sans-serif; text-align:center; padding:40px;">
      <h1 style="color:${color};">${title}</h1>
      <p>${msg}</p>
      <script>setTimeout(() => window.close(), 8000);</script>
    </body>
  </html>`;
}

function computeRedirectUri(req) {
  if (process.env.REDIRECT_URI) return process.env.REDIRECT_URI;

  const host = process.env.VERCEL_URL || req.headers.host;
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
    // Special case: Show redirect URL if FB says domain not allowed
    if (String(error).toLowerCase().includes("url isn't included")) {
      const redirectUrl = computeRedirectUri(req);
      return res.status(400).send(
        html(
          `❌ Domain not allowed in Facebook App.<br><br>
          Add this URL to your <strong>Facebook App → Settings → Valid OAuth Redirect URIs</strong>:<br><br>
          <code>${redirectUrl}</code>`,
          "red",
          "❌ App Domain Not Configured"
        )
      );
    }
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

  if (!APP_ID || !APP_SECRET) {
    return res
      .status(500)
      .send(html("Server not configured: missing INSTAGRAM_APP_ID/SECRET", "red", "❌ Server Misconfigured"));
  }
  if (!ORBIT_UPDATE_URL) {
    return res
      .status(500)
      .send(html("Server not configured: missing ORBIT_UPDATE_URL", "red", "❌ Server Misconfigured"));
  }

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
    const redirectUri = computeRedirectUri(req);

    // 1) Exchange code for short-lived token
    const params = new URLSearchParams({
      client_id: APP_ID,
      client_secret: APP_SECRET,
      redirect_uri: redirectUri,
      code
    });

    const tokenResp = await fetch(`https://graph.facebook.com/v23.0/oauth/access_token?${params.toString()}`);
    const tokenJson = await tokenResp.json();

    if (!tokenResp.ok) {
      // Detect misconfigured redirect URI and show it
      if (tokenJson?.error?.message?.toLowerCase().includes("url isn't included")) {
        return res.status(400).send(
          html(
            `❌ Domain not allowed in Facebook App.<br><br>
            Add this URL to your <strong>Facebook App → Settings → Valid OAuth Redirect URIs</strong>:<br><br>
            <code>${redirectUri}</code>`,
            "red",
            "❌ App Domain Not Configured"
          )
        );
      }
      throw new Error(tokenJson?.error?.message || "Token exchange failed");
    }

    let userAccessToken = tokenJson.access_token;

    // 2) Long-lived token
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

    // 4) Find IG business account
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
      throw new Error("No Instagram Business Account found. Connect one to a Facebook Page and try again.");
    }

    // 5) Notify your app
    const payload = {
      client_id: clientId,
      instagram_account_id: igAccount.id,
      instagram_access_token: pageAccessToken,
      instagram_account_name: igDetails?.username || null,
      instagram_profile_picture_url: igDetails?.profile_picture_url || null
    };

    const updResp = await fetch(ORBIT_UPDATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.BASE44_API_KEY ? { Authorization: `Bearer ${process.env.BASE44_API_KEY}` } : {})
      },
      body: JSON.stringify(payload)
    });

    if (!updResp.ok) {
      throw new Error(`Failed to update main app: ${await updResp.text()}`);
    }

    return res
      .status(200)
      .send(html(
        `Instagram account @${igDetails?.username || igAccount.id} connected successfully.`,
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