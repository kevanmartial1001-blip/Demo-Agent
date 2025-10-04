// /api/realtimeSession.js
// Server-side: creates a short-lived OpenAI Realtime session and returns the info to the client.
// Requires OPENAI_API_KEY on Vercel. Optional: set REALTIME_MODEL (default gpt-4o-realtime-preview).

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY missing' });

  const model = process.env.REALTIME_MODEL || 'gpt-4o-realtime-preview';
  try {
    const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        voice: 'verse',            // good default; OpenAI picks a quality voice
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        modalities: ['audio', 'text'],
        // You can preload a system prompt here to match your "demo" style if you want:
        // instructions: "You are a helpful AI employee speaking clearly and concisely…"
      })
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(500).json({ error: `Realtime session failed: ${t}` });
    }
    const j = await r.json();
    // Return only what the client needs
    return res.status(200).json({
      websocket_url: 'https://api.openai.com/v1/realtime?model=' + model,
      client_secret: j.client_secret?.value || j.client_secret || null
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
};
