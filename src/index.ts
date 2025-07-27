import { Hono } from 'hono'
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

  // Block bots or malformed clients
  if (!ua || /python|curl|bot|spider/i.test(ua) || !accept) {
    console.warn(`[BLOCK] Suspicious request from ${ip}`, { ua, accept })
    return c.text('Forbidden: Bot or malformed client', 403)
  }

  const fingerprint = `${ip}::${ua}`

  // Burst limiter: 10 requests per 5 seconds
  const burstKey = `burst:${fingerprint}`
  const burst = (await c.env.CACHE.get(burstKey, { type: 'json' })) || { count: 0 }
    ; (burst as { count: number }).count++

  if ((burst as { count: number }).count > 10) {
    console.warn(`[BURST] ${fingerprint} exceeded burst limit`)
    return c.text('Too many requests (burst)', 429)
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
  })(c, next)
})

// File proxy from R2
app.get('/uploads/*', async (c) => {
  const urlPath = decodeURIComponent(c.req.path.replace(/^\/uploads\//, ''))
  const key = `uploads/${urlPath}`

  if (!key || key === 'uploads/') {
    return c.json({ error: 'Invalid path' }, 400)
  }

  try {
    const object = await c.env.R2_BUCKET_NAME.get(key)
    if (!object?.body) {
      return c.json({ error: 'File not found' }, 404)
    }

    const filename = key.split('/').pop() || 'download'
    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'public, max-age=86400',
        'X-Proxy-Filename': filename,
      },
    })
  } catch (err) {
    console.error('[Fetch Error]', err)
    return c.json({ error: 'Failed to fetch file' }, 500)
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