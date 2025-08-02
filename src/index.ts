import { Context, Hono } from 'hono'
import { cors } from 'hono/cors'
import { rateLimiter } from 'hono-rate-limiter'
import type { Store } from 'hono-rate-limiter'

// Fixed Bindings type for Cloudflare Workers
type Bindings = {
  R2_BUCKET_NAME: R2Bucket
  CACHE: KVNamespace
}

const app = new Hono<{ Bindings: Bindings }>()

// CORS Middleware - Using hono/cors (cleaner approach)
app.use('*', cors({
  origin: [
    'https://mail-2-2qez.vercel.app',
    'https://service-client-7pw.pages.dev',
    'http://localhost:5173',
    'http://localhost:8081',
    'http://localhost:8082',
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

// Custom rate limit store using TTL
class KVRateLimitStore implements Store {
  constructor(
    private kv: KVNamespace,
    private ttlSeconds: number
  ) { }

  async increment(key: string) {
    const stored = await this.kv.get(key, { type: 'json' }) as { count: number } | null
    if (stored) {
      stored.count++
      await this.kv.put(key, JSON.stringify(stored), { expirationTtl: this.ttlSeconds })
      return {
        success: stored.count <= 100,
        limit: 100,
        remaining: Math.max(0, 100 - stored.count),
        totalHits: stored.count,
        resetTime: new Date(Date.now() + this.ttlSeconds * 1000)
      }
    } else {
      await this.kv.put(key, JSON.stringify({ count: 1 }), { expirationTtl: this.ttlSeconds })
      return {
        success: true,
        limit: 100,
        remaining: 99,
        totalHits: 1,
        resetTime: new Date(Date.now() + this.ttlSeconds * 1000)
      }
    }
  }

  async decrement(key: string): Promise<void> {
    const stored = await this.kv.get(key, { type: 'json' }) as { count: number } | null
    if (stored && stored.count > 0) {
      stored.count--
      await this.kv.put(key, JSON.stringify(stored), { expirationTtl: this.ttlSeconds })
    }
  }

  async resetKey(key: string): Promise<void> {
    await this.kv.delete(key)
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

  // Burst limiter: 10 requests per 5 seconds
  const burstKey = `burst:${fingerprint}`
  const burst = (await c.env.CACHE.get(burstKey, { type: 'json' }) as { count: number } | null) || { count: 0 }
  burst.count++

  if (burst.count > 10) {
    console.warn(`[BURST] ${fingerprint} exceeded burst limit`)
    return c.json({ error: 'Too many requests (burst)' }, 429)
  }

  await c.env.CACHE.put(burstKey, JSON.stringify(burst), { expirationTtl: 60 })

  // General rate limiter: 100 requests per 65 seconds
  const store = new KVRateLimitStore(c.env.CACHE, 65)
  return rateLimiter({
    windowMs: 65_000,
    limit: 100,
    standardHeaders: 'draft-6',
    keyGenerator: () => fingerprint,
    store,
  })(c as Context, next)
})

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