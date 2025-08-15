// /api/callback.js  (Vercel Serverless Function - CommonJS)

// HARD-CODE the stable production redirect to avoid preview-domain mismatches.
const REDIRECT_URI = "https://instagram-oauth-server-2ca8.vercel.app/api/callback";

function html(msg, color = "black", title = "Status") {
  return `
  <html>
    <body style="font-family: Arial, sans-serif; text-align:center; padding:40px;">
      <h1 style="color:${color};">${title}</h1>
      <div style="max-width:780px;margin:0 auto;text-align:left;">${msg}</div>
    </body>
  </html>`;
}

// Minimal x-www-form-urlencoded parser for POST forms
async function parseForm(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const ct = (req.headers["content-type"] || "").toLowerCase();
  if (ct.includes("application/json")) {
    try { return JSON.parse(raw || "{}"); } catch { return {}; }
  }
  // default: x-www-form-urlencoded
  const params = new URLSearchParams(raw);
  const out = {};
  params.forEach((v, k) => { out[k] = v; });
  return out;
}

// Fetch helper with basic error surfacing
async function getJson(url) {
  const r = await fetch(encodeURI(url));
  const t = await r.text();
  try { return { ok: r.ok, json: JSON.parse(t), raw: t }; }
  catch { return { ok: r.ok, json: null, raw: t }; }
}

