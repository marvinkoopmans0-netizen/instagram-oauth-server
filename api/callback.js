// /api/callback.js  (Vercel Serverless Function - CommonJS)
// HARD-CODE the stable production redirect to avoid preview-domain mismatches.
const REDIRECT_URI = "https://instagram-oauth-server-2ca8.vercel.app/api/callback";

function html(msg, color = "black", title = "Status") {
  return `
  <html>
    <body style="font-family: Arial, sans-serif; text-align:center; padding:40px;">
      <h1 style="color:${color};">${title}</h1>
      <div style="max-width:780px;margin:0 auto;text-align:left;">${msg}</div>
      <script>setTimeout(() => window.close(), 7000);</script>
    </body>
  </html>`;
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
  if (!APP_ID || !APP_SECRET || !ORBIT_UPDATE_URL) {
    return res.status(500).send(
      html(
        "Server not configured: missing <code>INSTAGRAM_APP_ID</code> / <code>INSTAGRAM_APP_SECRET</code> / <code>ORBIT_UPDATE_URL</code>.",
        "red",
        "❌ Server Misconfigured"
      )
    );
  }

  // Optional context from state
  let clientId = null;
  if (state) {
    try { clientId = (JSON.parse(decodeURIComponent(state)) || {}).clientId || null; } catch {}
  }

  try {
    // 1) Exchange code → short‑lived USER access token (must use the exact same redirect_uri)
    const tokenParams = new URLSearchParams({
      client_id: APP_ID,
      client_secret: APP_SECRET,
      redirect_uri: REDIRECT_URI,
      code
    });
    const tokenUrl = `https://graph.facebook.com/v23.0/oauth/access_token?${tokenParams}`;
    console.log("🔍 Token exchange URL:", tokenUrl);

    const tokenResp = await fetch(tokenUrl);
    const tokenTxt = await tokenResp.text();
    let tokenJson; try { tokenJson = JSON.parse(tokenTxt); } catch { tokenJson = { raw: tokenTxt }; }
    if (!tokenResp.ok) {
      const msg = tokenJson?.error?.message || "Token exchange failed";
      console.error("❌ Token exchange error body:", tokenTxt);
      return res.status(400).send(
        html(
          `Token exchange failed: ${msg}<br><br>
           Ensure this exact URL is in <b>Facebook Login → Valid OAuth Redirect URIs</b>:<br>
           <code>${REDIRECT_URI}</code><br><br>
           <details><summary>Raw error</summary><pre>${String(tokenTxt).replace(/[<>]/g, "")}</pre></details>`,
          "red",
          "❌ Redirect URI / Token Exchange Error"
        )
      );
    }
    let userAccessToken = tokenJson.access_token;

    // 2) (Best practice) Upgrade to long‑lived USER token
    const llParams = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: APP_ID,
      client_secret: APP_SECRET,
      fb_exchange_token: userAccessToken
    });
    const llResp = await fetch(`https://graph.facebook.com/v23.0/oauth/access_token?${llParams}`);
    const llJson = await llResp.json();
    if (llResp.ok && llJson.access_token) userAccessToken = llJson.access_token;

    // 3) Get Pages the user manages (MUST use USER token here)
    const pagesResp = await fetch(`https://graph.facebook.com/v23.0/me/accounts?access_token=${encodeURIComponent(userAccessToken)}`);
    const pagesJson = await pagesResp.json();
    if (!pagesResp.ok) {
      const msg = pagesJson?.error?.message || "Failed to fetch pages";
      throw new Error(msg);
    }
    if (!Array.isArray(pagesJson.data) || pagesJson.data.length === 0) {
      throw new Error(
        "No Pages returned for this user. Re‑consent with the required permissions and ensure your Facebook user has an Admin/Editor role on the Page. " +
        "Permissions to request: pages_show_list,pages_read_engagement,pages_manage_metadata,instagram_basic."
      );
    }

    // 4) For each Page, ask for BOTH Business & Creator links (MUST use PAGE token for this call)
    let igAccount = null;         // { id: "1784..." }
    let pageAccessToken = null;   // token for IG calls
    let igDetails = null;         // { username, profile_picture_url }

    for (const page of pagesJson.data) {
      if (!page?.id || !page?.access_token) continue;

      const fields = "instagram_business_account,connected_instagram_account";
      const igResp = await fetch(
        `https://graph.facebook.com/v23.0/${page.id}?fields=${fields}&access_token=${encodeURIComponent(page.access_token)}`
      );
      const igJson = await igResp.json();

      const igId =
        igJson?.instagram_business_account?.id ||
        igJson?.connected_instagram_account?.id;

      if (igId) {
        pageAccessToken = page.access_token;
        igAccount = { id: igId };

        // Optional: fetch handle + avatar (still using PAGE token)
        const detResp = await fetch(
          `https://graph.facebook.com/v23.0/${igId}?fields=username,profile_picture_url&access_token=${encodeURIComponent(pageAccessToken)}`
        );
        igDetails = await detResp.json();
        break;
      }
    }

    if (!igAccount) {
      throw new Error(
        "No Instagram Professional account (Business/Creator) linked to the Pages returned for this user. " +
        "Link your Instagram to a Facebook Page you manage (Page Settings → Linked Accounts → Instagram), " +
        "ensure the Instagram account is set to Professional (Business or Creator), then re‑try."
      );
    }

    // 5) Notify your main app
    const payload = {
      client_id: clientId,
      instagram_account_id: igAccount.id,
      instagram_access_token: pageAccessToken, // Page token suitable for IG Graph calls
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
    if (!updResp.ok) throw new Error(`Failed to update main app: ${await updResp.text()}`);

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