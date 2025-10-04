// /api/twiml.js
module.exports = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const message = url.searchParams.get('message') || 'Hello. This is your AI employee with a demo follow-up.';
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${escapeXml(message)}</Say>
</Response>`;
  res.setHeader('Content-Type','text/xml');
  res.statusCode = 200;
  res.end(twiml);
};

function escapeXml(s){ return String(s).replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c])); }