module.exports = async (req, res) => {
  // --- CORS ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const APP_ID = process.env.INSTAGRAM_APP_ID;
  const APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
  const ORBIT_UPDATE_URL = process.env.ORBIT_UPDATE_URL;
  const BASE44_API_KEY = process.env.BASE44_API_KEY;

  if (!APP_ID || !APP_SECRET || !ORBIT_UPDATE_URL) {
    return res.status(500).send(
      html(
        "Server not configured: missing <code>INSTAGRAM_APP_ID</code> / <code>INSTAGRAM_APP_SECRET</code> / <code>ORBIT_UPDATE_URL</code>.",
        "red",
        "❌ Server Misconfigured"
      )
    );
  }

  // ---------- POST: user picked a Page from the picker ----------
  if (req.method === "POST") {
    const body = await parseForm(req);
    const userAccessToken = body.user_token || "";
    const pickedPageId = body.page_id || "";
    let clientId = body.client_id || null;

    if (!userAccessToken || !pickedPageId) {
      return res.status(400).send(html("Missing selection or user token.", "red", "❌ Selection Error"));
    }

    try {
      // Re-list pages using USER token (ensures we have fresh page token)
      const meAccounts = await getJson(`https://graph.facebook.com/v23.0/me/accounts?access_token=${encodeURIComponent(userAccessToken)}`);
      if (!meAccounts.ok || !Array.isArray(meAccounts.json?.data)) {
        return res.status(400).send(html(
          `Could not list pages with user token.<br><pre>${(meAccounts.raw || "").replace(/[<>]/g, "")}</pre>`,
          "red",
          "❌ Page Lookup Failed"
        ));
      }

      const page = meAccounts.json.data.find(p => p.id === pickedPageId);
      if (!page || !page.access_token) {
        return res.status(400).send(html("Selected page not found or missing page token.", "red", "❌ Selection Error"));
      }

      // Ask for BOTH Business and Creator links using PAGE token
      const fields = "instagram_business_account,connected_instagram_account,name";
      const pageInfo = await getJson(
        `https://graph.facebook.com/v23.0/${page.id}?fields=${fields}&access_token=${encodeURIComponent(page.access_token)}`
      );
      if (!pageInfo.ok) {
        return res.status(400).send(html(
          `Failed to fetch page IG links.<br><pre>${(pageInfo.raw || "").replace(/[<>]/g, "")}</pre>`,
          "red",
          "❌ IG Link Lookup Failed"
        ));
      }

      const igId =
        pageInfo.json?.instagram_business_account?.id ||
        pageInfo.json?.connected_instagram_account?.id;

      if (!igId) {
        return res.status(400).send(html(
          "This Page has no linked Instagram Professional account (Business/Creator). Link one and try again.",
          "red",
          "❌ No IG Linked"
        ));
      }

      // Optional IG details for UI
      const igDetails = await getJson(
        `https://graph.facebook.com/v23.0/${igId}?fields=username,profile_picture_url&access_token=${encodeURIComponent(page.access_token)}`
      );

      // Notify your main app
      const payload = {
        client_id: clientId,
        instagram_account_id: igId,
        instagram_access_token: page.access_token,
        instagram_account_name: igDetails.json?.username || null,
        instagram_profile_picture_url: igDetails.json?.profile_picture_url || null
      };

      const updResp = await fetch(ORBIT_UPDATE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(BASE44_API_KEY ? { Authorization: `Bearer ${BASE44_API_KEY}` } : {})
        },
        body: JSON.stringify(payload)
      });

      if (!updResp.ok) {
        const t = await updResp.text();
        return res.status(502).send(html(
          `Failed to update main app:<br><pre>${(t || "").replace(/[<>]/g, "")}</pre>`,
          "red",
          "❌ Upstream Update Failed"
        ));
      }

      return res.status(200).send(html(
        `Instagram account @${igDetails.json?.username || igId} connected successfully. You can close this window.`,
        "green",
        "✅ Connected Successfully"
      ));
    } catch (e) {
      console.error("POST picker flow error:", e);
      return res.status(500).send(html(String(e?.message || e), "red", "❌ Connection Failed"));
    }
  }

  // ---------- GET: OAuth redirect with ?code= ----------
  if (req.method !== "GET") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const { code, state, error } = req.query || {};
  if (error) {
    return res.status(400).send(html(`Authorization failed: ${String(error)}`, "red", "❌ Authorization Failed"));
  }
  if (!code) {
    return res.status(400).send(html("Missing authorization code", "red", "❌ Missing Parameters"));
  }

  // Optional context
  let clientId = null;
  if (state) {
    try { clientId = (JSON.parse(decodeURIComponent(state)) || {}).clientId || null; } catch {}
  }

  try {
    // 1) Exchange code → short‑lived USER token (exact same redirect_uri)
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
      console.error("❌ Token exchange error body:", tokenTxt);
      return res.status(400).send(html(
        `Token exchange failed.<br><br>
         Ensure this exact URL is in <b>Facebook Login → Valid OAuth Redirect URIs</b>:<br>
         <code>${REDIRECT_URI}</code><br><br>
         <details><summary>Raw error</summary><pre>${String(tokenTxt).replace(/[<>]/g, "")}</pre></details>`,
        "red",
        "❌ Redirect URI / Token Exchange Error"
      ));
    }
    let userAccessToken = tokenJson.access_token;

    // 2) DEBUG LOGS: me/permissions and me/accounts (with USER token)
    const permsResp = await fetch(`https://graph.facebook.com/v23.0/me/permissions?access_token=${encodeURIComponent(userAccessToken)}`);
    const permsTxt = await permsResp.text();
    console.log("DEBUG me/permissions:", permsTxt);

    const meAcctsResp = await fetch(`https://graph.facebook.com/v23.0/me/accounts?access_token=${encodeURIComponent(userAccessToken)}`);
    const meAcctsTxt = await meAcctsResp.text();
    console.log("DEBUG me/accounts:", meAcctsTxt);

    // 3) Upgrade to long‑lived USER token (optional but recommended)
    const llParams = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: APP_ID,
      client_secret: APP_SECRET,
      fb_exchange_token: userAccessToken
    });
    const ll = await getJson(`https://graph.facebook.com/v23.0/oauth/access_token?${llParams}`);
    if (ll.ok && ll.json?.access_token) userAccessToken = ll.json.access_token;

    // 4) List Pages with USER token
    const pagesRes = await getJson(`https://graph.facebook.com/v23.0/me/accounts?access_token=${encodeURIComponent(userAccessToken)}`);
    if (!pagesRes.ok) {
      return res.status(400).send(html(
        `Failed to fetch pages.<br><pre>${(pagesRes.raw || "").replace(/[<>]/g, "")}</pre>`,
        "red",
        "❌ Pages Fetch Failed"
      ));
    }
    const pages = Array.isArray(pagesRes.json?.data) ? pagesRes.json.data : [];
    if (pages.length === 0) {
      return res.status(400).send(html(
        "No Pages returned for this user. Re‑consent with the required permissions and ensure your Facebook user has an Admin/Editor role on the Page. " +
        "Permissions to request: <code>pages_show_list,pages_read_engagement,pages_manage_metadata,instagram_basic</code>.",
        "red",
        "❌ No Pages"
      ));
    }

    // 5) Build candidates: Pages that have IG (Business/Creator)
    const candidates = [];
    for (const page of pages) {
      if (!page?.id || !page?.access_token) continue;
      const fields = "instagram_business_account,connected_instagram_account,name";
      const pageInfo = await getJson(
        `https://graph.facebook.com/v23.0/${page.id}?fields=${fields}&access_token=${encodeURIComponent(page.access_token)}`
      );
      if (!pageInfo.ok) continue;

      const igId =
        pageInfo.json?.instagram_business_account?.id ||
        pageInfo.json?.connected_instagram_account?.id;
      if (!igId) continue;

      const det = await getJson(
        `https://graph.facebook.com/v23.0/${igId}?fields=username,profile_picture_url&access_token=${encodeURIComponent(page.access_token)}`
      );

      candidates.push({
        pageId: page.id,
        pageName: pageInfo.json?.name || page.name || page.id,
        pageToken: page.access_token,
        igId,
        igUsername: det.json?.username || null,
        igAvatar: det.json?.profile_picture_url || null
      });
    }

    if (candidates.length === 0) {
      return res.status(400).send(html(
        "No Instagram Professional account (Business/Creator) linked to any Page returned for this user. " +
        "Link your Instagram to a Facebook Page you manage (Page Settings → Linked Accounts → Instagram), " +
        "ensure the Instagram account is Professional, then re‑try.",
        "red",
        "❌ No IG Linked"
      ));
    }

    // If exactly one, auto-select; else render a picker that POSTs back with user_token + page_id
    if (candidates.length === 1) {
      const c = candidates[0];

      // Finalize: notify your main app using the PAGE token
      const updResp = await fetch(ORBIT_UPDATE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(BASE44_API_KEY ? { Authorization: `Bearer ${BASE44_API_KEY}` } : {})
        },
        body: JSON.stringify({
          client_id: clientId,
          instagram_account_id: c.igId,
          instagram_access_token: c.pageToken,
          instagram_account_name: c.igUsername || null,
          instagram_profile_picture_url: c.igAvatar || null
        })
      });
      if (!updResp.ok) {
        const t = await updResp.text();
        return res.status(502).send(html(
          `Failed to update main app:<br><pre>${(t || "").replace(/[<>]/g, "")}</pre>`,
          "red",
          "❌ Upstream Update Failed"
        ));
      }

      return res.status(200).send(html(
        `Instagram account @${c.igUsername || c.igId} connected successfully. You can close this window.`,
        "green",
        "✅ Connected Successfully"
      ));
    }

    // Render picker
    const items = candidates.map(c => `
      <li style="margin:12px 0; display:flex; align-items:center; gap:10px;">
        <img src="${c.igAvatar || ""}" onerror="this.style.display='none'" style="height:32px;width:32px;border-radius:50%;">
        <div style="flex:1;">
          <div><b>@${c.igUsername || c.igId}</b></div>
          <div style="font-size:12px;color:#555;">Page: ${c.pageName} (${c.pageId})</div>
        </div>
        <form method="POST" action="/api/callback" style="margin:0;">
          <input type="hidden" name="page_id" value="${c.pageId}">
          <input type="hidden" name="user_token" value="${userAccessToken}">
          <input type="hidden" name="client_id" value="${clientId || ""}">
          <button type="submit" style="padding:8px 12px;border-radius:8px;border:1px solid #ddd;cursor:pointer;">Kies</button>
        </form>
      </li>
    `).join("");

    return res.status(200).send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 28px; max-width: 840px; margin: 0 auto;">
          <h2 style="margin-top:0;">Kies het Instagram‑account dat je wilt koppelen</h2>
          <p>We vonden meerdere gekoppelde Instagram Professional accounts. Kies er één om te verbinden.</p>
          <ul style="list-style:none;padding:0;margin:16px 0;">${items}</ul>
          <p style="font-size:12px;color:#666;">Tip: als je de juiste pagina/IG niet ziet, klik <b>Terug</b> en log opnieuw in met <i>Toegang bewerken</i> om de juiste pagina/IG te selecteren.</p>
        </body>
      </html>
    `);

  } catch (e) {
    console.error("OAuth callback error:", e);
    return res.status(500).send(html(String(e?.message || e), "red", "❌ Connection Failed"));
  }
};