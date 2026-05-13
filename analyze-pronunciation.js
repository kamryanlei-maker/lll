export const config = {
  api: {
    bodyParser: false
  }
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=([^;]+)/i.exec(contentType || '');
  if (!boundaryMatch) throw new Error('Missing multipart boundary.');
  const boundary = '--' + boundaryMatch[1];
  const body = buffer.toString('binary');
  const parts = body.split(boundary).slice(1, -1);
  const fields = {};
  const files = {};

  for (const part of parts) {
    const trimmed = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const idx = trimmed.indexOf('\r\n\r\n');
    if (idx === -1) continue;
    const rawHeaders = trimmed.slice(0, idx);
    const rawContent = trimmed.slice(idx + 4);
    const nameMatch = /name="([^"]+)"/.exec(rawHeaders);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const filenameMatch = /filename="([^"]*)"/.exec(rawHeaders);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(rawHeaders);
    const contentBuffer = Buffer.from(rawContent, 'binary');

    if (filenameMatch) {
      files[name] = {
        filename: filenameMatch[1] || 'audio.webm',
        contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
        buffer: contentBuffer
      };
    } else {
      fields[name] = contentBuffer.toString('utf8');
    }
  }
  return { fields, files };
}

function findFirstNumber(obj, keys) {
  const lowerKeys = keys.map(k => k.toLowerCase());
  let found = null;
  function walk(value, pathKey = '') {
    if (found !== null || value == null) return;
    if (typeof value === 'number' && lowerKeys.some(k => pathKey.toLowerCase().includes(k))) {
      found = Math.round(value);
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  }
  walk(obj);
  return found;
}

function collectWordScores(obj) {
  const results = [];
  function maybeAdd(item) {
    if (!item || typeof item !== 'object') return;
    const word = item.word || item.text || item.phone || item.label;
    const score = item.quality_score ?? item.score ?? item.pronunciation_score ?? item.speechace_score;
    if (typeof word === 'string' && typeof score === 'number') {
      results.push({ word, score: Math.round(score) });
    }
  }
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(v => { maybeAdd(v); walk(v); });
    } else {
      for (const v of Object.values(value)) walk(v);
    }
  }
  walk(obj);
  const seen = new Set();
  return results.filter(x => {
    const key = x.word.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function highlightText(text, difficultWords) {
  let safe = String(text || '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  for (const word of difficultWords) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    safe = safe.replace(new RegExp(`\\b(${escaped})\\b`, 'gi'), '<mark>$1</mark>');
  }
  return safe.replace(/\n/g, '<br>');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed', message: 'Use POST.' });
  }

  const apiKey = process.env.SPEECHACE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'missing_api_key', message: 'SPEECHACE_API_KEY is not set in Vercel Environment Variables.' });
  }

  try {
    const buffer = await readBody(req);
    const { fields, files } = parseMultipart(buffer, req.headers['content-type']);
    const audio = files.audio;
    const passage = fields.passage || '';

    if (!audio || !passage) {
      return res.status(400).json({ error: 'missing_data', message: 'Audio and passage are required.' });
    }

    const endpoint = process.env.SPEECHACE_ENDPOINT || 'https://api.speechace.co';
    const dialect = process.env.SPEECHACE_DIALECT || 'en-us';
    const url = `${endpoint.replace(/\/$/, '')}/api/scoring/text/v9/json?key=${encodeURIComponent(apiKey)}&dialect=${encodeURIComponent(dialect)}`;

    const form = new FormData();
    form.append('text', passage);
    form.append('user_audio_file', new Blob([audio.buffer], { type: audio.contentType }), audio.filename || 'student-reading.webm');

    const speechRes = await fetch(url, { method: 'POST', body: form });
    const rawText = await speechRes.text();
    let speechData;
    try { speechData = JSON.parse(rawText); } catch { speechData = { raw: rawText }; }

    if (!speechRes.ok || speechData.status === 'error') {
      return res.status(502).json({ error: 'speechace_error', message: speechData.detail_message || speechData.short_message || rawText || 'Speechace request failed.', raw: speechData });
    }

    const pronunciation = findFirstNumber(speechData, ['pronunciation', 'quality_score', 'speechace_score']) ?? 0;
    const fluency = findFirstNumber(speechData, ['fluency']) ?? pronunciation;
    const overall = Math.round((Number(pronunciation || 0) + Number(fluency || 0)) / 2);
    const wordScores = collectWordScores(speechData);
    const difficultWords = wordScores.filter(w => w.score < 75).slice(0, 12).map(w => w.word);

    const feedback = [];
    if (pronunciation >= 85) feedback.push('Your pronunciation is clear and accurate overall.');
    else if (pronunciation >= 70) feedback.push('Your pronunciation is understandable, but some words need more careful articulation.');
    else feedback.push('You should practise the highlighted words and read more slowly for clearer pronunciation.');
    if (fluency >= 85) feedback.push('Your reading is fluent with natural pacing.');
    else feedback.push('Try to pause naturally after commas and full stops to improve fluency.');
    if (difficultWords.length) feedback.push(`Focus on these words: ${difficultWords.join(', ')}.`);

    return res.status(200).json({
      pronunciation,
      fluency,
      overall,
      difficultWords,
      highlightedText: highlightText(passage, difficultWords),
      feedback,
      raw: speechData
    });
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: err.message || 'Server error.' });
  }
}
