export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code, state, error } = req.query;
  
  if (error) {
    return res.send(`
      <html>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1 style="color: red;">❌ Authorization Failed</h1>
          <p>Error: ${error}</p>
          <script>
            setTimeout(() => window.close(), 2000);
          </script>
        </body>
      </html>
    `);
  }

  if (!code || !state) {
    return res.send(`
      <html>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1 style="color: red;">❌ Missing Parameters</h1>
          <p>Missing authorization code or state</p>
          <script>
            setTimeout(() => window.close(), 2000);
          </script>
        </body>
      </html>
    `);
  }

  try {
    console.log('Processing Instagram OAuth callback...');

    const { clientId } = JSON.parse(decodeURIComponent(state));
    
    // Step 1: Exchange code for token
    const tokenResponse = await fetch('https://graph.facebook.com/v19.0/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.INSTAGRAM_APP_ID,
        client_secret: process.env.INSTAGRAM_APP_SECRET,
        redirect_uri: `https://${process.env.VERCEL_URL}/api/callback`,
        code: code,
      }),
    });
    
    const tokenData = await tokenResponse.json();
    
    if (!tokenResponse.ok) {
      throw new Error(tokenData.error?.message || 'Token exchange failed');
    }

    // Step 2: Get long-lived token
    const longLivedResponse = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.INSTAGRAM_APP_ID}&client_secret=${process.env.INSTAGRAM_APP_SECRET}&fb_exchange_token=${tokenData.access_token}`
    );
    const longLivedData = await longLivedResponse.json();
    const accessToken = longLivedData.access_token || tokenData.access_token;

    // Step 3: Get pages
    const pagesResponse = await fetch(`https://graph.facebook.com/v19.0/me/accounts?access_token=${accessToken}`);
    const pagesData = await pagesResponse.json();

    if (!pagesResponse.ok) {
      throw new Error(pagesData.error?.message || 'Failed to fetch pages');
    }

    // Step 4: Find Instagram account
    let instagramAccount = null;
    let pageAccessToken = null;
    let instagramDetails = null;

    for (const page of pagesData.data || []) {
      const igResponse = await fetch(`https://graph.facebook.com/v19.0/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`);
      const igData = await igResponse.json();
      
      if (igData.instagram_business_account) {
        instagramAccount = igData.instagram_business_account;
        pageAccessToken = page.access_token;
        
        // Get Instagram details
        const igDetailsResponse = await fetch(`https://graph.facebook.com/v19.0/${igData.instagram_business_account.id}?fields=username,profile_picture_url&access_token=${page.access_token}`);
        instagramDetails = await igDetailsResponse.json();
        break;
      }
    }
    
    if (!instagramAccount) {
      throw new Error('No Instagram Business Account found. Please connect an Instagram Business Account to your Facebook Page.');
    }

    // Step 5: Send data back to your main app
    const updatePayload = {
      client_id: clientId,
      instagram_account_id: instagramAccount.id,
      instagram_access_token: pageAccessToken,
      instagram_account_name: instagramDetails.username,
      instagram_profile_picture_url: instagramDetails.profile_picture_url,
    };

    const updateResponse = await fetch('https://preview--orbit-b398407d.base44.app/api/updateInstagramConnection', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.BASE44_API_KEY || 'admin-token'}`
      },
      body: JSON.stringify(updatePayload),
    });

    if (updateResponse.ok) {
      return res.send(`
        <html>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h1 style="color: green;">✅ Connected Successfully!</h1>
            <p>Instagram account @${instagramDetails.username} connected to your client.</p>
            <p>You can close this window now.</p>
            <script>
              setTimeout(() => window.close(), 3000);
            </script>
          </body>
        </html>
      `);
    } else {
      throw new Error('Failed to update main app');
    }
    
  } catch (error) {
    console.error('OAuth callback error:', error);
    return res.send(`
      <html>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1 style="color: red;">❌ Connection Failed</h1>
          <p>${error.message}</p>
          <p>You can close this window and try again.</p>
          <script>
            setTimeout(() => window.close(), 5000);
          </script>
        </body>
      </html>
    `);
  }
}
