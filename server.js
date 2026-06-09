// The Maximus Breakdown - YouTube Render Node
// POST /render { audio_url, image_url, slug, title?, article_id? }
//   -> downloads assets, ffmpeg-stitches a 1080p MP4 (image looped over audio),
//      uploads to Supabase storage bucket "youtube-renders", returns the public URL.
// GET  /health -> { ok: true }

import express from 'express';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createClient } from '@supabase/supabase-js';

const PORT                       = Number(process.env.PORT || 8080);
const SHARED_SECRET              = process.env.RENDER_NODE_SECRET || '';
const SUPABASE_URL               = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RENDER_BUCKET              = process.env.RENDER_BUCKET || 'youtube-renders';
const FFMPEG_BIN                 = process.env.FFMPEG_BIN || 'ffmpeg';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[boot] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set - uploads will fail');
}

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const app = express();
app.use(express.json({ limit: '256kb' }));

function requireSecret(req, res) {
  if (!SHARED_SECRET) return true;
  const got = req.header('x-render-secret') || '';
  if (got !== SHARED_SECRET) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}

async function downloadTo(file, url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error('download failed ' + r.status + ' ' + url);
  await pipeline(r.body, createWriteStream(file));
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg exit ' + code + ': ' + stderr.slice(-2000)));
    });
  });
}

function slugify(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || crypto.randomBytes(6).toString('hex');
}

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.post('/render', async (req, res) => {
  if (!requireSecret(req, res)) return;

  const { audio_url, image_url, slug: rawSlug, title, article_id } = req.body || {};
  if (!audio_url || !image_url) {
    return res.status(400).json({ ok: false, error: 'audio_url and image_url required' });
  }

  const slug = slugify(rawSlug || title || ('article-' + (article_id || Date.now())));
  const work = await mkdtemp(path.join(tmpdir(), 'tmb-render-'));
  const audioFile = path.join(work, 'audio.mp3');
  const imageFile = path.join(work, 'image.png');
  const outFile   = path.join(work, slug + '.mp4');

  try {
    console.log('[render] ' + slug + ' start');

    await Promise.all([
      downloadTo(audioFile, audio_url),
      downloadTo(imageFile, image_url),
    ]);

    const vf = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p';
    await runFfmpeg([
      '-y', '-loop', '1', '-i', imageFile, '-i', audioFile,
      '-c:v', 'libx264', '-tune', 'stillimage', '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p', '-r', '30', '-vf', vf,
      '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
      '-movflags', '+faststart', '-shortest', outFile,
    ]);

    const mp4 = await readFile(outFile);
    const storagePath = slug + '-' + Date.now() + '.mp4';
    const { error: upErr } = await supa.storage.from(RENDER_BUCKET).upload(storagePath, mp4, {
      contentType: 'video/mp4', upsert: true,
      cacheControl: 'public, max-age=31536000, immutable',
    });
    if (upErr) throw new Error('storage upload: ' + upErr.message);
    const { data: pub } = supa.storage.from(RENDER_BUCKET).getPublicUrl(storagePath);

    console.log('[render] ' + slug + ' done ' + mp4.length + ' bytes');
    return res.json({
      ok: true, slug, bytes: mp4.length, bucket: RENDER_BUCKET,
      path: storagePath, public_url: pub && pub.publicUrl ? pub.publicUrl : null,
    });
  } catch (err) {
    console.error('[render] ' + slug + ' FAIL', err);
    return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    rm(work, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log('tmb-youtube-render-node listening on :' + PORT);
});
