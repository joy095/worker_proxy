import { Hono, type Context, type Next } from 'hono'
import { rateLimiter } from 'hono-rate-limiter'
import type { Store } from 'hono-rate-limiter'

type Bindings = {
  R2_BUCKET_NAME: R2Bucket
  CACHE: KVNamespace
}

const app = new Hono<{ Bindings: Bindings }>()

// Custom rate limit store using TTL (not absolute timestamps)
class KVRateLimitStore implements Store {
  constructor(private kv: KVNamespace, private ttlSeconds: number) { }

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
      }
    } else {
      await this.kv.put(key, JSON.stringify({ count: 1 }), { expirationTtl: this.ttlSeconds })
      return { success: true, limit: 100, remaining: 99, totalHits: 1 }
    }
  }

  async decrement(key: string): Promise<void> {
    const stored = await this.kv.get(key, { type: 'json' }) as { count: number } | null
    if (stored) {
      stored.count--
      await this.kv.put(key, JSON.stringify(stored), { expirationTtl: this.ttlSeconds })
    }
  }

  async resetKey(key: string): Promise<void> {
    await this.kv.delete(key)
  }
}

// 🌐 Middleware for burst protection + rate limit + fingerprinting
app.use('*', async (c: Context, next: Next) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown-ip"
  const ua = c.req.header("user-agent") ?? ""
  const accept = c.req.header("accept") ?? ""

  // 🚫 Block suspicious requests
  if (!ua || ua.includes("python") || ua.includes("curl") || !accept) {
    console.warn(`[BLOCK] Suspicious headers from ${ip}`)
    return c.text("Forbidden: Bot or malformed client", 403)
  }

  // 🧠 Fingerprint-based key
  const fingerprint = `${ip}::${ua}`

  // ⏱️ Burst limiter: 10 reqs per 5s
  const burstKey = `burst:${fingerprint}`
  const burst = await c.env.CACHE.get(burstKey, { type: 'json' }) || { count: 0 }
  burst.count++
  if (burst.count > 10) {
    console.warn(`[BURST] ${fingerprint} exceeded burst limit`)
    return c.text("Too many requests (burst)", 429)
  }
  await c.env.CACHE.put(burstKey, JSON.stringify(burst), { expirationTtl: 60 })


  // 🛡️ Rate limiter: 100 reqs per 65s
  const store = new KVRateLimitStore(c.env.CACHE, 65)
  return rateLimiter({
    windowMs: 65 * 1000,
    limit: 100,
    standardHeaders: 'draft-6',
    keyGenerator: () => fingerprint,
    store,
  })(c, next)
})

// 📁 File proxy
app.get('/uploads/*', async (c) => {
  const urlPath = decodeURIComponent(c.req.path.replace(/^\/uploads\//, ''))
  const key = `uploads/${urlPath}`
  console.log('[Fetch]', key)

  if (!key || key === 'uploads/') {
    return c.json({ error: 'Invalid path' }, 400)
  }

  try {
    const object = await c.env.R2_BUCKET_NAME.get(key)
    if (!object || !object.body) {
      return c.json({ error: 'File not found' }, 404)
    }

    const filename = key.split('/').pop() || 'download'
    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'public, max-age=86400', // Edge caching
        'X-Proxy-Filename': filename,
      },
    })
  } catch (err) {
    console.error('[Fetch Error]', err)
    return c.json({ error: 'Failed to fetch file' }, 500)
  }
})

// 🐞 Debug route to inspect object list
app.get('/debug/list', async (c) => {
  const list = await c.env.R2_BUCKET_NAME.list({ prefix: 'uploads/' })
  return c.json({
    count: list.objects.length,
    keys: list.objects.map(obj => obj.key),
  })
})

export default app
