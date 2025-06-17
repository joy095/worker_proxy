import { Hono } from 'hono'

type Bindings = {
  R2_BUCKET_NAME: R2Bucket
}

const app = new Hono<{ Bindings: Bindings }>()

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
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (err) {
    console.error('[Fetch Error]', err)
    return c.json({ error: 'Failed to fetch file' }, 500)
  }
})

app.get('/debug/list', async (c) => {
  const list = await c.env.R2_BUCKET_NAME.list({ prefix: 'uploads/' })

  return c.json({
    count: list.objects.length,
    keys: list.objects.map(obj => obj.key),
  })
})


export default app