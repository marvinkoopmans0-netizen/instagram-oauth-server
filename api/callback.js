// /api/callback.js
const { createClient } = require("@base44/sdk");

// Hardcode stable production redirect
const REDIRECT_URI = "https://instagram-oauth-server-2ca8.vercel.app/api/callback";

function html(msg, color = "black", title = "Status") {
  return `<html><body style="font-family:sans-serif;text-align:center;padding:40px;">
    <h1 style="color:${color};">${title}</h1>
    <div style="max-width:780px;margin:0 auto;text-align:left;">${msg}</div>
  </body></html>`;
}

async function getJson(url) {
  const r = await fetch(encodeURI(url));
  const t = await r.text();
  try { return { ok: r.ok, json: JSON.parse(t), raw: t }; }
  catch { return { ok: r.ok, json: null, raw: t }; }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const APP_ID = process.env.INSTAGRAM_APP_ID;
  const APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
  const BASE44_APP_ID = process.env.BASE44_APP_ID;

  if (!APP_ID || !APP_SECRET || !BASE44_APP_ID) {
    return res.status(500).send(html("Missing env vars", "red", "❌ Server Misconfigured"));
  }

  // Get user token from Authorization header
  const authHeader = req.headers.authorization;
  const userToken = authHeader?.split(" ")[1];
  if (!userToken) {
    return res.status(401).send(html("Missing user token in Authorization header", "red", "❌ Unauthorized"));
  }

  const { code, state, error } = req.query || {};
  if (error) return res.status(400).send(html(`Authorization failed: ${error}`, "red", "❌ Authorization Failed"));
  if (!code) return res.status(400).send(html("Missing authorization code", "red", "❌ Missing Parameters"));

  // Extract clientId from state
  let clientId = null;
  try { clientId = JSON.parse(decodeURIComponent(state))?.clientId || null; } catch {}
  if (!clientId) return res.status(400).send(html("Missing clientId in state", "red", "❌ Missing Parameters"));

  try {
    // 1) Exchange code → short-lived token
    const tokenParams = new URLSearchParams({
      client_id: APP_ID,
      client_secret: APP_SECRET,
      redirect_uri: REDIRECT_URI,
      code
    });
    const tokenRes = await fetch(`https://graph.facebook.com/v23.0/oauth/access_token?${tokenParams}`);
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokenJson?.error?.message || "Token exchange failed");
    let userAccessToken = tokenJson.access_token;

    // 2) Long-lived token
    const llParams = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: APP_ID,
      client_secret: APP_SECRET,
      fb_exchange_token: userAccessToken
    });
    const llRes = await getJson(`https://graph.facebook.com/v23.0/oauth/access_token?${llParams}`);
    if (llRes.ok && llRes.json?.access_token) userAccessToken = llRes.json.access_token;

    // 3) Get Pages
    const pagesRes = await getJson(`https://graph.facebook.com/v23.0/me/accounts?access_token=${encodeURIComponent(userAccessToken)}`);
    if (!pagesRes.ok || !pagesRes.json?.data?.length) throw new Error("No Pages returned for this user");

    // 4) Find IG account
    let igData = null;
    for (const page of pagesRes.json.data) {
      const pageInfo = await getJson(
        `https://graph.facebook.com/v23.0/${page.id}?fields=instagram_business_account,connected_instagram_account,name&access_token=${encodeURIComponent(page.access_token)}`
      );
      const igId = pageInfo.json?.instagram_business_account?.id || pageInfo.json?.connected_instagram_account?.id;
      if (igId) {
        const igDetails = await getJson(
          `https://graph.facebook.com/v23.0/${igId}?fields=username,profile_picture_url&access_token=${encodeURIComponent(page.access_token)}`
        );
        igData = {
          instagram_account_id: igId,
          instagram_access_token: page.access_token,
          instagram_account_name: igDetails.json?.username || null,
          instagram_profile_picture_url: igDetails.json?.profile_picture_url || null
        };
        break;
      }
    }
    if (!igData) throw new Error("No Instagram Business Account linked to any Page");

    // 5) Update client in Base44
    const base44 = createClient({ appId: BASE44_APP_ID });
    base44.auth.setToken(userToken);
    await base44.entities.Client.update(clientId, {
      ...igData,
      instagram_connection_status: "connected"
    });

    return res.status(200).send(html(
      `Instagram account @${igData.instagram_account_name || igData.instagram_account_id} connected successfully.`,
      "green",
      "✅ Connected Successfully"
    ));
  } catch (err) {
    console.error("OAuth callback error:", err);
    return res.status(500).send(html(err.message || "Unknown error", "red", "❌ Connection Failed"));
  }
};