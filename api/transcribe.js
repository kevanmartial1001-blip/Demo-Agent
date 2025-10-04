// /api/transcribe.js
// Accepts { audio, mime } where `audio` is a data URL or base64 string.
// Uses Deepgram if DEEPGRAM_API_KEY is set (and TRANSCRIBE_PROVIDER=deepgram),
// else uses OpenAI Whisper if OPENAI_API_KEY is set,
// else falls back to Web Speech API on the client (but this route will return 501).

module.exports.config = { runtime: 'nodejs18.x' };

const DG_URL = "https://api.deepgram.com/v1/listen?model=nova-2-general&smart_format=true";

function parseBase64(input) {
  if (!input) return null;
  const idx = input.indexOf('base64,');
  const b64 = idx >= 0 ? input.slice(idx + 7) : input;
  return Buffer.from(b64, 'base64');
}

async function transcribeDeepgram(buf, mime) {
  const res = await fetch(DG_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
      'Content-Type': mime || 'audio/webm'
    },
    body: buf
  });
  if (!res.ok) throw new Error(`Deepgram ${res.status}`);
  const j = await res.json();
  const text = j?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
  return text;
}

async function transcribeOpenAI(buf, mime) {
  const apiKey = process.env.OPENAI_API_KEY;
  const form = new FormData();
  const file = new Blob([buf], { type: mime || 'audio/webm' });
  form.append('file', file, 'note.webm');
  form.append('model', 'whisper-1');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI ${res.status}: ${t}`);
  }
  const j = await res.json();
  return j.text || '';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method Not Allowed' });

  try{
    if (!req.body) return res.status(400).json({ ok:false, error:'No body' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const buf = parseBase64(body.audio);
    if (!buf) return res.status(400).json({ ok:false, error:'Invalid audio' });

    const provider = (process.env.TRANSCRIBE_PROVIDER || '').toLowerCase();
    let text = '';

    if (provider === 'deepgram' && process.env.DEEPGRAM_API_KEY) {
      text = await transcribeDeepgram(buf, body.mime);
    } else if (process.env.OPENAI_API_KEY) {
      text = await transcribeOpenAI(buf, body.mime);
    } else {
      return res.status(501).json({ ok:false, error:'No transcription provider configured' });
    }

    return res.status(200).json({ ok:true, text });
  } catch(e){
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
};
