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

// CORS Middleware - Using hono/cors (cleaner approach)
app.use('*', cors({
  origin: [
    'https://service-client-7pw.pages.dev',
    'https://render-imageproxy.onrender.com',
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
    timestamp: new Date().toISOString()
  }, 200)
})

class D1RateLimitStore implements Store {
  constructor(
    private db: D1Database,
    private ttlSeconds: number,
  ) { }

  async increment(key: string) {
    const now = Math.floor(Date.now() / 1000);
    const expires = now + this.ttlSeconds;

    const row = await this.db.prepare(`
      SELECT count, expires_at FROM image_rate_limit WHERE key = ?
    `).bind(key).first<{ count: number, expires_at: number }>();

    if (!row || row.expires_at < now) {
      await this.db.prepare(`
        INSERT OR REPLACE INTO image_rate_limit (key, count, expires_at)
        VALUES (?, ?, ?)
      `).bind(key, 1, expires).run();

      return {
        success: true,
        limit: 100,
        remaining: 99,
        totalHits: 1,
        resetTime: new Date(expires * 1000),
      };
    }

    const newCount = row.count + 1;
    await this.db.prepare(`
      UPDATE image_rate_limit SET count = ?, expires_at = ? WHERE key = ?
    `).bind(newCount, expires, key).run();

    return {
      success: newCount <= 100,
      limit: 100,
      remaining: Math.max(0, 100 - newCount),
      totalHits: newCount,
      resetTime: new Date(expires * 1000),
    };
  }

  async decrement(key: string) {
    const row = await this.db.prepare(`
      SELECT count FROM image_rate_limit WHERE key = ?
    `).bind(key).first<{ count: number }>();

    if (row && row.count > 0) {
      await this.db.prepare(`
        UPDATE image_rate_limit SET count = ? WHERE key = ?
      `).bind(row.count - 1, key).run();
    }
  }

  async resetKey(key: string) {
    await this.db.prepare(`DELETE FROM image_rate_limit WHERE key = ?`).bind(key).run();
  }
}

// Rate-limiting + bot protection middleware
app.use('*', async (c, next) => {
  // Skip rate limiting for health check
  if (c.req.path === '/health') {
    return next()
  }

  const ip = c.req.header('cf-connecting-ip') ?? 'unknown-ip'
  const ua = c.req.header('user-agent') ?? ''
  const accept = c.req.header('accept') ?? ''

  const isUploadRequest = c.req.path.startsWith('/uploads/');
  const hasImageAccept = accept.toLowerCase().includes('image');
  const isLikelyImageRequest = isUploadRequest || hasImageAccept; // Prioritize path check

  // 2. More nuanced bot detection
  //    - Only apply strict UA checks if it doesn't look like a normal image request
  const isBlockedUA = /python|curl|bot|spider|crawler|scraper/i.test(ua) && !isLikelyImageRequest;

  // 3. Block only if:
  //    - No User-Agent AND it's not an obvious image request (extra caution)
  //    - Blocked User-Agent AND it's not an obvious image request
  //    - No Accept header AND it's not an obvious image request
  //    - (Optional) Add extra checks for malformed requests if needed
  if (
    (!ua && !isLikelyImageRequest) ||
    isBlockedUA ||
    (!accept && !isLikelyImageRequest)
  ) {
    console.warn(`[BLOCK] Suspicious request from ${ip}`, {
      ua,
      accept,
      path: c.req.path,
      isUploadRequest,
      hasImageAccept,
      isLikelyImageRequest,
    });
    return c.json({ error: 'Forbidden: Bot or malformed client' }, 403);
  }

  const fingerprint = `${ip}::${ua}`

  // General rate limiter: 100 requests per 65 seconds
  const store = new D1RateLimitStore(c.env.DB, 65)
  return rateLimiter({
    windowMs: 65_000,
    limit: 100,
    standardHeaders: 'draft-6',
    keyGenerator: () => fingerprint,
    store,
  })(c as Context, next)
})

// Scheduled cleanup job - runs every 10 minutes
app.get('/_scheduled/cleanup', async (c) => {
  const result = await cleanupOldFiles(c.env.R2_BUCKET_NAME, c.env.DB)
  return c.json(result)
})

export async function scheduled(
  controller: ScheduledController,
  env: Bindings,
  ctx: ExecutionContext
): Promise<void> {
  if (controller.cron === '*/10 * * * *') {
    // Run cleanup every 10 minutes
    await cleanupOldFiles(env.R2_BUCKET_NAME, env.DB)
  }
}

async function cleanupOldFiles(bucket: R2Bucket, db: D1Database): Promise<{ deleted: string[] }> {
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).getTime()

  // Get all uploads from R2
  const list = await bucket.list({ prefix: 'uploads/' })
  const keysToDelete: string[] = []

  for (const obj of list.objects) {
    // Skip if not older than 30 mins
    if (obj.uploaded.getTime() > thirtyMinutesAgo) continue

    // Check if there's a corresponding DB entry with expires_at
    const row = await db.prepare(`
      SELECT expires_at FROM image_metadata WHERE key = ?
    `).bind(obj.key).first<{ expires_at: number | null }>()

    // If no DB record or no expires_at, or expires_at is in the past
    if (!row || !row.expires_at || row.expires_at * 1000 < Date.now()) {
      keysToDelete.push(obj.key)
    }
  }

  if (keysToDelete.length > 0) {
    await bucket.delete(keysToDelete)
    console.log(`Deleted ${keysToDelete.length} old files:`, keysToDelete)
  }

  return { deleted: keysToDelete }
}

// File proxy from R2
app.get('/uploads/*', async (c) => {
  const urlPath = decodeURIComponent(c.req.path.replace(/^\/uploads\//, ''))
  const key = `uploads/${urlPath}`

  if (!key || key === 'uploads/') {
    console.error(`[UPLOADS] Invalid path: ${key}`)
    return c.json({ error: 'Invalid path', path: c.req.path, key }, 400)
  }

  try {
    const object = await c.env.R2_BUCKET_NAME.get(key)
    if (!object?.body) {
      console.error(`[UPLOADS] File not found in R2: ${key}`)

      // Debug: List files with similar prefix
      const list = await c.env.R2_BUCKET_NAME.list({ prefix: `uploads/${urlPath.split('/')[0]}` })
      console.log(`[UPLOADS] Similar files:`, list.objects.map(o => o.key))

      return c.json({ error: 'File not found', key, similarFiles: list.objects.map(o => o.key) }, 404)
    }

    const filename = key.split('/').pop() || 'download'
    console.log(`[UPLOADS] Successfully serving: ${key}`)

    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'public, max-age=86400',
        'X-Proxy-Filename': filename,
      },
    })
  } catch (err) {
    console.error('[UPLOADS] R2 Error:', err)
    return c.json({ error: 'Failed to fetch file', details: err instanceof Error ? err.message : 'Unknown error' }, 500)
  }
})

// Debug route to list uploaded files
app.get('/debug/list', async (c) => {
  try {
    const list = await c.env.R2_BUCKET_NAME.list({ prefix: 'uploads/' })
    return c.json({
      count: list.objects.length,
      keys: list.objects.map((obj) => obj.key),
    })
  } catch (err) {
    console.error('[Debug Error]', err)
    return c.json({ error: 'Failed to list files' }, 500)
  }
})

export default app