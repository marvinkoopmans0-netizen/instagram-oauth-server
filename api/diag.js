module.exports = (req, res) => {
  res.status(200).json({
    has_REDIRECT_URI: !!process.env.REDIRECT_URI,
    REDIRECT_URI_value_snippet: (process.env.REDIRECT_URI || "").slice(0, 60),
    env_scope_hint: process.env.VERCEL_ENV || null, // "production" / "preview" / "development"
    vercel_url: process.env.VERCEL_URL || null
  });
};