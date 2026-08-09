// /api/chat.js
// Vercel serverless function — keeps your Gemini API key secret on the server side.
// Deploy this file at the path: api/chat.js in your project root.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message, profile } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Missing "message" in request body' });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Server misconfiguration: GEMINI_API_KEY not set in Vercel env vars' });
  }

  // Build a system-style context so replies are relevant to the user's job search
  const contextPrefix = profile
    ? `You are an AI job search assistant helping a candidate. Their profile: ${JSON.stringify(profile)}. Keep answers practical and specific to their situation.\n\nUser message: `
    : `You are an AI job search assistant. Keep answers practical and actionable.\n\nUser message: `;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: contextPrefix + message }]
            }
          ]
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('Gemini API error:', errText);
      return res.status(502).json({ error: 'AI service error', detail: errText });
    }

    const data = await response.json();
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't generate a response.";

    return res.status(200).json({ reply });
  } catch (err) {
    console.error('Chat handler crash:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
