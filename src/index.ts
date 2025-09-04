import { Context, Hono } from 'hono'
import { cors } from 'hono/cors'
import { rateLimiter } from 'hono-rate-limiter'
import type { Store } from 'hono-rate-limiter'

// Fixed Bindings type for Cloudflare Workers
type Bindings = {
  R2_BUCKET_NAME: R2Bucket
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

// CORS Middleware
app.use('*', cors({
  origin: [
    'https://service-client-7pw.pages.dev',
    'https://render-imageproxy.onrender.com',
    'http://localhost:5173',
  ],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}))

// Health check route
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    message: 'Server is healthy',
    timestamp: new Date().toISOString(),
  }, 200)
})

// --- Rate Limit Store ---
class D1RateLimitStore implements Store {
  constructor(
    private db: D1Database,
    private ttlSeconds: number,
  ) { }

  async increment(key: string) {
    const now = Math.floor(Date.now() / 1000)
    const expires = now + this.ttlSeconds

    const row = await this.db.prepare(`
      SELECT count, expires_at FROM image_rate_limit WHERE key = ?
    `).bind(key).first<{ count: number, expires_at: number }>()

    if (!row || row.expires_at < now) {
      await this.db.prepare(`
        INSERT OR REPLACE INTO image_rate_limit (key, count, expires_at)
        VALUES (?, ?, ?)
      `).bind(key, 1, expires).run()

      return {
        success: true,
        limit: 100,
        remaining: 99,
        totalHits: 1,
        resetTime: new Date(expires * 1000),
      }
    }

    const newCount = row.count + 1
    await this.db.prepare(`
      UPDATE image_rate_limit SET count = ?, expires_at = ? WHERE key = ?
    `).bind(newCount, expires, key).run()

    return {
      success: newCount <= 100,
      limit: 100,
      remaining: Math.max(0, 100 - newCount),
      totalHits: newCount,
      resetTime: new Date(expires * 1000),
    }
  }

  async decrement(key: string) {
    const row = await this.db.prepare(`
      SELECT count FROM image_rate_limit WHERE key = ?
    `).bind(key).first<{ count: number }>()

    if (row && row.count > 0) {
      await this.db.prepare(`
        UPDATE image_rate_limit SET count = ? WHERE key = ?
      `).bind(row.count - 1, key).run()
    }
  }

  async resetKey(key: string) {
    await this.db.prepare(`DELETE FROM image_rate_limit WHERE key = ?`).bind(key).run()
  }
}

// --- Rate Limiting & Bot Protection Middleware ---
app.use('*', async (c, next) => {
  if (c.req.path === '/health') return next();

  const ip = c.req.header('cf-connecting-ip') ?? 'unknown-ip';
  const ua = c.req.header('user-agent') ?? '';
  const accept = c.req.header('accept') ?? '';

  const isUploadRequest = c.req.path.startsWith('/uploads/');
  const hasImageAccept = accept.toLowerCase().includes('image');
  const isLikelyImageRequest = isUploadRequest || hasImageAccept;

  // Allow imgproxy regardless of headers
  if (ua.startsWith('imgproxy/')) {
    return next();
  }

  // Block obvious bots and malformed clients
  const isBlockedUA = /python|curl|bot|spider|crawler|scraper/i.test(ua) && !isLikelyImageRequest;

  if (
    (!ua && !isLikelyImageRequest) ||
    isBlockedUA
    // Removed: (!accept && !isLikelyImageRequest) — imgproxy doesn't send Accept
  ) {
    console.warn(`[BLOCK] Suspicious request from ${ip}`, { ua, accept, path: c.req.path });
    return c.json({ error: 'Forbidden: Bot or malformed client' }, 403);
  }

  const fingerprint = `${ip}::${ua}`;
  const store = new D1RateLimitStore(c.env.DB, 65);

  return rateLimiter({
    windowMs: 65_000,
    limit: 100,
    standardHeaders: 'draft-6',
    keyGenerator: () => fingerprint,
    store,
  })(c, next);
});
// --- R2 File Proxy Routes ---
app.get('/', (c) => {
  return c.json({ message: 'Visit /path to serve R2 object at "path"' }, 200)
})

app.get('/*', async (c) => {
  const key = c.req.path.slice(1)
  if (!key) return c.json({ error: 'No path provided' }, 400)

  try {
    const object = await c.env.R2_BUCKET_NAME.get(key)
    if (!object) return c.json({ error: 'Not found' }, 404)

    const contentType = object.httpMetadata?.contentType || guessContentType(key) || 'application/octet-stream'

    const headers = new Headers()
    headers.set('Content-Type', contentType)
    headers.set('Cache-Control', 'public, max-age=86400')
    headers.set('X-Content-Type-Options', 'nosniff')

    return new Response(object.body, { headers })
  } catch (err) {
    return c.json({ error: 'Internal error' }, 500)
  }
})

app.post('/*', async (c) => {
  const key = c.req.path.slice(1)
  if (!key) return c.json({ error: 'No key provided' }, 400)

  const body = await c.req.arrayBuffer()
  const contentType = c.req.header('content-type') || guessContentType(key) || 'application/octet-stream'

  await c.env.R2_BUCKET_NAME.put(key, body, {
    httpMetadata: { contentType },
  })

  return c.json({ success: true, key, contentType })
})

// --- Debug Route ---
app.get('/debug/list', async (c) => {
  const prefix = c.req.query('prefix') || undefined
  try {
    const list = await c.env.R2_BUCKET_NAME.list({ prefix })
    return c.json({
      count: list.objects.length,
      truncated: list.truncated,
      objects: list.objects.map((obj) => ({
        key: obj.key,
        size: obj.size,
        etag: obj.etag,
        uploaded: obj.uploaded,
        httpMetadata: obj.httpMetadata,
      })),
    })
  } catch (err) {
    console.error('[Debug Error]', err)
    return c.json({ error: 'Failed to list files' }, 500)
  }
})

// --- Content Type Helper ---
function guessContentType(key: string): string | null {
  const ext = key.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'jpg': case 'jpeg': return 'image/jpeg'
    case 'png': return 'image/png'
    case 'webp': return 'image/webp'
    case 'gif': return 'image/gif'
    case 'svg': return 'image/svg+xml'
    case 'avif': return 'image/avif'
    case 'ico': return 'image/x-icon'
    default: return null
  }
}

// Export the app
export default app