import { Hono } from 'hono'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { config } from 'dotenv'
import { serve } from '@hono/node-server'
import { Readable } from 'stream'

config()

const app = new Hono()

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT_URL,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
})

app.get('/uploads/*', async (c) => {
  const urlPath = c.req.path.replace(/^\/uploads\//, '')
  const key = `uploads/${decodeURIComponent(urlPath)}`

  try {
    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: key,
    })

    const data = await s3.send(command)

    if (!data.Body) {
      return c.json({ error: 'File not found' }, 404)
    }

    const filename = key.split('/').pop()

    // 🔧 Convert Node stream to web stream
    const webStream = Readable.toWeb(data.Body as Readable)

    return new Response(webStream as unknown as ReadableStream, {
      headers: {
        'Content-Type': data.ContentType || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (err) {
    console.error('Fetch Error:', err)
    return c.json({ error: 'Failed to fetch file' }, 500)
  }
})

serve({
  fetch: app.fetch,
  port: 3000
}, (info) => {
  console.log(`🚀 Hono server running at http://localhost:${info.port}`)
})
