const express = require("express")
const cors = require("cors")
const helmet = require("helmet")
const rateLimit = require("express-rate-limit")
const ffmpeg = require("fluent-ffmpeg")
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path
const axios = require("axios")
const fs = require("fs")
const path = require("path")
const multer = require("multer")
const { AssemblyAI } = require("assemblyai")
const Anthropic = require("@anthropic-ai/sdk")
const { createClient } = require("@supabase/supabase-js")
const ws = require("ws")
const { exec } = require("child_process")
const { promisify } = require("util")
const execAsync = promisify(exec)
const puppeteer = require("puppeteer-core")

ffmpeg.setFfmpegPath(ffmpegPath)

const ALLOWED_ORIGINS = [
  "https://climbclip.vercel.app",
  "http://localhost:3000",
  "http://localhost:3001",
]

const app = express()
app.use(helmet({ crossOriginResourcePolicy: false }))
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true)
    else cb(new Error("Not allowed by CORS"))
  },
  credentials: true,
}))
app.use(express.json({ limit: "50mb" }))

// ─── RATE LIMITING ──────────────────────────────────────────────────────────
const generateLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: "Trop de requêtes — réessaie dans une minute." } })
const uploadLimiter   = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false })
const genericLimiter  = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false })

// ─── INPUT SANITIZATION HELPERS ─────────────────────────────────────────────
function sanitizeVideoPath(p) {
  if (typeof p !== "string") return null
  const resolved = path.resolve(p)
  if (!resolved.startsWith("/tmp/")) return null
  return resolved
}

function sanitizeUrl(url) {
  if (typeof url !== "string") return null
  try {
    const u = new URL(url)
    if (!["http:", "https:"].includes(u.protocol)) return null
    if (/[`$;&|<>(){}\\!]/.test(url)) return null
    return url
  } catch { return null }
}

function sanitizeText(text, maxLen = 500) {
  if (typeof text !== "string") return ""
  return text.slice(0, maxLen).replace(/[<>]/g, "")
}

function sanitizeFormat(f) {
  return ["9:16","16:9","1:1","4:5"].includes(f) ? f : "9:16"
}

function sanitizeExportQuality(q) {
  return ["720p","1080p","4K"].includes(q) ? q : "1080p"
}

function sanitizeExportCodec(c) {
  return ["H264","H265","VP9"].includes(c) ? c : "H264"
}

function sanitizeColorGrade(g) {
  return ["none","cinematic","orange_teal","bw","vibrant","moody","warm","cold"].includes(g) ? g : "none"
}

function sanitizeTransition(t) {
  return ["none","fade","flash","glitch","zoom_in"].includes(t) ? t : "none"
}

const PORT = process.env.PORT || 3001
const aai = new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY })
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "")
const supabase = SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } })
  : null

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
const sharp = require("sharp")
const GOOGLE_REDIRECT_URI = "https://climbclip-server.onrender.com/auth/google/callback"
const FRONTEND_URL = process.env.FRONTEND_URL || "https://climbclip.vercel.app"

const upload = multer({ dest: "/tmp/uploads/", limits: { fileSize: 2 * 1024 * 1024 * 1024 } })
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } })
const jobs = {}
const sseClients = {}

function pushSSE(jobId, data) {
  if (!sseClients[jobId]) return
  const msg = `data: ${JSON.stringify(data)}\n\n`
  sseClients[jobId] = sseClients[jobId].filter(res => {
    try { res.write(msg); return true } catch { return false }
  })
}

function updateJob(jobId, update) {
  jobs[jobId] = { ...jobs[jobId], ...update }
  pushSSE(jobId, jobs[jobId])
}

app.get("/health", (req, res) => res.json({ status: "ok" }))

// ─── OAUTH GOOGLE DRIVE ────────────────────────────────────────────────────

app.get("/auth/google", (req, res) => {
  const { email, redirect } = req.query
  const redirectUri = redirect || FRONTEND_URL
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.file",
    access_type: "offline",
    prompt: "consent",
    state: JSON.stringify({ email, redirect: redirectUri }),
  })
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
})

app.get("/auth/google/callback", async (req, res) => {
  const { code, state } = req.query
  let email, redirectUri
  try { const parsed = JSON.parse(state || "{}"); email = parsed.email; redirectUri = parsed.redirect } catch {}
  const frontendUrl = redirectUri || FRONTEND_URL

  if (!code) {
    console.error("OAuth callback: missing code")
    return res.redirect(`${frontendUrl}#drive_error`)
  }
  if (!supabase) {
    console.error("OAuth callback: Supabase not initialized — check SUPABASE_URL and SUPABASE_SERVICE_KEY env vars on Render")
    return res.redirect(`${frontendUrl}#drive_error`)
  }
  if (!email) {
    console.error("OAuth callback: no email in state param")
    return res.redirect(`${frontendUrl}#drive_error`)
  }

  try {
    const tokenRes = await axios.post("https://oauth2.googleapis.com/token", {
      code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI, grant_type: "authorization_code",
    })
    const { refresh_token, access_token } = tokenRes.data
    console.log(`OAuth callback: email=${email} has_refresh_token=${!!refresh_token} has_access_token=${!!access_token}`)

    if (refresh_token) {
      const { error } = await supabase.from("google_tokens").upsert(
        { user_email: email, refresh_token, updated_at: new Date().toISOString() },
        { onConflict: "user_email" }
      )
      if (error) {
        console.error("google_tokens upsert error:", error.message, error.details, error.hint)
        return res.redirect(`${frontendUrl}#drive_error`)
      }
      console.log(`Token saved for ${email}`)
    } else {
      // Google doesn't re-issue refresh_token when one already exists and is still valid.
      // Check if we already have a valid token for this user.
      const { data: existing, error: selectErr } = await supabase
        .from("google_tokens").select("refresh_token").eq("user_email", email).single()
      if (selectErr || !existing?.refresh_token) {
        console.error(`No refresh_token from Google and no existing token for ${email}. Google response:`, tokenRes.data)
        return res.redirect(`${frontendUrl}#drive_error`)
      }
      console.log(`No new refresh_token from Google but existing token valid for ${email}`)
    }

    res.redirect(`${frontendUrl}#drive_connected`)
  } catch (err) {
    console.error("OAuth callback error:", err.response?.data || err.message)
    res.redirect(`${frontendUrl}#drive_error`)
  }
})

app.get("/auth/google/status", async (req, res) => {
  const { email } = req.query
  if (!email || !supabase) return res.json({ connected: false })
  try {
    const { data, error } = await supabase.from("google_tokens").select("refresh_token").eq("user_email", email).single()
    if (error && error.code !== "PGRST116") console.error("Drive status check error:", error.message)
    res.json({ connected: !!(data?.refresh_token) })
  } catch (err) {
    console.error("Drive status error:", err.message)
    res.json({ connected: false })
  }
})


app.post("/drive/upload", async (req, res) => {
  const { email, storageUrl, fileName } = req.body
  if (!email || !storageUrl) return res.status(400).json({ error: "email et storageUrl requis" })
  if (!supabase) return res.status(503).json({ error: "Supabase non configuré" })
  try {
    const { data: tokenData } = await supabase.from("google_tokens").select("refresh_token").eq("user_email", email).single()
    if (!tokenData?.refresh_token) return res.status(401).json({ error: "not_connected" })
    const tokenRes = await axios.post("https://oauth2.googleapis.com/token", {
      refresh_token: tokenData.refresh_token, client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET, grant_type: "refresh_token",
    })
    const accessToken = tokenRes.data.access_token
    const videoRes = await axios({ url: storageUrl, method: "GET", responseType: "stream" })
    const metadata = JSON.stringify({ name: fileName || "clip.mp4", mimeType: "video/mp4" })
    const boundary = "-------climbclip_boundary"
    const delimiter = `\r\n--${boundary}\r\n`
    const closeDelimiter = `\r\n--${boundary}--`
    const uploadRes = await axios({
      method: "POST",
      url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary="${boundary}"` },
      data: Buffer.concat([
        Buffer.from(`${delimiter}Content-Type: application/json\r\n\r\n${metadata}${delimiter}Content-Type: video/mp4\r\n\r\n`),
        await streamToBuffer(videoRes.data),
        Buffer.from(closeDelimiter),
      ]),
      maxContentLength: Infinity, maxBodyLength: Infinity,
    })
    res.json({ success: true, fileId: uploadRes.data.id, fileName: uploadRes.data.name })
  } catch (err) {
    console.error("Drive upload error:", err.message)
    if (err.response?.status === 401) return res.status(401).json({ error: "not_connected" })
    res.status(500).json({ error: err.message })
  }
})

async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on("data", chunk => chunks.push(chunk))
    stream.on("end", () => resolve(Buffer.concat(chunks)))
    stream.on("error", reject)
  })
}

// ─── SSE ───────────────────────────────────────────────────────────────────

app.get("/stream/:jobId", (req, res) => {
  const { jobId } = req.params
  res.setHeader("Content-Type", "text/event-stream")
  res.setHeader("Cache-Control", "no-cache")
  res.setHeader("Connection", "keep-alive")
  res.flushHeaders()
  if (!sseClients[jobId]) sseClients[jobId] = []
  sseClients[jobId].push(res)
  if (jobs[jobId]) res.write(`data: ${JSON.stringify(jobs[jobId])}\n\n`)
  req.on("close", () => {
    sseClients[jobId] = (sseClients[jobId] || []).filter(r => r !== res)
    if (sseClients[jobId].length === 0) delete sseClients[jobId]
  })
})

app.post("/upload", uploadLimiter, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Aucun fichier" })
  res.json({ path: req.file.path })
})

app.post("/upscale", uploadLimiter, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fichier requis" })
  const scaleRaw = parseInt(req.body.scale)
  const scale = [2, 4].includes(scaleRaw) ? scaleRaw : 2
  const { mimetype, path: filePath, size, originalname } = req.file
  const isImage = mimetype.startsWith("image/")
  const isVideo = mimetype.startsWith("video/")

  console.log(`[upscale] file=${originalname} mime=${mimetype} size=${(size/1024/1024).toFixed(1)}MB scale=${scale}`)

  if (!isImage && !isVideo) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    return res.status(400).json({ error: "Format non supporté (JPG, PNG, WebP, MP4, MOV)" })
  }
  if (isImage && size > 20 * 1024 * 1024) {
    fs.unlinkSync(filePath)
    return res.status(400).json({ error: "Image trop lourde (max 20MB)" })
  }
  if (isVideo && size > 200 * 1024 * 1024) {
    fs.unlinkSync(filePath)
    return res.status(400).json({ error: "Vidéo trop lourde (max 200MB)" })
  }

  try {
    if (isImage) {
      const inputBuf = fs.readFileSync(filePath)
      fs.unlinkSync(filePath)

      const meta = await sharp(inputBuf).metadata()
      const newW = (meta.width  || 512) * scale
      const newH = (meta.height || 512) * scale
      console.log(`[upscale] image ${meta.width}x${meta.height} → ${newW}x${newH}`)

      const outputBuf = await sharp(inputBuf)
        .resize(newW, newH, { kernel: sharp.kernel.lanczos3, fit: "fill" })
        .sharpen({ sigma: 1.0, m1: 1.5, m2: 0.7 })
        .modulate({ saturation: 1.15, brightness: 1.0 })
        .linear(1.08, -(0.08 * 128))   // légère hausse de contraste
        .toFormat("jpeg", { quality: 95 })
        .toBuffer()

      console.log(`[upscale] sharp done ${(outputBuf.length/1024).toFixed(0)} KB`)

      const storageKey = `upscaled/${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`
      const { error: upErr } = await supabase.storage.from("clips").upload(storageKey, outputBuf, { contentType: "image/jpeg", upsert: false })
      if (upErr) {
        console.error("[upscale] Supabase upload error:", upErr)
        return res.status(500).json({ error: "Échec de la sauvegarde image" })
      }
      const { data: urlData } = supabase.storage.from("clips").getPublicUrl(storageKey)
      console.log("[upscale] image done:", urlData.publicUrl)
      return res.json({ url: urlData.publicUrl, type: "image" })

    } else {
      // FFmpeg : scale lanczos vers résolution cible + unsharp pour renforcer les détails
      const targetHeight = scale === 4 ? 2160 : 1080
      const outputPath = `/tmp/upscaled_${Date.now()}.mp4`
      console.log(`[upscale] video → ${targetHeight}p lanczos + unsharp`)

      await new Promise((resolve, reject) => {
        ffmpeg(filePath)
          .outputOptions([
            `-vf scale=-2:${targetHeight}:flags=lanczos,unsharp=5:5:1.0:5:5:0.0,eq=contrast=1.1:saturation=1.1`,
            "-c:v libx264", "-preset fast", "-crf 18",
            "-c:a copy", "-movflags faststart",
          ])
          .output(outputPath)
          .on("end", resolve)
          .on("error", (err, _stdout, stderr) => {
            console.error("[upscale] ffmpeg error:", stderr?.slice(-500))
            reject(err)
          })
          .run()
      })
      fs.unlinkSync(filePath)

      const storageKey = `upscaled/${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`
      const storageUrl = await uploadToStorage(outputPath, storageKey, "video/mp4")
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
      if (!storageUrl) return res.status(500).json({ error: "Échec de la sauvegarde vidéo" })
      console.log("[upscale] video done:", storageUrl)
      res.json({ url: storageUrl, type: "video" })
    }
  } catch (err) {
    console.error("[upscale] unexpected error:", err.message, err.stack?.split("\n")[1])
    if (filePath && fs.existsSync(filePath)) try { fs.unlinkSync(filePath) } catch {}
    res.status(500).json({ error: "Erreur upscaling : " + err.message })
  }
})

app.post("/download", genericLimiter, async (req, res) => {
  const safeUrl = sanitizeUrl(req.body.url)
  if (!safeUrl) return res.status(400).json({ error: "URL invalide" })
  const outputPath = path.join("/tmp", `yt_${Date.now()}.mp4`)
  try {
    await execAsync(`yt-dlp --cookies /app/cookies.txt -f "best[ext=mp4]/best" -o "${outputPath}" -- "${safeUrl}"`)
    res.json({ path: outputPath })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post("/thumbnail", genericLimiter, async (req, res) => {
  const safeUrl = sanitizeUrl(req.body.url)
  if (!safeUrl) return res.status(400).json({ error: "URL invalide" })
  try {
    const { stdout } = await execAsync(`yt-dlp --get-thumbnail -- "${safeUrl}"`)
    res.json({ thumbnail: stdout.trim() })
  } catch { res.json({ thumbnail: null }) }
})

app.post("/share", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase non configuré" })
  const { base64, storageUrl, name } = req.body
  if (storageUrl) return res.json({ url: storageUrl })
  if (!base64) return res.status(400).json({ error: "base64 ou storageUrl requis" })
  try {
    const data = base64.includes(",") ? base64.split(",")[1] : base64
    const buffer = Buffer.from(data, "base64")
    const fileName = `shared/${Date.now()}_${(name || "clip").replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "")}.mp4`
    const { error } = await supabase.storage.from("clips").upload(fileName, buffer, { contentType: "video/mp4", upsert: true })
    if (error) throw error
    const { data: urlData } = supabase.storage.from("clips").getPublicUrl(fileName)
    res.json({ url: urlData.publicUrl, fileName })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post("/preview-timestamps", genericLimiter, async (req, res) => {
  const safePaths = (req.body.videoPaths || []).map(sanitizeVideoPath).filter(Boolean)
  if (!safePaths.length) return res.status(400).json({ error: "Aucune vidéo valide" })
  const prompt = sanitizeText(req.body.prompt, 500)
  try {
    const mainInput = safePaths[0]
    const { stdout: durationStr } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${mainInput}"`)
    const totalDuration = parseFloat(durationStr.trim())
    const frames = await extractKeyFrames(mainInput, 4)
    const aiResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-5", max_tokens: 1000,
      messages: [{ role: "user", content: [
        ...frames.map(f => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.data } })),
        { type: "text", text: `Éditeur vidéo expert. Vidéo: ${Math.round(totalDuration)}s. Prompt: "${prompt || "edits dynamiques"}". JSON brut: [{"start":0,"duration":15,"name":"Edit #1","description":"Description courte"}]` }
      ]}]
    })
    const text = aiResponse.content[0].type === "text" ? aiResponse.content[0].text : "[]"
    const parsed = JSON.parse(text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim())
    res.json({ timestamps: parsed, totalDuration })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post("/prompt-help", genericLimiter, async (req, res) => {
  const description = sanitizeText(req.body.description, 500)
  const { refVideoFrames } = req.body
  try {
    const messages = [{ role: "user", content: refVideoFrames
      ? [...refVideoFrames.map(frame => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame } })), { type: "text", text: `Expert edits TikTok. Description: "${description}". Génère un prompt parfait. Uniquement le prompt.` }]
      : [{ type: "text", text: `Expert edits TikTok. L'utilisateur veut: "${description}". Génère un prompt parfait. Uniquement le prompt.` }]
    }]
    const response = await anthropic.messages.create({ model: "claude-sonnet-4-5", max_tokens: 500, messages })
    res.json({ prompt: response.content[0].type === "text" ? response.content[0].text : "" })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post("/analyze-video", genericLimiter, async (req, res) => {
  const videoPath = sanitizeVideoPath(req.body.videoPath)
  if (!videoPath) return res.status(400).json({ error: "videoPath invalide" })
  try {
    const [frames, durationStr, probeOut] = await Promise.all([
      extractKeyFrames(videoPath, 4),
      execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}"`).then(r => r.stdout),
      execAsync(`ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${videoPath}"`).then(r => r.stdout).catch(() => "1080,1920"),
    ])
    const totalDuration = parseFloat(durationStr.trim())
    const [w, h] = probeOut.trim().split(",").map(Number)
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5", max_tokens: 1000,
      messages: [{ role: "user", content: [
        ...frames.map(f => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.data } })),
        { type: "text", text: `Expert montage TikTok/Instagram. Vidéo ${w}x${h} (${Math.round(totalDuration)}s). Analyse et réponds en JSON brut sans backticks:
{
  "contentType": "sport|lifestyle|gaming|music|travel",
  "prompt": "prompt de montage optimisé en français",
  "suggestedFormat": "9:16|16:9",
  "energy": "high|medium|low",
  "description": "description courte en français",
  "subject": {"x_pct": 0.5, "y_pct": 0.3}
}` }
      ]}]
    })
    const text = response.content[0].type === "text" ? response.content[0].text : "{}"
    const analysis = JSON.parse(text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim())
    res.json(analysis)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post("/generate", generateLimiter, async (req, res) => {
  const safePaths = (req.body.videoPaths || []).map(sanitizeVideoPath).filter(Boolean)
  const safeUrls  = (req.body.videoUrls  || []).map(sanitizeUrl).filter(Boolean)
  if (!safeUrls.length && !safePaths.length) return res.status(400).json({ error: "Aucune vidéo valide" })

  const sanitized = {
    videoPaths:   safePaths,
    videoUrls:    safeUrls,
    prompt:       sanitizeText(req.body.prompt, 1000),
    options:      Array.isArray(req.body.options) ? req.body.options.filter(o => typeof o === "string").map(o => o.slice(0, 50)) : [],
    musicUrl:     sanitizeUrl(req.body.musicUrl) || null,
    format:       sanitizeFormat(req.body.format),
    colorGrade:   sanitizeColorGrade(req.body.colorGrade),
    transition:   sanitizeTransition(req.body.transition),
    textOverlay:  sanitizeText(req.body.textOverlay, 200),
    textEffect:   typeof req.body.textEffect === "string" ? req.body.textEffect.slice(0, 20) : "default",
    subtitleStyle: typeof req.body.subtitleStyle === "string" ? req.body.subtitleStyle.slice(0, 20) : "tiktok",
    exportQuality: sanitizeExportQuality(req.body.exportQuality),
    exportCodec:   sanitizeExportCodec(req.body.exportCodec),
    zoomIntensity:  typeof req.body.zoomIntensity  === "number" ? Math.max(0, Math.min(100, req.body.zoomIntensity))  : null,
    speedIntensity: typeof req.body.speedIntensity === "number" ? Math.max(0, Math.min(100, req.body.speedIntensity)) : null,
    vocalVolume:    typeof req.body.vocalVolume    === "number" ? Math.max(0, Math.min(1,   req.body.vocalVolume))    : null,
    capsulesCount:  typeof req.body.capsulesCount  === "number" ? Math.max(1, Math.min(20,  Math.round(req.body.capsulesCount))) : 4,
    addIntroOutro:  !!req.body.addIntroOutro,
    stabilize:      !!req.body.stabilize,
    watermark:      !!req.body.watermark,
    isCapsule:      !!req.body.isCapsule,
    customTimestamps: Array.isArray(req.body.customTimestamps) ? req.body.customTimestamps.slice(0, 20) : null,
  }

  const jobId = `job_${Date.now()}`
  jobs[jobId] = { status: "processing", progress: 0, clips: null, error: null }
  res.json({ jobId })
  processVideo({ jobId, ...sanitized })
})

app.get("/status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId]
  if (!job) return res.status(404).json({ error: "Job introuvable" })
  res.json(job)
})

setInterval(() => {
  const now = Date.now()
  for (const jobId of Object.keys(jobs)) {
    const job = jobs[jobId]
    if ((job.status === "done" || job.status === "error") && job.completedAt && now - job.completedAt > 30 * 60 * 1000) {
      delete jobs[jobId]; delete sseClients[jobId]
    }
  }
}, 5 * 60 * 1000)

// ─── HELPERS ───────────────────────────────────────────────────────────────

async function extractKeyFrames(videoPath, count = 4) {
  const frames = []
  try {
    const { stdout: durationStr } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}"`)
    const duration = parseFloat(durationStr.trim())
    const interval = duration / (count + 1)
    const promises = []
    for (let i = 1; i <= count; i++) {
      const timestamp = (interval * i).toFixed(2)
      const framePath = path.join("/tmp", `frame_${Date.now()}_${i}.jpg`)
      promises.push(
        execAsync(`ffmpeg -i "${videoPath}" -ss ${timestamp} -vframes 1 -q:v 3 -vf "scale=320:-1" "${framePath}" -y 2>/dev/null`)
          .then(() => {
            if (fs.existsSync(framePath)) {
              const data = fs.readFileSync(framePath).toString("base64")
              fs.unlinkSync(framePath)
              return { timestamp: parseFloat(timestamp), data }
            }
            return null
          })
          .catch(() => null)
      )
    }
    const results = await Promise.all(promises)
    return results.filter(Boolean)
  } catch (e) { console.error("extractKeyFrames:", e.message); return [] }
}

async function detectBeats(musicPath) {
  try {
    const tmpAudio = musicPath + "_beats.raw"
    await execAsync(`ffmpeg -i "${musicPath}" -ac 1 -ar 22050 -f f32le "${tmpAudio}" -y 2>/dev/null`)
    if (!fs.existsSync(tmpAudio)) return { bpm: 120, beats: [] }
    const buffer = fs.readFileSync(tmpAudio)
    fs.unlinkSync(tmpAudio)
    const samples = new Float32Array(buffer.buffer)
    const sampleRate = 22050
    const windowSize = Math.floor(sampleRate * 0.05)
    const energies = []
    for (let i = 0; i < samples.length - windowSize; i += windowSize) {
      let energy = 0
      for (let j = 0; j < windowSize; j++) energy += samples[i + j] ** 2
      energies.push({ time: i / sampleRate, energy: energy / windowSize })
    }
    const avgEnergy = energies.reduce((s, e) => s + e.energy, 0) / energies.length
    const threshold = avgEnergy * 1.5
    const beats = []
    let lastBeat = -0.3
    for (const e of energies) {
      if (e.energy > threshold && e.time - lastBeat > 0.25) { beats.push(parseFloat(e.time.toFixed(3))); lastBeat = e.time }
    }
    if (beats.length > 2) {
      const intervals = []
      for (let i = 1; i < Math.min(beats.length, 20); i++) intervals.push(beats[i] - beats[i-1])
      const avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length
      return { bpm: Math.round(60 / avgInterval), beats: beats.slice(0, 60) }
    }
    return { bpm: 120, beats }
  } catch { return { bpm: 120, beats: [] } }
}

async function scoreSegmentsByMotion(videoPath, totalDuration, count = 6) {
  const segmentDuration = totalDuration / count
  const promises = []
  for (let i = 0; i < count; i++) {
    const start = i * segmentDuration
    promises.push(
      execAsync(`ffmpeg -ss ${start.toFixed(2)} -t ${segmentDuration.toFixed(2)} -i "${videoPath}" -vf "select='gt(scene,0.1)',metadata=print:file=-" -f null /dev/null 2>&1 | grep -c "lavfi.scene_score" || echo 0`)
        .then(({ stdout }) => ({ start, duration: segmentDuration, motionScore: parseInt(stdout.trim()) || 0 }))
        .catch(() => ({ start, duration: segmentDuration, motionScore: 0 }))
    )
  }
  const results = await Promise.all(promises)
  return results.sort((a, b) => b.motionScore - a.motionScore)
}

function getQualitySettings(exportQuality, exportCodec) {
  const qualityMap = { "720p": { scale:"1280:720", crf:26, bitrate:3000 }, "1080p": { scale:"1920:1080", crf:22, bitrate:5000 }, "4K": { scale:"3840:2160", crf:18, bitrate:12000 } }
  const codecMap = { "H264": "libx264", "H265": "libx265", "VP9": "libvpx-vp9" }
  const q = qualityMap[exportQuality] || qualityMap["1080p"]
  return { ...q, codec: codecMap[exportCodec] || "libx264" }
}

function getFormatFilter(format, scale, subjectX, subjectY) {
  const formats = { "9:16": { w:1080, h:1920 }, "16:9": { w:1920, h:1080 }, "1:1": { w:1080, h:1080 }, "4:5": { w:1080, h:1350 } }
  const target = formats[format] || formats["9:16"]
  const tw = scale ? parseInt(scale.split(":")[0]) : target.w
  const th = scale ? parseInt(scale.split(":")[1]) : target.h
  if (subjectX !== undefined && subjectY !== undefined) {
    const xPct = Math.max(0.1, Math.min(0.9, subjectX))
    const yPct = Math.max(0.1, Math.min(0.9, subjectY))
    return `scale=${tw * 2}:${th * 2}:force_original_aspect_ratio=increase,crop=${tw}:${th}:iw*${xPct.toFixed(2)}-${tw}/2:ih*${yPct.toFixed(2)}-${th}/2`
  }
  return `scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:black`
}

function getColorGradeFilter(grade) {
  const grades = {
    "cinematic":   "curves=r='0/0 0.2/0.15 0.8/0.9 1/1':g='0/0 0.2/0.18 0.8/0.85 1/1':b='0/0.05 0.5/0.55 1/0.95',eq=saturation=1.2:contrast=1.1",
    "orange_teal": "colorchannelmixer=rr=1.1:rb=-0.05:gr=-0.05:gg=0.95:gb=0.1:br=-0.1:bg=0.1:bb=1.15,eq=saturation=1.3",
    "bw":          "hue=s=0,eq=contrast=1.3:brightness=0.05",
    "vibrant":     "eq=saturation=1.6:contrast=1.05:brightness=0.02",
    "moody":       "curves=r='0/0 0.3/0.25 0.7/0.65 1/0.9':g='0/0 0.3/0.27 0.7/0.67 1/0.92':b='0/0.05 0.3/0.32 0.7/0.72 1/1',eq=saturation=0.9:contrast=1.15",
    "warm":        "curves=r='0/0.05 0.5/0.58 1/1':g='0/0 0.5/0.5 1/0.95':b='0/0 0.5/0.44 1/0.88',eq=saturation=1.1",
    "cold":        "curves=r='0/0 0.5/0.44 1/0.9':g='0/0 0.5/0.5 1/0.97':b='0/0.04 0.5/0.56 1/1',eq=saturation=1.05",
  }
  return grades[grade] || null
}


async function detectSceneCuts(inputPath) {
  try {
    const { stdout } = await execAsync(`ffprobe -v quiet -show_frames -select_streams v -skip_frame noref -show_entries frame=pkt_pts_time,pict_type -of csv "${inputPath}" 2>/dev/null | grep ",I" | head -50`)
    return stdout.trim().split("\n").map(line => parseFloat(line.split(",")[0])).filter(t => !isNaN(t))
  } catch { return [] }
}

function buildTransitionFilter(transition, clipDuration) {
  if (!transition || transition === "none") return null
  const transitions = {
    "flash":   `fade=t=in:st=0:d=0.08:color=white,fade=t=out:st=${(clipDuration-0.08).toFixed(2)}:d=0.08:color=white`,
    "fade":    `fade=t=in:st=0:d=0.2,fade=t=out:st=${(clipDuration-0.2).toFixed(2)}:d=0.2`,
    "glitch":  `rgbashift=rh=3:rv=-3:gh=0:gv=0:bh=-3:bv=3`,
    "zoom_in": `zoompan=z='min(zoom+0.002,1.1)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
  }
  return transitions[transition] || null
}

function buildWatermarkFilter(format) {
  const formats = { "9:16": { w:1080, h:1920 }, "16:9": { w:1920, h:1080 }, "1:1": { w:1080, h:1080 }, "4:5": { w:1080, h:1350 } }
  const target = formats[format] || formats["9:16"]
  const fontSize = Math.floor(target.w * 0.032)
  return `drawtext=text='CLIMB':fontsize=${fontSize}:fontcolor=white:x=w-tw-${Math.floor(target.w*0.025)}:y=${Math.floor(target.h*0.018)}:alpha=0.35:shadowcolor=black:shadowx=1:shadowy=1`
}

function buildTextOverlayFilter(text, clipDuration, format, effect) {
  if (!text) return null
  const formats = { "9:16": { w:1080, h:1920 }, "16:9": { w:1920, h:1080 }, "1:1": { w:1080, h:1080 }, "4:5": { w:1080, h:1350 } }
  const target = formats[format] || formats["9:16"]
  const fontSize = Math.floor(target.w * 0.07)
  const yPos = Math.floor(target.h * 0.5)
  const escapedText = text.replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/\[/g, "\\[").replace(/\]/g, "\\]")
  switch (effect) {
    case "slide":      return `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=${yPos}+h*0.08*(1-min(t/0.35,1)):alpha='min(t/0.25,1)':shadowcolor=black:shadowx=2:shadowy=2`
    case "bounce":     return `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=${yPos}-abs(sin(t*10)*${Math.floor(fontSize*0.5)})*max(0,1-t/0.6):alpha='min(t/0.15,1)':shadowcolor=black:shadowx=2:shadowy=2`
    case "typewriter": return `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=${yPos}:alpha='if(lt(t,0.05),0,min((t-0.05)/0.3,1))':shadowcolor=black:shadowx=2:shadowy=2`
    case "zoom":       return `drawtext=text='${escapedText}':fontsize=${fontSize}*(0.5+min(t/0.3,1)*0.5):fontcolor=white:x=(w-text_w)/2:y=${yPos}:alpha='min(t/0.2,1)':shadowcolor=black:shadowx=2:shadowy=2`
    case "neon":       return `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=#00ff88:x=(w-text_w)/2:y=${yPos}:alpha='if(lt(t,0.3),t/0.3,if(gt(t,${(clipDuration-0.3).toFixed(2)}),(${clipDuration.toFixed(2)}-t)/0.3,1))':shadowcolor=#00ff88:shadowx=0:shadowy=0`
    default:           return `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=${yPos}:alpha='if(lt(t,0.3),t/0.3,if(gt(t,${(clipDuration-0.3).toFixed(2)}),(${clipDuration.toFixed(2)}-t)/0.3,1))':shadowcolor=black:shadowx=2:shadowy=2`
  }
}

function buildStyledSubtitlesFilter(subtitles, clipStart, clipDuration, format, style) {
  if (!subtitles?.length) return null
  const formats = { "9:16": { w:1080, h:1920 }, "16:9": { w:1920, h:1080 }, "1:1": { w:1080, h:1080 }, "4:5": { w:1080, h:1350 } }
  const target = formats[format] || formats["9:16"]
  const fontSize = Math.floor(target.w * 0.065)
  const yPos = Math.floor(target.h * 0.72)
  const clipSubs = subtitles.filter(s => s.start >= clipStart && s.start < clipStart + clipDuration)
  if (!clipSubs.length) return null
  const styles = {
    "tiktok":    { color:"white",   box:1, boxcolor:"black@0.6",  boxborderw:8 },
    "yellow":    { color:"yellow",  box:1, boxcolor:"black@0.7",  boxborderw:8 },
    "white_box": { color:"black",   box:1, boxcolor:"white@0.9",  boxborderw:10 },
    "neon":      { color:"#00ff88", box:1, boxcolor:"black@0.5",  boxborderw:6 },
  }
  const s = styles[style] || styles["tiktok"]
  return clipSubs.map(sub => {
    const relStart = (sub.start - clipStart).toFixed(3)
    const relEnd = (sub.end - clipStart).toFixed(3)
    const escapedText = (sub.text || "").replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/\[/g, "\\[").replace(/\]/g, "\\]").toUpperCase()
    return `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=${s.color}:x=(w-text_w)/2:y=${yPos}:box=${s.box}:boxcolor=${s.boxcolor}:boxborderw=${s.boxborderw}:enable='between(t,${relStart},${relEnd})':shadowcolor=black:shadowx=2:shadowy=2`
  }).join(",")
}

function buildIntroOutroFilter(clipDuration, format) {
  const formats = { "9:16": { w:1080, h:1920 }, "16:9": { w:1920, h:1080 }, "1:1": { w:1080, h:1080 }, "4:5": { w:1080, h:1350 } }
  const target = formats[format] || formats["9:16"]
  const fontSize = Math.floor(target.w * 0.11)
  const introAlpha = `if(lt(t,1.2),t/1.2,if(lt(t,2.4),1,0))`
  const outroAlpha = `if(gt(t,${(clipDuration-1.5).toFixed(2)}),(t-${(clipDuration-1.5).toFixed(2)})/1.5,0)`
  return [`drawtext=text='CLIMB':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:alpha='${introAlpha}'`, `drawtext=text='CLIMB':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:alpha='${outroAlpha}'`].join(",")
}

async function analyzeEffects(prompt, totalDuration, options, zoomIntensity, speedIntensity) {
  const needsZoom = options?.includes("Auto-zoom")
  const needsSpeedRamp = options?.includes("Speed ramp")
  if (!needsZoom && !needsSpeedRamp) return null
  const zoomMax = zoomIntensity ? 1 + (zoomIntensity/100)*0.3 : 1.15
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5", max_tokens: 400,
      messages: [{ role: "user", content: `Expert montage TikTok. Prompt: "${prompt || "edit dynamique"}". Vidéo: ${Math.round(totalDuration)}s. JSON brut: {"autozoom":{"enabled":${needsZoom},"intensity":${zoomMax.toFixed(2)}},"speedramp":{"enabled":${needsSpeedRamp},"segments":[{"start_pct":0,"end_pct":0.25,"speed":1.5},{"start_pct":0.25,"end_pct":0.6,"speed":0.7},{"start_pct":0.6,"end_pct":1.0,"speed":1.8}]}}` }]
    })
    const text = response.content[0].type === "text" ? response.content[0].text : ""
    return JSON.parse(text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim())
  } catch {
    return { autozoom:{ enabled:needsZoom, intensity:zoomMax }, speedramp:{ enabled:needsSpeedRamp, segments:[{ start_pct:0, end_pct:0.5, speed:1.5 },{ start_pct:0.5, end_pct:1.0, speed:0.8 }] } }
  }
}

async function uploadToStorage(filePath, storagePath, contentType) {
  if (!supabase || !fs.existsSync(filePath)) return null
  try {
    const buffer = fs.readFileSync(filePath)
    const { error } = await supabase.storage.from("clips").upload(storagePath, buffer, { contentType, upsert: false })
    if (error) throw error
    const { data } = supabase.storage.from("clips").getPublicUrl(storagePath)
    return data.publicUrl
  } catch (e) { console.error("uploadToStorage:", e.message); return null }
}

// ─── GÉNÉRATION CAPSULES (bypass duplicate detection) ──────────────────────

function buildCapsuleTimestamps(totalDuration, count) {
  const MIN_GAP = 2      // min seconds between consecutive start times
  const MIN_DUR = 3      // min clip duration in seconds
  // Each capsule occupies an equal slot of the total video
  const slotSize = totalDuration / count
  // Clip duration: 75% of the slot, clamped between 5s and 60s
  const clipDuration = Math.min(60, Math.max(5, slotSize * 0.75))

  const capsules = []
  for (let i = 0; i < count; i++) {
    // Start 15% into each slot so capsules are truly from different parts of the video
    const start = parseFloat((i * slotSize + slotSize * 0.15).toFixed(2))
    const available = totalDuration - start - 0.1
    const duration = parseFloat(Math.min(clipDuration, Math.max(MIN_DUR, available)).toFixed(2))
    if (start < totalDuration - MIN_DUR) {
      capsules.push({ start, duration, name: `Capsule #${i+1}` })
    }
  }

  // Enforce minimum gap between consecutive start times
  for (let i = 1; i < capsules.length; i++) {
    const minStart = parseFloat((capsules[i-1].start + MIN_GAP).toFixed(2))
    if (capsules[i].start < minStart) {
      capsules[i].start = minStart
      const available = totalDuration - minStart - 0.1
      capsules[i].duration = parseFloat(Math.min(clipDuration, Math.max(MIN_DUR, available)).toFixed(2))
    }
  }

  return capsules.filter(c => c.duration >= MIN_DUR && c.start + c.duration <= totalDuration + 0.5)
}

// ─── MAIN PROCESS ──────────────────────────────────────────────────────────

async function processVideo({ jobId, videoUrls, videoPaths, prompt, options, musicUrl, format, zoomIntensity, speedIntensity, addIntroOutro, customTimestamps, colorGrade, transition, textOverlay, textEffect, stabilize, vocalVolume, watermark, exportQuality, exportCodec, subtitleStyle, capsulesCount, isCapsule }) {
  const tmpDir = "/tmp"
  const inputPaths = []
  const clips = []

  try {
    updateJob(jobId, { status:"processing", progress:5 })

    for (let i = 0; i < (videoUrls||[]).length; i++) {
      const url = videoUrls[i]
      const inputPath = path.join(tmpDir, `input_${Date.now()}_${i}.mp4`)
      const response = await axios({ url, method:"GET", responseType:"stream" })
      const writer = fs.createWriteStream(inputPath)
      response.data.pipe(writer)
      await new Promise((resolve, reject) => { writer.on("finish", resolve); writer.on("error", reject) })
      inputPaths.push(inputPath)
    }
    for (const p of (videoPaths||[])) {
      if (fs.existsSync(p)) inputPaths.push(p)
      else console.warn(`processVideo: videoPaths file not found: ${p}`)
    }

    if (inputPaths.length === 0) throw new Error(`Aucun fichier vidéo accessible (videoPaths=${JSON.stringify(videoPaths)}, videoUrls=${JSON.stringify(videoUrls)})`)

    updateJob(jobId, { progress:15 })

    let mainInput = inputPaths[0]
    if (inputPaths.length > 1) {
      const listPath = path.join(tmpDir, `list_${Date.now()}.txt`)
      const concatPath = path.join(tmpDir, `concat_${Date.now()}.mp4`)
      fs.writeFileSync(listPath, inputPaths.map(p => `file '${p}'`).join("\n"))
      await new Promise((resolve, reject) => {
        ffmpeg().input(listPath).inputOptions(["-f","concat","-safe","0"]).outputOptions(["-c copy"]).output(concatPath).on("end", resolve).on("error", reject).run()
      })
      mainInput = concatPath; fs.unlinkSync(listPath)
    }

    const { stdout: durationStr } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${mainInput}"`)
    const totalDuration = parseFloat(durationStr.trim())

    // ─── MODE CAPSULE : pas d'analyse IA, juste des décalages ──────────────
    if (isCapsule) {
      updateJob(jobId, { progress:30, message:"Génération des capsules... 📦" })
      const count = capsulesCount || 4
      const durations = buildCapsuleTimestamps(totalDuration, count)
      const targetFormat = format || "9:16"
      const capsuleScale = "1280:720"
      const formatFilter = getFormatFilter(targetFormat, capsuleScale)

      for (let ci = 0; ci < durations.length; ci++) {
        const clip = durations[ci]
        const outputPath = path.join(tmpDir, `capsule_${ci}_${Date.now()}.mp4`)

        await new Promise((resolve, reject) => {
          ffmpeg(mainInput)
            .setStartTime(clip.start)
            .setDuration(clip.duration)
            .outputOptions([
              "-movflags faststart",
              "-c:v libx264",
              "-preset slow",
              "-crf 18",
              `-vf ${formatFilter}`,
              "-map_metadata -1",
              "-threads 2",
              "-c:a aac", "-b:a 128k",
            ])
            .output(outputPath)
            .on("end", resolve)
            .on("error", (err, stdout, stderr) => { console.error("FFmpeg capsule:", stderr?.slice(-300)); reject(err) })
            .run()
        })

        // Upload to storage — no base64 fallback to avoid loading whole video into RAM
        const uniqueId = `${Date.now()}_${ci}`
        const storageUrl = await uploadToStorage(outputPath, `clips/${uniqueId}.mp4`, "video/mp4")
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)

        // Thumbnail — small, safe to base64 as fallback
        let thumbnail = null
        const thumbPath = path.join(tmpDir, `thumb_${ci}_${Date.now()}.jpg`)
        try {
          await execAsync(`ffmpeg -ss ${clip.start + 0.5} -i "${mainInput}" -vframes 1 -q:v 5 -vf "scale=320:-2" "${thumbPath}" -y 2>/dev/null`)
          const thumbStorageUrl = await uploadToStorage(thumbPath, `thumbs/${uniqueId}.jpg`, "image/jpeg")
          if (thumbStorageUrl) {
            thumbnail = thumbStorageUrl
          } else if (fs.existsSync(thumbPath)) {
            thumbnail = `data:image/jpeg;base64,${fs.readFileSync(thumbPath).toString("base64")}`
          }
        } catch {}
        if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath)

        clips.push({ name: clip.name, storageUrl, base64: null, thumbnail, duration: clip.duration })
        updateJob(jobId, { progress: 30 + Math.floor((ci + 1) / durations.length * 70) })

        // Explicit GC hint between clips
        if (global.gc) global.gc()
      }

      for (const p of inputPaths) { if (fs.existsSync(p)) try { fs.unlinkSync(p) } catch {} }
      updateJob(jobId, { status:"done", progress:100, clips, completedAt: Date.now() })
      return
    }

    // ─── MODE NORMAL ────────────────────────────────────────────────────────
    updateJob(jobId, { progress:20, message:"Analyse du contenu... 🔍" })
    const keyFrames = await extractKeyFrames(mainInput, 4)

    updateJob(jobId, { progress:25 })

    if (stabilize) {
      try {
        const stabPath = path.join(tmpDir, `stab_${Date.now()}.mp4`)
        const transformsPath = path.join(tmpDir, `transforms_${Date.now()}.trf`)
        await new Promise((resolve, reject) => { ffmpeg(mainInput).outputOptions([`-vf vidstabdetect=stepsize=6:shakiness=8:accuracy=9:result=${transformsPath}`,"-f null"]).output("/dev/null").on("end", resolve).on("error", reject).run() })
        await new Promise((resolve, reject) => { ffmpeg(mainInput).outputOptions([`-vf vidstabtransform=input=${transformsPath}:zoom=1:smoothing=15,unsharp=5:5:0.8:3:3:0.4`,"-c:v libx264","-c:a copy"]).output(stabPath).on("end", resolve).on("error", reject).run() })
        if (fs.existsSync(stabPath)) mainInput = stabPath
        if (fs.existsSync(transformsPath)) fs.unlinkSync(transformsPath)
      } catch (e) { console.error("Stabilisation:", e.message) }
    }

    updateJob(jobId, { progress:28 })

    let musicPath = null
    if (musicUrl) {
      try {
        musicPath = path.join(tmpDir, `music_${Date.now()}.mp3`)
        const musicResponse = await axios({ url:musicUrl, method:"GET", responseType:"stream" })
        const musicWriter = fs.createWriteStream(musicPath)
        musicResponse.data.pipe(musicWriter)
        await new Promise((resolve, reject) => { musicWriter.on("finish", resolve); musicWriter.on("error", reject) })
      } catch { musicPath = null }
    }

    updateJob(jobId, { progress:32, message:"Analyse audio et mouvement... 🎵" })
    const [beatData, sceneCuts, motionSegments, effects] = await Promise.all([
      options?.includes("Beat sync") ? detectBeats(musicPath || mainInput) : Promise.resolve(null),
      detectSceneCuts(mainInput),
      scoreSegmentsByMotion(mainInput, totalDuration),
      analyzeEffects(prompt, totalDuration, options, zoomIntensity, speedIntensity),
    ])

    let subtitles = []
    if (options?.includes("Sous-titres")) {
      updateJob(jobId, { progress:38, message:"Transcription audio... 📝" })
      try {
        const transcript = await aai.transcripts.transcribe({ audio:mainInput, language_detection:true })
        if (transcript.words) subtitles = transcript.words.map(w => ({ text:w.text, start:w.start/1000, end:w.end/1000 }))
      } catch (e) { console.error("Transcription:", e.message) }
    }

    updateJob(jobId, { progress:42, message:"L'IA choisit tes meilleures séquences... 🎬" })

    let durations = customTimestamps?.length > 0 ? customTimestamps : null
    let subjectPos = null

    if (!durations) {
      try {
        const beatContext = beatData?.beats?.length > 0 ? `Beats à: ${beatData.beats.slice(0,15).join(", ")}s (BPM: ${beatData.bpm}).` : ""
        const sceneContext = sceneCuts.length > 0 ? `Scènes à: ${sceneCuts.slice(0,8).map(t => t.toFixed(1)).join(", ")}s.` : ""
        const motionContext = motionSegments.slice(0,3).map(s => `${s.start.toFixed(1)}s (score: ${s.motionScore})`).join(", ")
        const frameTimings = keyFrames.map((f, i) => `Frame ${i+1} à ${f.timestamp}s`).join(", ")

        const aiResponse = await anthropic.messages.create({
          model: "claude-sonnet-4-5", max_tokens: 1200,
          messages: [{ role:"user", content: [
            ...keyFrames.map(f => ({ type:"image", source:{ type:"base64", media_type:"image/jpeg", data:f.data } })),
            { type:"text", text:`Expert montage TikTok. Frames: ${frameTimings}. Vidéo: ${Math.round(totalDuration)}s. Prompt: "${prompt || "edits dynamiques"}". ${beatContext} ${sceneContext} Meilleur mouvement: ${motionContext}.
Réponds en JSON brut:
{
  "timestamps": [{"start":0,"duration":15,"name":"Edit #1"}],
  "subject": {"x_pct":0.5,"y_pct":0.3}
}
Règles timestamps: start+duration<=${Math.round(totalDuration)}, durées 10-30s.` }
          ]}]
        })
        const aiText = aiResponse.content[0].type === "text" ? aiResponse.content[0].text : ""
        const parsed = JSON.parse(aiText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim())
        if (parsed.timestamps && Array.isArray(parsed.timestamps) && parsed.timestamps.length > 0) {
          durations = parsed.timestamps.map((d, i) => ({
            start: Math.max(0, Math.min(d.start, totalDuration-(d.duration||15))),
            duration: Math.min(d.duration||15, totalDuration),
            name: d.name || `Edit #${i+1}`
          }))
        }
        if (parsed.subject) subjectPos = parsed.subject
      } catch (e) { console.error("Erreur IA clips:", e.message) }
    }

    if (!durations) durations = [{ start:0, duration:15, name:"Edit #1" },{ start:10, duration:20, name:"Edit #2" },{ start:25, duration:15, name:"Edit #3" }]

    updateJob(jobId, { progress:48, message:"Rendu des clips... ✨" })

    const targetFormat = format || "9:16"
    const { scale, crf, bitrate, codec } = getQualitySettings(exportQuality, exportCodec)
    const formatFilter = getFormatFilter(targetFormat, scale, subjectPos?.x_pct, subjectPos?.y_pct)
    for (let ci = 0; ci < durations.length; ci++) {
      const clip = durations[ci]
      const outputPath = path.join(tmpDir, `clip_${ci}_${Date.now()}.mp4`)
      const vfFilters = []
      let atempoVal = "1.0"

      if (effects?.speedramp?.enabled && effects.speedramp.segments?.length > 0) {
        const avgSpeed = effects.speedramp.segments.reduce((s, seg) => s+seg.speed, 0) / effects.speedramp.segments.length
        const clampedSpeed = Math.max(0.5, Math.min(2.0, avgSpeed))
        vfFilters.push(`setpts=${(1/clampedSpeed).toFixed(3)}*PTS`)
        atempoVal = clampedSpeed.toFixed(2)
      }

      vfFilters.push(formatFilter)

      if (effects?.autozoom?.enabled) {
        const intensity = Math.min(effects.autozoom.intensity||1.15, 1.3)
        vfFilters.push(`scale=iw*${intensity.toFixed(3)}:ih*${intensity.toFixed(3)},crop=iw/${intensity.toFixed(3)}:ih/${intensity.toFixed(3)}`)
      }

      const gradeFilter = getColorGradeFilter(colorGrade)
      if (gradeFilter) vfFilters.push(gradeFilter)
      vfFilters.push(`noise=alls=4:allf=t+u`)
      vfFilters.push(`vignette=PI/5`)

      const transFilter = buildTransitionFilter(transition, clip.duration)
      if (transFilter) vfFilters.push(transFilter)

      const textFilter = buildTextOverlayFilter(textOverlay, clip.duration, targetFormat, textEffect || "default")
      if (textFilter) vfFilters.push(textFilter)

      if (subtitles.length > 0) {
        const styledSubFilter = buildStyledSubtitlesFilter(subtitles, clip.start, clip.duration, targetFormat, subtitleStyle || "tiktok")
        if (styledSubFilter) vfFilters.push(styledSubFilter)
      }

      if (watermark) vfFilters.push(buildWatermarkFilter(targetFormat))
      if (addIntroOutro) vfFilters.push(buildIntroOutroFilter(clip.duration, targetFormat))

      const vfString = vfFilters.join(",")

      // Build atempo chain for speed-ramped audio
      let atempoChain = ""
      if (atempoVal !== "1.0") {
        const speed = parseFloat(atempoVal)
        if (speed >= 0.5 && speed <= 2.0) atempoChain = `,atempo=${speed}`
        else if (speed > 2.0) atempoChain = `,atempo=2.0,atempo=${(speed/2.0).toFixed(2)}`
        else if (speed < 0.5) atempoChain = `,atempo=0.5,atempo=${(speed/0.5).toFixed(2)}`
      }
      const vocalVol = vocalVolume !== undefined ? vocalVolume : 0.3

      await new Promise((resolve, reject) => {
        let cmd = ffmpeg(mainInput).setStartTime(clip.start).setDuration(clip.duration)
        const baseOpts = [
          "-movflags faststart", `-c:v ${codec}`, "-preset fast", `-crf ${crf}`,
          "-map_metadata -1",
          `-b:v ${Math.floor(bitrate+Math.random()*500)}k`,
          `-maxrate ${Math.floor(bitrate*1.4+Math.random()*500)}k`,
          `-bufsize ${bitrate*2}k`,
        ]
        let outputOpts
        if (musicPath && fs.existsSync(musicPath)) {
          // Mix voice (from video) + music with amix — vocalVol controls voice level
          cmd = cmd.input(musicPath)
          const fc = `[0:v]${vfString}[vout];[0:a]volume=${vocalVol}${atempoChain}[va];[1:a]volume=0.85[ma];[va][ma]amix=inputs=2:duration=first[aout]`
          outputOpts = [...baseOpts, "-c:a aac", "-b:a 192k", `-filter_complex ${fc}`, "-map [vout]", "-map [aout]", "-shortest"]
        } else {
          const audioFilters = atempoChain ? [atempoChain.slice(1)] : []
          outputOpts = [...baseOpts, `-vf ${vfString}`, "-c:a aac", "-b:a 192k"]
          if (audioFilters.length > 0) outputOpts.push(`-af ${audioFilters.join(",")}`)
        }
        cmd.outputOptions(outputOpts).output(outputPath)
          .on("end", resolve)
          .on("error", (err, stdout, stderr) => { console.error("FFmpeg:", stderr?.slice(-500)); reject(err) })
          .run()
      })

      const thumbPath = path.join(tmpDir, `thumb_${ci}_${Date.now()}.jpg`)
      try { await execAsync(`ffmpeg -i "${outputPath}" -ss 0.5 -vframes 1 -q:v 2 "${thumbPath}" -y 2>/dev/null`) } catch {}

      const uniqueId = `${Date.now()}_${ci}_${Math.random().toString(36).slice(2)}`
      const storageUrl = await uploadToStorage(outputPath, `clips/${uniqueId}.mp4`, "video/mp4")
      const thumbStorageUrl = await uploadToStorage(thumbPath, `thumbs/${uniqueId}.jpg`, "image/jpeg")

      let base64 = null
      if (!storageUrl) {
        console.warn(`Storage failed for clip ${ci}, fallback base64`)
        base64 = `data:video/mp4;base64,${fs.readFileSync(outputPath).toString("base64")}`
      }
      let thumbBase64 = null
      if (!thumbStorageUrl && fs.existsSync(thumbPath)) thumbBase64 = `data:image/jpeg;base64,${fs.readFileSync(thumbPath).toString("base64")}`

      if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath)
      fs.unlinkSync(outputPath)

      clips.push({ name: clip.name || `Edit #${ci+1}`, base64, storageUrl, thumbnail: thumbStorageUrl || thumbBase64, duration: clip.duration })
      updateJob(jobId, { progress: 48 + Math.floor((ci+1) / durations.length * 52) })
    }

    if (musicPath && fs.existsSync(musicPath)) fs.unlinkSync(musicPath)
    for (const p of inputPaths) { if (fs.existsSync(p)) try { fs.unlinkSync(p) } catch {} }

    updateJob(jobId, { status:"done", progress:100, clips, completedAt: Date.now() })

  } catch (err) {
    console.error(err)
    for (const p of inputPaths) { if (fs.existsSync(p)) try { fs.unlinkSync(p) } catch {} }
    updateJob(jobId, { status:"error", progress:0, error:err.message, completedAt: Date.now() })
  }
}

// ── Retouch helpers ──────────────────────────────────────────────────────────

const Jimp = require('jimp')

// ── Gommage — inpainting directionnel + PatchMatch NNF top-3 ─────────────────

// ── Inpainting utilitaires ────────────────────────────────────────────────────

function diffuse(px, mask, w, h, passes) {
  for (let pass = 0; pass < passes; pass++) {
    const snap = new Uint8ClampedArray(px.length); snap.set(px)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y*w+x; if (!mask[i]) continue
        let r = 0, g = 0, b = 0, wt = 0
        const i4 = i*4
        if (x > 0)   { const j=(i-1)*4; r+=snap[j]; g+=snap[j+1]; b+=snap[j+2]; wt++ }
        if (x < w-1) { const j=(i+1)*4; r+=snap[j]; g+=snap[j+1]; b+=snap[j+2]; wt++ }
        if (y > 0)   { const j=(i-w)*4; r+=snap[j]; g+=snap[j+1]; b+=snap[j+2]; wt++ }
        if (y < h-1) { const j=(i+w)*4; r+=snap[j]; g+=snap[j+1]; b+=snap[j+2]; wt++ }
        if (!wt) continue
        px[i4] = r/wt; px[i4+1] = g/wt; px[i4+2] = b/wt
      }
    }
  }
}

function detectStructure(px, origMask, w, h) {
  const border = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y*w+x; if (origMask[i]) continue
      if ((x > 0 && origMask[i-1]) || (x < w-1 && origMask[i+1]) ||
          (y > 0 && origMask[i-w]) || (y < h-1 && origMask[i+w])) border.push(i)
    }
  }
  if (!border.length) return 'flat'
  let mr = 0, mg = 0, mb = 0
  for (const i of border) { mr += px[i*4]; mg += px[i*4+1]; mb += px[i*4+2] }
  mr /= border.length; mg /= border.length; mb /= border.length
  let v = 0
  for (const i of border) {
    const dr = px[i*4]-mr, dg = px[i*4+1]-mg, db = px[i*4+2]-mb
    v += dr*dr + dg*dg + db*db
  }
  v /= border.length
  if (v < 20) return 'flat'
  if (v < 4000) return 'gradient'
  return 'texture'
}

function flatFillMedian(px, origMask, w, h) {
  const R = 15, rs = [], gs = [], bs = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y*w+x; if (!origMask[i]) continue
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const nx = x+dx, ny = y+dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const ni = ny*w+nx; if (origMask[ni]) continue
          rs.push(px[ni*4]); gs.push(px[ni*4+1]); bs.push(px[ni*4+2])
        }
      }
    }
  }
  if (!rs.length) return
  rs.sort((a,b)=>a-b); gs.sort((a,b)=>a-b); bs.sort((a,b)=>a-b)
  const mr = rs[rs.length>>1], mg = gs[gs.length>>1], mb = bs[bs.length>>1]
  for (let i = 0; i < w*h; i++) {
    if (!origMask[i]) continue
    px[i*4] = mr; px[i*4+1] = mg; px[i*4+2] = mb; px[i*4+3] = 255
  }
}

// ── PatchMatch 11×11, radius 60px, top-5 candidats + selection par coherence couleur ──
function patchMatchFill(px, origMask, w, h) {
  const HALF   = 7   // patch 15×15
  const RADIUS = 35  // rayon de recherche
  const K      = 30  // candidats aleatoires par pixel

  // BFS : bords du masque en premier, puis vers l'interieur
  const queued = new Uint8Array(w * h)
  const bfsQ   = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y*w+x; if (!origMask[i]) continue
      if ((x > 0 && !origMask[i-1]) || (x < w-1 && !origMask[i+1]) ||
          (y > 0 && !origMask[i-w]) || (y < h-1 && !origMask[i+w])) {
        bfsQ.push(i); queued[i] = 1
      }
    }
  }
  for (let qi = 0; qi < bfsQ.length; qi++) {
    const i = bfsQ[qi], x = i%w, y = (i/w)|0
    if (x > 0   && origMask[i-1] && !queued[i-1]) { queued[i-1]=1; bfsQ.push(i-1) }
    if (x < w-1 && origMask[i+1] && !queued[i+1]) { queued[i+1]=1; bfsQ.push(i+1) }
    if (y > 0   && origMask[i-w] && !queued[i-w]) { queued[i-w]=1; bfsQ.push(i-w) }
    if (y < h-1 && origMask[i+w] && !queued[i+w]) { queued[i+w]=1; bfsQ.push(i+w) }
  }

  // Masque de travail : mis a jour au fil du remplissage
  const mask = new Uint8Array(origMask)

  for (const idx of bfsQ) {
    const cx = idx%w, cy = (idx/w)|0

    const x0 = Math.max(HALF, cx - RADIUS)
    const x1 = Math.min(w-1-HALF, cx + RADIUS)
    const y0 = Math.max(HALF, cy - RADIUS)
    const y1 = Math.min(h-1-HALF, cy + RADIUS)
    const rW = x1 - x0 + 1, rH = y1 - y0 + 1
    if (rW <= 0 || rH <= 0) continue

    // Top-5 patches par SSD normalise sur les pixels connus
    const top5 = new Array(5)
    let top5len = 0
    let worst5 = 1e18

    for (let c = 0; c < K; c++) {
      const sx = x0 + (Math.random() * rW) | 0
      const sy = y0 + (Math.random() * rH) | 0
      if (mask[sy*w+sx]) continue

      let ssd = 0, cnt = 0
      for (let dy = -HALF; dy <= HALF; dy++) {
        const ay = cy+dy; if (ay < 0 || ay >= h) continue
        const by = sy+dy; if (by < 0 || by >= h) continue
        const aRow = ay*w, bRow = by*w
        for (let dx = -HALF; dx <= HALF; dx++) {
          const ax = cx+dx; if (ax < 0 || ax >= w || mask[aRow+ax]) continue
          const bx = sx+dx; if (bx < 0 || bx >= w || mask[bRow+bx]) continue
          const ai = (aRow+ax)*4, bi = (bRow+bx)*4
          const dr = px[ai]-px[bi], dg = px[ai+1]-px[bi+1], db = px[ai+2]-px[bi+2]
          ssd += dr*dr + dg*dg + db*db; cnt++
        }
      }
      if (cnt < 4) continue
      const normSSD = ssd / cnt
      if (top5len < 5) {
        top5[top5len++] = { sx, sy, ssd: normSSD }
        if (top5len === 5) {
          top5.sort((a,b) => a.ssd - b.ssd)
          worst5 = top5[4].ssd
        }
      } else if (normSSD < worst5) {
        top5[4] = { sx, sy, ssd: normSSD }
        top5.sort((a,b) => a.ssd - b.ssd)
        worst5 = top5[4].ssd
      }
    }
    if (!top5len) continue

    // Parmi le top-5, choisit le candidat dont la couleur centrale est la plus
    // proche de la moyenne des voisins non-masques immediats (3px)
    let nr = 0, ng = 0, nb = 0, ncnt = 0
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const nx = cx+dx, ny = cy+dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || mask[ny*w+nx]) continue
        const n4 = (ny*w+nx)*4
        nr += px[n4]; ng += px[n4+1]; nb += px[n4+2]; ncnt++
      }
    }

    let best = top5[0]
    if (ncnt > 0 && top5len > 1) {
      nr /= ncnt; ng /= ncnt; nb /= ncnt
      let bestDiff = 1e18
      for (let j = 0; j < top5len; j++) {
        const c = top5[j], c4 = (c.sy*w+c.sx)*4
        const dr = px[c4]-nr, dg = px[c4+1]-ng, db = px[c4+2]-nb
        const diff = dr*dr + dg*dg + db*db
        if (diff < bestDiff) { bestDiff = diff; best = c }
      }
    }

    const si4 = (best.sy*w+best.sx)*4, i4 = idx*4
    px[i4] = px[si4]; px[i4+1] = px[si4+1]; px[i4+2] = px[si4+2]; px[i4+3] = 255
    mask[idx] = 0
  }
}

// ── Poisson blending : propagation concentrique du gradient de luminosite ──────
// Resout l'equation de Laplace sur la luminosite (Gauss-Seidel en ordre BFS).
// La luminosite harmonique interpole lissement depuis le bord du masque vers le centre.
// On applique uniquement le delta de luminosite pour preserver la texture PatchMatch.
function poissonBlend(px, origMask, w, h) {
  const N = w * h

  // Distance BFS depuis les pixels originaux (non-masques)
  const dist = new Uint16Array(N).fill(65535)
  const bfsQ = []
  for (let i = 0; i < N; i++) if (!origMask[i]) { dist[i] = 0; bfsQ.push(i) }
  for (let qi = 0; qi < bfsQ.length; qi++) {
    const i = bfsQ[qi], x = i%w, y = (i/w)|0, d = dist[i]+1
    if (x > 0   && dist[i-1] > d) { dist[i-1] = d; bfsQ.push(i-1) }
    if (x < w-1 && dist[i+1] > d) { dist[i+1] = d; bfsQ.push(i+1) }
    if (y > 0   && dist[i-w] > d) { dist[i-w] = d; bfsQ.push(i-w) }
    if (y < h-1 && dist[i+w] > d) { dist[i+w] = d; bfsQ.push(i+w) }
  }

  // Pixels remplis dans l'ordre BFS (du bord vers le centre)
  const filled = []
  for (const i of bfsQ) { if (origMask[i]) filled.push(i) }

  // Luminosites initiales (bord = valeurs originales fixes, centre = valeurs inpaintees)
  const harmLum = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    harmLum[i] = 0.299*px[i*4] + 0.587*px[i*4+1] + 0.114*px[i*4+2]
  }

  // 30 iterations Gauss-Seidel en ordre BFS : converge rapidement car
  // chaque iteration propage l'information depuis le bord (deja mis a jour)
  for (let iter = 0; iter < 30; iter++) {
    for (const idx of filled) {
      const x = idx%w, y = (idx/w)|0
      let sum = 0, cnt = 0
      if (x > 0)   { sum += harmLum[idx-1]; cnt++ }
      if (x < w-1) { sum += harmLum[idx+1]; cnt++ }
      if (y > 0)   { sum += harmLum[idx-w]; cnt++ }
      if (y < h-1) { sum += harmLum[idx+w]; cnt++ }
      if (cnt) harmLum[idx] = sum / cnt
    }
  }

  // Applique uniquement la correction de luminosite (preserve la texture/couleur inpaintee)
  for (const idx of filled) {
    const lum_inp = 0.299*px[idx*4] + 0.587*px[idx*4+1] + 0.114*px[idx*4+2]
    const delta   = harmLum[idx] - lum_inp
    if (Math.abs(delta) < 0.5) continue
    const i4 = idx*4
    px[i4]   = Math.max(0, Math.min(255, Math.round(px[i4]   + delta)))
    px[i4+1] = Math.max(0, Math.min(255, Math.round(px[i4+1] + delta)))
    px[i4+2] = Math.max(0, Math.min(255, Math.round(px[i4+2] + delta)))
  }
}

// ── Feathering 10px avec blend lineaire ─────────────────────────────────────
function featherBlend(px, origMask, w, h, R) {
  const dist = new Uint16Array(w*h).fill(65535)
  const q = []
  for (let i = 0; i < w*h; i++) if (!origMask[i]) { dist[i] = 0; q.push(i) }
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi], x = i%w, y = (i/w)|0, d = dist[i]+1
    if (d > R) continue
    if (x > 0   && dist[i-1] > d) { dist[i-1] = d; q.push(i-1) }
    if (x < w-1 && dist[i+1] > d) { dist[i+1] = d; q.push(i+1) }
    if (y > 0   && dist[i-w] > d) { dist[i-w] = d; q.push(i-w) }
    if (y < h-1 && dist[i+w] > d) { dist[i+w] = d; q.push(i+w) }
  }
  const snap = Buffer.from(px)
  for (let i = 0; i < w*h; i++) {
    if (!origMask[i]) continue
    const d = dist[i]; if (d >= R) continue
    const alpha = d / R   // lineaire : 0 au bord → 1 au centre
    const x = i%w, y = (i/w)|0
    let sr = 0, sg = 0, sb = 0, wt = 0
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const nx = x+dx, ny = y+dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const ni = ny*w+nx; if (origMask[ni]) continue
        const d2 = dx*dx + dy*dy || 1, n4 = ni*4
        sr += snap[n4]/d2; sg += snap[n4+1]/d2; sb += snap[n4+2]/d2; wt += 1/d2
      }
    }
    if (!wt) continue
    const i4 = i*4
    px[i4]   = Math.round(px[i4]   * alpha + (sr/wt) * (1-alpha))
    px[i4+1] = Math.round(px[i4+1] * alpha + (sg/wt) * (1-alpha))
    px[i4+2] = Math.round(px[i4+2] * alpha + (sb/wt) * (1-alpha))
  }
}

function colorCoherence(px, origMask, w, h, R) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y*w+x; if (!origMask[i]) continue
      let r = 0, g = 0, b = 0, wt = 0
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const nx = x+dx, ny = y+dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const ni = ny*w+nx; if (origMask[ni]) continue
          r += px[ni*4]; g += px[ni*4+1]; b += px[ni*4+2]; wt++
        }
      }
      if (!wt) continue
      const i4 = i*4
      px[i4]   = Math.round(px[i4]   * 0.7 + (r/wt) * 0.3)
      px[i4+1] = Math.round(px[i4+1] * 0.7 + (g/wt) * 0.3)
      px[i4+2] = Math.round(px[i4+2] * 0.7 + (b/wt) * 0.3)
    }
  }
}

function matchLuminance(px, origMask, w, h) {
  let sl = 0, fl = 0, scnt = 0, fcnt = 0
  for (let i = 0; i < w*h; i++) {
    const l = 0.299*px[i*4] + 0.587*px[i*4+1] + 0.114*px[i*4+2]
    if (origMask[i]) { fl += l; fcnt++ } else { sl += l; scnt++ }
  }
  if (!fcnt || !scnt) return
  const delta = (sl/scnt) - (fl/fcnt)
  if (Math.abs(delta) < 2) return
  for (let i = 0; i < w*h; i++) {
    if (!origMask[i]) continue
    const i4 = i*4
    px[i4]   = Math.max(0, Math.min(255, px[i4]   + delta))
    px[i4+1] = Math.max(0, Math.min(255, px[i4+1] + delta))
    px[i4+2] = Math.max(0, Math.min(255, px[i4+2] + delta))
  }
}

app.post("/retouch/inpaint", uploadLimiter, async (req, res) => {
  try {
    const { image, mask } = req.body
    if (!image || !mask) return res.status(400).json({ error: "image ou masque manquant" })

    const imgBuf = Buffer.from(image.replace(/^data:image\/\w+;base64,/, ""), "base64")
    const mskBuf = Buffer.from(mask.replace(/^data:image\/\w+;base64,/, ""), "base64")

    const img = await Jimp.read(imgBuf)
    const msk = await Jimp.read(mskBuf)

    // Resolution originale — aucun resize
    const W = img.getWidth(), H = img.getHeight()
    if (msk.getWidth() !== W || msk.getHeight() !== H) {
      msk.resize(W, H, Jimp.RESIZE_NEAREST_NEIGHBOR)
    }

    const px = img.bitmap.data
    const md = msk.bitmap.data

    const maskArr  = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) maskArr[i] = md[i*4] > 128 ? 1 : 0
    const origMask = new Uint8Array(maskArr)

    const struct = detectStructure(px, origMask, W, H)

    if (struct === 'flat') {
      flatFillMedian(px, origMask, W, H)
    } else {
      // Init multi-echelle 1/4 resolution (max 150px) pour la structure globale
      const QW = Math.max(4, Math.min(150, Math.round(W/4)))
      const QH = Math.max(4, Math.min(150, Math.round(H/4)))
      const qPx  = new Uint8ClampedArray(QW * QH * 4)
      const qMsk = new Uint8Array(QW * QH)
      for (let dy = 0; dy < QH; dy++) {
        for (let dx = 0; dx < QW; dx++) {
          const qsx = Math.min(Math.round(dx * W/QW), W-1)
          const qsy = Math.min(Math.round(dy * H/QH), H-1)
          const si = (qsy*W+qsx)*4, di = (dy*QW+dx)*4
          qPx[di] = px[si]; qPx[di+1] = px[si+1]; qPx[di+2] = px[si+2]; qPx[di+3] = 255
          qMsk[dy*QW+dx] = origMask[qsy*W+qsx]
        }
      }
      diffuse(qPx, qMsk, QW, QH, 15)
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y*W+x; if (!origMask[i]) continue
          const qsx = Math.min(Math.round(x * QW/W), QW-1)
          const qsy = Math.min(Math.round(y * QH/H), QH-1)
          const si = (qsy*QW+qsx)*4, i4 = i*4
          px[i4] = qPx[si]; px[i4+1] = qPx[si+1]; px[i4+2] = qPx[si+2]
        }
      }

      // PatchMatch 15×15 — 5 passes BFS depuis les bords, top-5 + selection couleur voisins
      patchMatchFill(px, origMask, W, H)
      patchMatchFill(px, origMask, W, H)
      patchMatchFill(px, origMask, W, H)
      patchMatchFill(px, origMask, W, H)
      patchMatchFill(px, origMask, W, H)
    }

    // Poisson blending : force la continuite couleur/luminosite au bord du masque
    poissonBlend(px, origMask, W, H)

    // Feathering lineaire 30px
    featherBlend(px, origMask, W, H, 30)

    // Coherence couleur et ajustement luminosite globale
    colorCoherence(px, origMask, W, H, 5)
    matchLuminance(px, origMask, W, H)

    // PNG lossless qualite maximale
    img.quality(100)
    const result = await img.getBufferAsync(Jimp.MIME_PNG)
    res.json({ result: "data:image/png;base64," + result.toString("base64") })
  } catch (e) {
    console.error('[inpaint]', e)
    res.status(500).json({ error: e.message })
  }
})



// ── Retrait filigrane ────────────────────────────────────────────────────────

app.post('/retouch/remove-watermark', uploadLimiter, uploadMem.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image manquante' })
  try {
    const imageBuffer = req.file.buffer
    const meta = await sharp(imageBuffer).metadata()
    const maxDim = 1500
    const scale = Math.min(1, maxDim / Math.max(meta.width, meta.height))
    const procW = Math.round(meta.width * scale), procH = Math.round(meta.height * scale)

    const { data: imgData } = await sharp(imageBuffer)
      .resize(procW, procH).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const { data: rgba } = await sharp(imageBuffer)
      .resize(procW, procH).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const { data: gray } = await sharp(imageBuffer)
      .resize(procW, procH).greyscale().raw().toBuffer({ resolveWithObject: true })
    // Micro-blur (σ=3) as local background estimate: |pixel − blur| ≈ local texture
    const { data: microBlur } = await sharp(imageBuffer)
      .resize(procW, procH).greyscale().blur(3).raw().toBuffer({ resolveWithObject: true })

    const masked = new Uint8Array(procW * procH)
    for (let i = 0; i < procW * procH; i++) {
      // 1. Semi-transparent pixel → filigrane PNG/transparent
      if (rgba[i * 4 + 3] < 220) { masked[i] = 1; continue }

      const v = gray[i]
      // localFlat = pixel is smooth (no local texture = uniform region)
      const localFlat = Math.abs(v - microBlur[i]) < 12

      // 2. Uniform bright overlay (texte/logo blanc ou clair)
      if (v > 210 && localFlat) { masked[i] = 1; continue }

      // 3. Uniform dark overlay (texte/logo noir)
      if (v < 35 && localFlat) { masked[i] = 1; continue }
    }

    // Dilate 3px to bridge watermark outline gaps
    const dilated = dilateMask(masked, procW, procH, 3)

    const result = applyDiffusion(imgData, dilated, procW, procH, 6)
    const out = await sharp(result, { raw: { width: procW, height: procH, channels: 3 } })
      .jpeg({ quality: 92 }).toBuffer()
    res.json({ result: 'data:image/jpeg;base64,' + out.toString('base64') })
  } catch (err) {
    console.error('[remove-watermark]', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Retrait texte ────────────────────────────────────────────────────────────

app.post('/retouch/remove-text', uploadLimiter, uploadMem.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image manquante' })
  try {
    const imageBuffer = req.file.buffer
    const meta = await sharp(imageBuffer).metadata()
    const maxDim = 1500
    const scale = Math.min(1, maxDim / Math.max(meta.width, meta.height))
    const procW = Math.round(meta.width * scale), procH = Math.round(meta.height * scale)

    const { data: imgData } = await sharp(imageBuffer)
      .resize(procW, procH).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const { data: gray } = await sharp(imageBuffer)
      .resize(procW, procH).greyscale().raw().toBuffer({ resolveWithObject: true })
    // σ=2 blur for edge enhancement: |pixel − blur| = local edge strength
    const { data: microBlur } = await sharp(imageBuffer)
      .resize(procW, procH).greyscale().blur(2).raw().toBuffer({ resolveWithObject: true })

    // Detect text pixels: Sobel gradient + brightness threshold + blur-difference
    const edgeMap = new Uint8Array(procW * procH)
    for (let y = 1; y < procH - 1; y++) {
      for (let x = 1; x < procW - 1; x++) {
        const i = y * procW + x
        const v = gray[i]
        // Sobel X
        const gx = -gray[(y-1)*procW+(x-1)] - 2*gray[y*procW+(x-1)] - gray[(y+1)*procW+(x-1)]
                   +gray[(y-1)*procW+(x+1)] + 2*gray[y*procW+(x+1)] + gray[(y+1)*procW+(x+1)]
        // Sobel Y
        const gy = -gray[(y-1)*procW+(x-1)] - 2*gray[(y-1)*procW+x] - gray[(y-1)*procW+(x+1)]
                   +gray[(y+1)*procW+(x-1)] + 2*gray[(y+1)*procW+x] + gray[(y+1)*procW+(x+1)]
        const grad = Math.sqrt(gx * gx + gy * gy)
        const edgeStrength = Math.abs(v - microBlur[i])
        // Strong edge + dark or bright value = text outline
        if ((grad > 60 || edgeStrength > 20) && (v < 80 || v > 175)) edgeMap[i] = 1
      }
    }

    // Include very dark fill pixels (interior of dark text strokes)
    for (let i = 0; i < procW * procH; i++) {
      if (gray[i] < 40) edgeMap[i] = 1
    }

    // Dilate 4px to cover full stroke width + anti-aliasing
    let finalMask = dilateMask(edgeMap, procW, procH, 4)

    // Safety: if > 40% masked, tighten thresholds to avoid destroying the image
    const maskedCount = finalMask.reduce((s, v) => s + v, 0)
    if (maskedCount > procW * procH * 0.4) {
      const strict = new Uint8Array(procW * procH)
      for (let y = 1; y < procH - 1; y++) {
        for (let x = 1; x < procW - 1; x++) {
          const i = y * procW + x
          const v = gray[i]
          const gx = -gray[(y-1)*procW+(x-1)] - 2*gray[y*procW+(x-1)] - gray[(y+1)*procW+(x-1)]
                     +gray[(y-1)*procW+(x+1)] + 2*gray[y*procW+(x+1)] + gray[(y+1)*procW+(x+1)]
          const gy = -gray[(y-1)*procW+(x-1)] - 2*gray[(y-1)*procW+x] - gray[(y-1)*procW+(x+1)]
                     +gray[(y+1)*procW+(x-1)] + 2*gray[(y+1)*procW+x] + gray[(y+1)*procW+(x+1)]
          if (Math.sqrt(gx*gx + gy*gy) > 100 && (v < 50 || v > 200)) strict[i] = 1
        }
      }
      finalMask = dilateMask(strict, procW, procH, 3)
    }

    const result = applyDiffusion(imgData, finalMask, procW, procH, 6)
    const out = await sharp(result, { raw: { width: procW, height: procH, channels: 3 } })
      .jpeg({ quality: 92 }).toBuffer()
    res.json({ result: 'data:image/jpeg;base64,' + out.toString('base64') })
  } catch (err) {
    console.error('[remove-text]', err)
    res.status(500).json({ error: err.message })
  }
})

// ─── DASHBOARD IMAGE GENERATION ─────────────────────────────────────────────

// Seeded LCG — same gross always produces the same chart shape
function seededRng(seed) {
  let s = (Math.abs(Math.round(seed)) || 1) & 0x7fffffff
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 }
}

// Daily values that SUM to total (OF template: chart shows daily amounts)
function dashDaily(total, n, seed) {
  const rng = seededRng(seed !== undefined ? seed : total)
  const pts = []
  for (let i = 0; i < n; i++) {
    const wkBoost = (i % 7) >= 5 ? 1.35 : 1.0
    const trend   = 0.85 + 0.15 * (i / Math.max(n - 1, 1))
    const base    = (0.4 + rng() * 1.0) * wkBoost * trend
    pts.push(Math.max(0.01, base * (1 + (rng() - 0.5) * 0.12)))
  }
  const sum = pts.reduce((a, b) => a + b, 0)
  return pts.map(v => (v / sum) * total)
}

// Organic daily values: stable baseline, max ±8% step, 2-3 natural peaks
function dashOrganic(total, n, seed) {
  if (n <= 0) return []
  if (n === 1) return [total]
  const rng  = seededRng(seed !== undefined ? seed : Math.round(total))
  const base = total / n

  // Evenly-spaced peaks with jitter (fewer peaks for short periods)
  const numPeaks = n < 10 ? 1 : 2 + Math.floor(rng() * 2)
  const spacing  = Math.floor(n / (numPeaks + 1))
  const peaks = new Set(Array.from({ length: numPeaks }, (_, k) => {
    const center = spacing * (k + 1)
    const jitter = Math.floor((rng() - 0.5) * Math.max(1, spacing * 0.5))
    return Math.max(1, Math.min(n - 2, center + jitter))
  }))
  const nearPeaks = new Set([...peaks].flatMap(p => [p - 1, p, p + 1]))

  // Random walk: max ±8% change per step, peak +10-20% above base
  let prev = base * (0.94 + rng() * 0.12)
  const raw = []
  for (let i = 0; i < n; i++) {
    const trendMult = 1.0 + 0.05 * (i / (n - 1))
    const peakMult  = peaks.has(i)     ? (1.10 + rng() * 0.10)
                    : nearPeaks.has(i) ? (1.03 + rng() * 0.04) : 1.0
    const jitter    = 0.96 + rng() * 0.08
    const target    = base * trendMult * peakMult * jitter
    const maxDelta  = prev * 0.08
    const clamped   = Math.max(prev - maxDelta, Math.min(prev + maxDelta, target))
    prev = Math.max(base * 0.75, Math.min(base * 1.40, clamped))
    raw.push(prev)
  }
  const sum = raw.reduce((a, b) => a + b, 0)
  return raw.map(v => (v / sum) * total)
}

// Round up to a clean Y-axis ceiling value
function roundToNice(val) {
  if (val <= 0) return 100
  const mag  = Math.pow(10, Math.floor(Math.log10(val)))
  const n    = val / mag
  const nice = n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 3 ? 3 :
               n <= 4   ? 4   : n <= 5 ? 5 : n <= 6   ? 6   : n <= 7.5 ? 7.5 :
               n <= 9   ? 9   : 10
  return nice * mag
}

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Straight polyline path from [{x,y}] points (M...L...L...)
function svgLine(pts) {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
}

// Quadratic bezier midpoint path from [{x,y}] points
function svgSmooth(pts) {
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const mx = ((pts[i].x + pts[i + 1].x) / 2).toFixed(1)
    const my = ((pts[i].y + pts[i + 1].y) / 2).toFixed(1)
    d += ` Q ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)} ${mx} ${my}`
  }
  return d + ` L ${pts[pts.length - 1].x.toFixed(1)} ${pts[pts.length - 1].y.toFixed(1)}`
}

// ─── OF TEMPLATE: pixel-perfect reproduction of OF.png ───────────────────────
// Layout (768px wide, sections top→bottom):
//  Nav tabs · Sub-tabs · Banner · Balance · Manual payouts · Period ·
//  Filter tabs · Earnings headline · Main chart · Secondary chart ·
//  Date labels · Bottom nav · Browser bar
function buildOFSvg(d) {
  const { curBal, pendBal, periodLabel, dateRange,
          netAmt, grossAmt, growthPct,
          cData, cData2, bars, dateLabels } = d

  const W    = 768
  const PAD  = 20
  const BLUE = '#00aff0'
  const BLK  = '#1a1a1a'
  const DARK = '#333333'
  const GRAY = '#666666'
  const LGR  = '#9e9e9e'
  const BDR  = '#e5e5e5'
  const WHT  = '#ffffff'
  const GRN  = '#44b37e'
  const GNBG = '#e8f7ef'

  const R = (x, y, w, h, fill, rx = 0, stroke = 'none', sw = 0) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" rx="${rx}"` +
    (stroke !== 'none' ? ` stroke="${stroke}" stroke-width="${sw}"` : '') + '/>'
  const T = (x, ty, s, { fs = 14, fill = BLK, fw = 'normal', anchor = 'start', ls = '0' } = {}) =>
    `<text x="${x}" y="${ty}" font-family="Liberation Sans,Arial,sans-serif" font-size="${fs}" fill="${fill}" font-weight="${fw}" text-anchor="${anchor}" letter-spacing="${ls}">${escXml(String(s))}</text>`
  const L = (x1, y1, x2, y2, stroke, sw = 1) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}"/>`
  const chev = (cx, cy) =>
    `<polyline points="${cx-8},${cy-5} ${cx},${cy+5} ${cx+8},${cy-5}" fill="none" stroke="${LGR}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`

  let b = '', y = 0

  // 1 ── NAV TABS: STATEMENTS(active) OVERVIEW ENGAGEMENT REACH ─────────────
  b += R(0, 0, W, 52, WHT)
  const tabs = ['STATEMENTS', 'OVERVIEW', 'ENGAGEMENT', 'REACH']
  const tabW = [148, 134, 182, 304]
  let tx = 0
  tabs.forEach((t, i) => {
    const cx = tx + tabW[i] / 2
    b += T(cx, 32, t, { fs: 11.5, fill: i === 0 ? BLK : LGR, fw: i === 0 ? '600' : '400', anchor: 'middle', ls: '0.5' })
    if (i === 0) b += L(tx + 16, 50, tx + tabW[i] - 16, 50, BLUE, 2.5)
    tx += tabW[i]
  })
  b += L(0, 51.5, W, 51.5, BDR, 1)
  y = 52

  // 2 ── SUB-TABS: Earnings(active) Payout Requests Chargebacks Referrals ───
  b += R(0, y, W, 66, WHT)
  const stabs = ['Earnings', 'Payout Requests', 'Chargebacks', 'Referrals']
  const stabW = [110, 168, 148, 126]
  let sx = PAD
  stabs.forEach((t, i) => {
    const tw = stabW[i]
    if (i === 0) {
      b += R(sx, y + 15, tw, 36, BLUE, 18)
      b += T(sx + tw / 2, y + 38, t, { fs: 14, fill: WHT, fw: '500', anchor: 'middle' })
    } else {
      b += R(sx, y + 15, tw, 36, WHT, 18, BDR, 1.5)
      b += T(sx + tw / 2, y + 38, t, { fs: 14, fill: GRAY, anchor: 'middle' })
    }
    sx += tw + 10
  })
  b += L(0, y + 65.5, W, y + 65.5, BDR, 1)
  y += 66

  // 3 ── BANNER: ★ YOU ARE IN THE TOP 0.01% OF ALL CREATORS! ───────────────
  b += R(0, y, W, 50, WHT)
  b += T(PAD, y + 31, '★', { fs: 18, fill: BLUE, fw: '700' })
  b += T(PAD + 30, y + 31, 'YOU ARE IN THE TOP 0.01% OF ALL CREATORS!', { fs: 13, fill: BLK, fw: '700', ls: '0.2' })
  b += L(0, y + 49.5, W, y + 49.5, BDR, 1)
  y += 50

  // 4 ── BALANCE ROW: $curBal (Current balance) | $pendBal (Pending balance ⓘ)
  const BAL_H = 112
  b += R(0, y, W, BAL_H, WHT)
  const midX = 384
  b += T(PAD, y + 55, curBal, { fs: 40, fill: BLK, fw: '700' })
  b += T(PAD, y + 78, 'Current balance', { fs: 14, fill: LGR })
  b += L(midX, y + 14, midX, y + 98, BDR, 1)
  b += T(midX + PAD, y + 51, pendBal, { fs: 36, fill: LGR, fw: '700' })
  b += T(midX + PAD, y + 75, 'Pending balance', { fs: 14, fill: LGR })
  b += `<circle cx="${midX + PAD + 138}" cy="${y + 69}" r="9" fill="none" stroke="${LGR}" stroke-width="1.5"/>`
  b += T(midX + PAD + 138, y + 73, 'i', { fs: 11, fill: LGR, fw: '600', anchor: 'middle' })
  b += L(0, y + BAL_H - 0.5, W, y + BAL_H - 0.5, BDR, 1)
  y += BAL_H

  // 5 ── MANUAL PAYOUTS + REQUEST WITHDRAWAL button ─────────────────────────
  const PAY_H = 130
  b += R(0, y, W, PAY_H, WHT)
  b += T(PAD, y + 30, 'Manual payouts', { fs: 17, fill: BLK, fw: '600' })
  b += chev(W - PAD - 8, y + 25)
  b += T(PAD, y + 52, 'Minimum withdrawal amount is $20', { fs: 13, fill: LGR })
  const btnX = 400, btnW = W - btnX - PAD
  b += R(btnX, y + 66, btnW, 50, BLUE, 25)
  b += T(btnX + btnW / 2, y + 96, 'REQUEST WITHDRAWAL', { fs: 13, fill: WHT, fw: '700', anchor: 'middle', ls: '0.5' })
  b += L(0, y + PAY_H - 0.5, W, y + PAY_H - 0.5, BDR, 1)
  y += PAY_H

  // 6 ── PERIOD: "Last 30 days" + date range ────────────────────────────────
  const PER_H = 82
  b += R(0, y, W, PER_H, WHT)
  b += T(PAD, y + 34, periodLabel, { fs: 20, fill: BLK, fw: '700' })
  b += chev(W - PAD - 8, y + 28)
  b += T(PAD, y + 60, dateRange, { fs: 13, fill: LGR })
  b += L(0, y + PER_H - 0.5, W, y + PER_H - 0.5, BDR, 1)
  y += PER_H

  // 7 ── FILTER TABS: All(active) Subscriptions Tips Posts Messages ──────────
  b += R(0, y, W, 66, WHT)
  const ftabs = ['All', 'Subscriptions', 'Tips', 'Posts', 'Messages']
  const ftabW = [64, 158, 82, 88, 126]
  let fx = PAD
  ftabs.forEach((t, i) => {
    const tw = ftabW[i]
    if (i === 0) {
      b += R(fx, y + 15, tw, 36, BLUE, 18)
      b += T(fx + tw / 2, y + 38, t, { fs: 14, fill: WHT, fw: '500', anchor: 'middle' })
    } else {
      b += R(fx, y + 15, tw, 36, WHT, 18, BDR, 1.5)
      b += T(fx + tw / 2, y + 38, t, { fs: 14, fill: GRAY, anchor: 'middle' })
    }
    fx += tw + 10
  })
  y += 66

  // 8 ── EARNINGS: $net  ($gross Gross)  ↗ 26% ─────────────────────────────
  b += R(0, y, W, 56, WHT)
  b += T(PAD, y + 38, netAmt, { fs: 30, fill: BLK, fw: '700' })
  const netTW = netAmt.length * 17.5
  b += T(PAD + netTW + 8, y + 38, '(' + grossAmt + ' Gross)', { fs: 20, fill: BLUE })
  const grossTW  = (grossAmt.length + 9) * 11.5
  const badgeX   = PAD + netTW + 8 + grossTW + 10
  const badgeTxt = '↗ ' + growthPct + '%'
  const badgeW   = badgeTxt.length * 9 + 14
  b += R(badgeX, y + 18, badgeW, 26, GNBG, 5)
  b += T(badgeX + 7, y + 35, badgeTxt, { fs: 14, fill: GRN, fw: '600' })
  y += 56

  // 9 ── MAIN CHART: blue area, Y-labels right ($9,000 / $6,000 / $3,000) ───
  const CH = 280, CPL = 8, CPR = 68, CPT = 16
  const CPW = W - CPL - CPR, CPH = CH - CPT
  const cy = y
  b += R(0, cy, W, CH, '#f0faff')

  const maxD  = Math.max(...cData)
  const yTop  = roundToNice(maxD * 1.05)
  const yLvls = [
    { v: yTop,                   gy: cy + CPT },
    { v: Math.round(yTop * 2/3), gy: cy + CPT + CPH * (1/3) },
    { v: Math.round(yTop * 1/3), gy: cy + CPT + CPH * (2/3) },
  ]
  for (let i = 1; i <= 4; i++) b += L(CPL + CPW * i / 5, cy + CPT, CPL + CPW * i / 5, cy + CPT + CPH, BDR, 0.8)
  yLvls.forEach(lv => b += L(CPL, lv.gy, W - CPR, lv.gy, BDR, 0.8))

  const cPts = cData.map((v, i) => ({
    x: CPL + (bars > 1 ? i / (bars - 1) : 0) * CPW,
    y: cy + CPT + (1 - v / yTop) * CPH,
  }))
  const cLine = svgSmooth(cPts)
  const cFill = cLine +
    ` L ${cPts[cPts.length-1].x.toFixed(1)} ${(cy+CPT+CPH).toFixed(1)}` +
    ` L ${CPL} ${(cy+CPT+CPH).toFixed(1)} Z`
  b += `<defs><linearGradient id="ofG" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="${BLUE}" stop-opacity="0.28"/>` +
    `<stop offset="100%" stop-color="${BLUE}" stop-opacity="0.04"/>` +
    `</linearGradient></defs>`
  b += `<path d="${cFill}" fill="url(#ofG)"/>`
  b += `<path d="${cLine}" fill="none" stroke="${BLUE}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`
  yLvls.forEach(lv => b += T(W - CPR + 10, lv.gy + 4, '$' + Math.round(lv.v).toLocaleString('en-US'), { fs: 13, fill: LGR }))
  y = cy + CH

  // 10 ── SECONDARY CHART: gray area, Y-labels 200 / 100 ───────────────────
  const C2H = 98, C2PL = 8, C2PR = 68, C2PT = 10, C2PB = 8
  const C2PW = W - C2PL - C2PR, C2PH = C2H - C2PT - C2PB
  const c2y = y
  b += R(0, c2y, W, C2H, WHT)
  b += L(0, c2y, W, c2y, BDR, 0.8)
  const maxV2 = Math.max(...cData2)
  const y2Top = roundToNice(maxV2 * 1.15)
  const c2Pts = cData2.map((v, i) => ({
    x: C2PL + (bars > 1 ? i / (bars - 1) : 0) * C2PW,
    y: c2y + C2PT + (1 - v / y2Top) * C2PH,
  }))
  const c2Line = svgSmooth(c2Pts)
  const c2Fill = c2Line +
    ` L ${c2Pts[c2Pts.length-1].x.toFixed(1)} ${(c2y+C2PT+C2PH).toFixed(1)}` +
    ` L ${C2PL} ${(c2y+C2PT+C2PH).toFixed(1)} Z`
  b += `<path d="${c2Fill}" fill="rgba(0,0,0,0.05)"/>`
  b += `<path d="${c2Line}" fill="none" stroke="#aaaaaa" stroke-width="2" stroke-linecap="round"/>`
  b += T(W - C2PR + 10, c2y + C2PT + 4, String(Math.round(y2Top)), { fs: 13, fill: LGR })
  b += T(W - C2PR + 10, c2y + C2PT + C2PH * 0.5 + 4, String(Math.round(y2Top / 2)), { fs: 13, fill: LGR })
  y = c2y + C2H

  // 11 ── DATE LABELS: "May 4,\n2026" × 5 ──────────────────────────────────
  b += R(0, y, W, 64, WHT)
  dateLabels.forEach((lbl, i) => {
    const lx     = CPL + (dateLabels.length > 1 ? i / (dateLabels.length - 1) : 0) * CPW
    const anchor = i === 0 ? 'start' : i === dateLabels.length - 1 ? 'end' : 'middle'
    const parts  = lbl.split('\n')
    b += T(lx, y + 20, parts[0] || lbl, { fs: 13, fill: LGR, anchor })
    if (parts[1]) b += T(lx, y + 38, parts[1], { fs: 13, fill: LGR, anchor })
  })
  y += 64

  // 12 ── BOTTOM NAV BAR: Home Bell Plus-circle Chat Avatar ─────────────────
  b += R(0, y, W, 76, WHT)
  b += L(0, y, W, y, BDR, 1)
  const icy = y + 38
  const ix  = [77, 230, 384, 538, 691]
  // Home (house outline)
  b += `<path d="M${ix[0]-14},${icy-2} L${ix[0]},${icy-17} L${ix[0]+14},${icy-2}" fill="none" stroke="${LGR}" stroke-width="2" stroke-linejoin="round"/>`
  b += `<rect x="${ix[0]-10}" y="${icy-2}" width="20" height="16" fill="none" stroke="${LGR}" stroke-width="2" stroke-linejoin="round"/>`
  // Bell
  b += `<path d="M${ix[1]},${icy-18} C${ix[1]-14},${icy-18} ${ix[1]-14},${icy-4} ${ix[1]-14},${icy} L${ix[1]+14},${icy} C${ix[1]+14},${icy-4} ${ix[1]+14},${icy-18} ${ix[1]},${icy-18}" fill="none" stroke="${LGR}" stroke-width="2"/>`
  b += `<circle cx="${ix[1]}" cy="${icy+5}" r="4.5" fill="none" stroke="${LGR}" stroke-width="2"/>`
  // Plus-circle
  b += `<circle cx="${ix[2]}" cy="${icy-2}" r="19" fill="none" stroke="${LGR}" stroke-width="2"/>`
  b += L(ix[2]-9, icy-2, ix[2]+9, icy-2, LGR, 2.2)
  b += L(ix[2], icy-11, ix[2], icy+7, LGR, 2.2)
  // Chat bubble
  b += `<path d="M${ix[3]-16},${icy-16} L${ix[3]+16},${icy-16} L${ix[3]+16},${icy} L${ix[3]+6},${icy} L${ix[3]},${icy+9} L${ix[3]-6},${icy} L${ix[3]-16},${icy} Z" fill="none" stroke="${LGR}" stroke-width="2" stroke-linejoin="round"/>`
  // Avatar
  b += `<circle cx="${ix[4]}" cy="${icy-10}" r="9" fill="none" stroke="${LGR}" stroke-width="2"/>`
  b += `<path d="M${ix[4]-17},${icy+14} C${ix[4]-17},${icy+2} ${ix[4]+17},${icy+2} ${ix[4]+17},${icy+14}" fill="none" stroke="${LGR}" stroke-width="2"/>`
  y += 76

  // 13 ── BROWSER BAR: AA  🔒 onlyfans.com  ↺ ───────────────────────────────
  b += R(0, y, W, 56, '#f2f2f2')
  b += T(PAD, y + 36, 'AA', { fs: 17, fill: LGR })
  const lkX = W / 2 - 72
  b += `<rect x="${lkX}" y="${y+18}" width="12" height="10" fill="none" stroke="${DARK}" stroke-width="1.5" rx="1.5"/>`
  b += `<path d="M${lkX+2},${y+19} C${lkX+2},${y+13} ${lkX+10},${y+13} ${lkX+10},${y+19}" fill="none" stroke="${DARK}" stroke-width="1.5"/>`
  b += T(lkX + 18, y + 36, 'onlyfans.com', { fs: 15, fill: DARK, fw: '500' })
  b += T(W - PAD, y + 36, '↺', { fs: 22, fill: LGR, anchor: 'end' })
  y += 56

  return `<svg width="${W}" height="${y}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${W}" height="${y}" fill="${WHT}"/>` +
    b + `</svg>`
}

// ─── FANFIX: Content Protection dashboard (2000×1221) ───────────────────────
function buildFanfixSvg(d) {
  const { revenueAmt, periodLabel, dateLabels } = d
  const W = 1000, H = 610.5, SCALE = 2

  const PINK = '#ec4899', PINK_BG = '#f9a8d4', LPUR = '#a78bfa', DPUR = '#7c3aed'
  const BLK = '#0a0a0a', GRAY = '#8a8a8a'

  const R = (x, y, w, h, fill, rx = 0, stroke = 'none', sw = 0) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" rx="${rx}"` +
    (stroke !== 'none' ? ` stroke="${stroke}" stroke-width="${sw}"` : '') + '/>'
  const T = (x, y, s, { fs = 11, fill = BLK, fw = 'normal', anchor = 'start', ls = '0', deco = 'none' } = {}) =>
    `<text x="${x}" y="${y}" font-family="Liberation Sans,Arial,sans-serif" font-size="${fs}" fill="${fill}" font-weight="${fw}" text-anchor="${anchor}" letter-spacing="${ls}" text-decoration="${deco}">${escXml(String(s))}</text>`
  const L = (x1, y1, x2, y2, stroke, sw = 1) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}"/>`
  const Crc = (cx, cy, r, fill) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`

  let b = ''
  b += `<defs>
    <linearGradient id="ffBg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#dce9fb"/><stop offset="50%" stop-color="#ece3f6"/><stop offset="100%" stop-color="#fbe1ee"/>
    </linearGradient>
    <radialGradient id="ffAvatar" cx="35%" cy="35%" r="75%">
      <stop offset="0%" stop-color="#f9a8d4"/><stop offset="50%" stop-color="#a78bfa"/><stop offset="100%" stop-color="#7c3aed"/>
    </radialGradient>
  </defs>`
  b += R(0, 0, W, H, 'url(#ffBg)')

  // ── SIDEBAR ──
  const SBW = 108
  b += R(0, 0, SBW, H, '#ffffff')
  b += Crc(20, 20, 9, 'url(#ffAvatar)')
  b += `<path d="M16,20 L19,23 L25,16" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
  b += T(34, 24, 'FANFIX', { fs: 12.5, fw: '800', ls: '0.3' })

  b += Crc(28, 68, 18, 'url(#ffAvatar)')
  b += T(56, 64, 'Hi, john', { fs: 11.5, fw: '700' })
  b += T(56, 79, 'Share profile', { fs: 9.5, fill: '#9b8afb', deco: 'underline' })
  b += T(101, 79, '↗', { fs: 9.5, fill: '#9b8afb' })

  b += R(14, 98, 80, 26, '#0a0a0a', 13)
  b += T(54, 115, '+ Create', { fs: 11, fill: '#fff', fw: '600', anchor: 'middle' })

  const menu = [
    { t: 'Insights' }, { t: 'Analytics', chev: true }, { t: 'Messages', badge: '3', badgeC: '#3b82f6' },
    { t: 'Memberships', chev: true }, { t: 'Notifications', badge: '7', badgeC: '#7c3aed' },
    { t: 'Vault' }, { t: 'Scheduler' }, { t: 'Community', chev: true },
  ]
  let my = 145
  menu.forEach(m => {
    b += `<circle cx="22" cy="${my - 4}" r="6" fill="none" stroke="#999" stroke-width="1.3"/>`
    b += T(36, my, m.t, { fs: 10.8, fill: '#333' })
    if (m.chev) b += T(96, my, '›', { fs: 11, fill: '#bbb', anchor: 'middle' })
    if (m.badge) { b += Crc(94, my - 4, 7, m.badgeC); b += T(94, my - 1, m.badge, { fs: 8.5, fill: '#fff', fw: '700', anchor: 'middle' }) }
    my += 25
  })
  my += 14
  ;['Settings', 'Contact Us', 'Sign Out'].forEach((t, i) => {
    b += T(36, my, t, { fs: 10.5, fill: '#666' })
    if (i === 0) b += T(96, my, '›', { fs: 11, fill: '#bbb', anchor: 'middle' })
    my += 24
  })
  b += L(14, H - 40, SBW - 14, H - 40, '#eee', 1)
  b += T(36, H - 18, 'Hide menu', { fs: 10, fill: '#999' })

  // ── MAIN CONTENT ──
  const MX = 132
  b += T(MX, 46, 'Content Protection', { fs: 23, fw: '800' })
  b += T(MX, 64, "World's most powerful AI powered detection and removal!", { fs: 11.5, fill: GRAY })

  const tabs = ['Dashboard', 'Reported Links', 'Whitelist', 'AI Scan Detection', 'Reddit Scan', 'Settings']
  let tx = MX
  tabs.forEach((t, i) => {
    b += T(tx, 96, t, { fs: 11.5, fill: i === 0 ? BLK : '#999', fw: i === 0 ? '700' : '400' })
    if (i === 0) b += L(tx, 104, tx + t.length * 6.6, 104, BLK, 1.6)
    tx += t.length * 6.6 + 26
  })
  b += R(860, 78, 108, 28, '#6d4aff', 14)
  b += T(914, 96, 'Report Links', { fs: 10.8, fill: '#fff', fw: '600', anchor: 'middle' })

  // ── Scan Detections card ──
  const SC_X = MX, SC_Y = 122, SC_W = 478, SC_H = 218
  b += R(SC_X, SC_Y, SC_W, SC_H, '#fdfbff', 12, '#f0e8fc', 1)
  b += T(SC_X + 18, SC_Y + 24, 'Scan Detections', { fs: 13.5, fw: '700' })
  b += T(SC_X + 18, SC_Y + 40, 'Results Detected Over Time', { fs: 10.5, fill: GRAY })
  b += R(SC_X + SC_W - 92, SC_Y + 14, 78, 20, '#ffffff', 10, '#e8dffb', 1)
  b += T(SC_X + SC_W - 53, SC_Y + 27, periodLabel, { fs: 9.5, fill: '#666', anchor: 'middle' })

  const chX = SC_X + 14, chW = SC_W - 28, chY = SC_Y + 56, chH = SC_H - 74
  const wave = (baseFrac, ampFrac, phase) => {
    const pts = []
    for (let i = 0; i <= 5; i++) {
      const t = i / 5
      const v = baseFrac + ampFrac * Math.sin(t * Math.PI * 1.6 + phase)
      pts.push({ x: chX + t * chW, y: chY + chH * (1 - v) })
    }
    return pts
  }
  const layer = (pts, fill) => {
    const dd = svgSmooth(pts) + ` L ${pts[pts.length - 1].x.toFixed(1)} ${(chY + chH).toFixed(1)} L ${pts[0].x.toFixed(1)} ${(chY + chH).toFixed(1)} Z`
    return `<path d="${dd}" fill="${fill}" opacity="0.85"/>`
  }
  b += layer(wave(0.62, 0.14, 0.6), PINK_BG)
  b += layer(wave(0.44, 0.16, 2.4), LPUR)
  b += layer(wave(0.26, 0.13, 4.1), DPUR)
  dateLabels.forEach((lbl, i) => {
    const lx = chX + (dateLabels.length > 1 ? i / (dateLabels.length - 1) : 0) * chW
    b += T(lx, SC_Y + SC_H - 10, lbl, { fs: 9.5, fill: '#aaa', anchor: i === 0 ? 'start' : i === dateLabels.length - 1 ? 'end' : 'middle' })
  })

  const stats = [{ n: '9', l: 'Google Results', c: PINK }, { n: '7', l: 'Reddit Detection', c: LPUR }, { n: '6', l: 'Google Images', c: DPUR }]
  let sy = SC_Y
  stats.forEach(s => {
    b += R(626, sy, 140, 66, s.c, 10)
    b += T(642, sy + 30, s.n, { fs: 18, fill: '#fff', fw: '800' })
    b += T(642, sy + 48, s.l, { fs: 10, fill: 'rgba(255,255,255,0.92)' })
    sy += 76
  })

  // ── ROW 2: 3 cards (equal width, aligned to row1 width) ──
  const R2Y = 360, R2H = 200, CW = 201, GAP = 16
  const AX = MX, BX = AX + CW + GAP, CX2 = BX + CW + GAP

  // Card A: Top 3 Infringers
  b += R(AX, R2Y, CW, R2H, '#ffffff', 12, '#f0eaf9', 1)
  b += T(AX + 16, R2Y + 24, 'Top 3 Infringers', { fs: 12, fw: '700' })
  b += T(AX + CW - 14, R2Y + 24, 'Last 30 days', { fs: 8.5, fill: '#aaa', anchor: 'end' })
  const dcx = AX + CW / 2, dcy = R2Y + 96, ro = 42, ri = 26
  let ang = -Math.PI / 2
  ;[{ frac: 0.5, c: PINK }, { frac: 0.15, c: LPUR }, { frac: 0.35, c: DPUR }].forEach(a => {
    const a0 = ang, a1 = ang + a.frac * 2 * Math.PI
    const x0o = dcx + ro * Math.cos(a0), y0o = dcy + ro * Math.sin(a0)
    const x1o = dcx + ro * Math.cos(a1), y1o = dcy + ro * Math.sin(a1)
    const x1i = dcx + ri * Math.cos(a1), y1i = dcy + ri * Math.sin(a1)
    const x0i = dcx + ri * Math.cos(a0), y0i = dcy + ri * Math.sin(a0)
    const large = a.frac > 0.5 ? 1 : 0
    b += `<path d="M${x0o.toFixed(1)},${y0o.toFixed(1)} A${ro},${ro} 0 ${large} 1 ${x1o.toFixed(1)},${y1o.toFixed(1)} L${x1i.toFixed(1)},${y1i.toFixed(1)} A${ri},${ri} 0 ${large} 0 ${x0i.toFixed(1)},${y0i.toFixed(1)} Z" fill="${a.c}"/>`
    ang = a1
  })
  b += T(dcx, dcy + 7, '17', { fs: 20, fw: '800', anchor: 'middle' })
  let lx2 = AX + 14
  ;[{ t: 'reddit.com', c: PINK }, { t: 'instagram.com', c: LPUR }, { t: 'tiktok.com', c: DPUR }].forEach(lg => {
    b += Crc(lx2, R2Y + R2H - 14, 3, lg.c)
    b += T(lx2 + 8, R2Y + R2H - 11, lg.t, { fs: 8.3, fill: '#777' })
    lx2 += lg.t.length * 5 + 18
  })

  // Card B: Potential Revenue Saved (DYNAMIC)
  b += R(BX, R2Y, CW, R2H, '#ffffff', 12, '#f0eaf9', 1)
  b += T(BX + 16, R2Y + 24, 'Potential Revenue', { fs: 11.5, fw: '700' })
  b += T(BX + 16, R2Y + 38, 'Saved', { fs: 11.5, fw: '700' })
  b += T(BX + CW - 14, R2Y + 24, `Total: ${revenueAmt}`, { fs: 8.5, fill: '#aaa', anchor: 'end' })
  const days = ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed']
  const barBaseY = R2Y + R2H - 26, barMaxH = 96, bw2 = 14, gap2 = 12
  let bx2 = BX + 18
  days.forEach((day, i) => {
    const isPeak = i === 2
    const h2 = isPeak ? barMaxH : 2
    b += R(bx2, barBaseY - h2, bw2, h2, isPeak ? DPUR : '#eee', 2)
    b += T(bx2 + bw2 / 2, barBaseY - h2 - 6, isPeak ? revenueAmt : '$0', { fs: 7.6, fill: isPeak ? '#333' : '#bbb', anchor: 'middle' })
    b += T(bx2 + bw2 / 2, barBaseY + 12, day, { fs: 8, fill: '#999', anchor: 'middle' })
    bx2 += bw2 + gap2
  })

  // Card C: Recently Detected URLs
  b += R(CX2, R2Y, CW, R2H, '#ffffff', 12, '#f0eaf9', 1)
  b += T(CX2 + 16, R2Y + 24, 'Recently Detected URLs', { fs: 11.5, fw: '700' })
  const urls = ['https://www.twitter.com/ac…', 'https://images.google.com/…', 'https://www.tiktok.com/@ac…', 'https://images.google.com/…', 'https://images.google.com/…']
  let uy = R2Y + 50
  urls.forEach(u => { b += T(CX2 + 16, uy, u, { fs: 9.5, fill: DPUR }); uy += 27 })

  b += T(W - 40, H - 16, '© Powered by Takedowns AI', { fs: 9, fill: '#999', anchor: 'end' })

  return `<svg width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${b}</svg>`
}

// ─── FANVUE: dark mobile Insights screenshot (359×764) ──────────────────────
function buildFanvueSvg(d) {
  const { earningsAmt, monthAmt, monthLabel, periodLabel, dateRange,
          totalAmt, totalDelta, subsAmt, subsDelta, chartStart, chartEnd } = d
  const W = 359, H = 764
  const GRN = '#22e584', WHT = '#ffffff', GRAY = '#8a8a8a', CARD = '#161616', BORDER = '#262626'

  const R = (x, y, w, h, fill, rx = 0, stroke = 'none', sw = 0) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" rx="${rx}"` +
    (stroke !== 'none' ? ` stroke="${stroke}" stroke-width="${sw}"` : '') + '/>'
  const T = (x, y, s, { fs = 11, fill = WHT, fw = 'normal', anchor = 'start', ls = '0' } = {}) =>
    `<text x="${x}" y="${y}" font-family="Liberation Sans,Arial,sans-serif" font-size="${fs}" fill="${fill}" font-weight="${fw}" text-anchor="${anchor}" letter-spacing="${ls}">${escXml(String(s))}</text>`
  const L = (x1, y1, x2, y2, stroke, sw = 1, dash = '') =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}"` + (dash ? ` stroke-dasharray="${dash}"` : '') + '/>'
  const Crc = (cx, cy, r, fill, stroke = 'none', sw = 0) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"` + (stroke !== 'none' ? ` stroke="${stroke}" stroke-width="${sw}"` : '') + '/>'

  let b = ''
  b += `<defs><filter id="fvGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`
  b += R(0, 0, W, H, '#0a0a0a')

  // status bar
  b += T(16, 20, '9:41', { fs: 11, fw: '600' })
  ;[0, 1, 2, 3].forEach(i => b += R(300 + i * 7, 17 - i * 2.2, 4, 8 + i * 2.2, WHT, 1))
  b += `<path d="M333,21 A9,9 0 0 1 351,21" fill="none" stroke="${WHT}" stroke-width="1.6"/>`
  b += R(340, 11, 15, 8, 'none', 2, WHT, 1.4)
  b += R(342, 13, 10, 4, WHT, 1)

  // header
  b += T(16, 52, 'INSIGHTS', { fs: 18, fw: '800', ls: '0.3' })
  b += T(343, 50, 'GMT +01', { fs: 9, fill: GRAY, anchor: 'end' })

  // tabs
  const tabs = ['Earnings', 'Subscribers', 'Monthly Earnings', 'C']
  let tx = 16
  tabs.forEach((t, i) => {
    b += T(tx, 80, t, { fs: 11.5, fill: i === 0 ? WHT : GRAY, fw: i === 0 ? '700' : '400' })
    if (i === 0) b += L(tx, 88, tx + t.length * 6.6, 88, GRN, 2)
    tx += t.length * 6.6 + 18
  })

  // period pills
  b += R(16, 100, 98, 24, '#1c1c1c', 12, BORDER, 1)
  b += T(65, 116, `${periodLabel} ⌄`, { fs: 9.5, fill: '#ddd', anchor: 'middle' })
  b += R(122, 100, 210, 24, '#1c1c1c', 12, BORDER, 1)
  b += T(134, 116, `📅 ${dateRange}`, { fs: 9, fill: '#ddd' })

  // cards (card2 deliberately overflows the canvas edge, matching the scrolled-carousel reference)
  const cardY = 140, cardH = 120, cW = 210
  const spark = (x0, y0, w, h, ph) => {
    const pts = []
    for (let i = 0; i <= 12; i++) {
      const t = i / 12
      const v = 0.5 + 0.28 * Math.sin(t * 7 + ph) + 0.12 * Math.sin(t * 13 + ph * 2)
      pts.push({ x: x0 + t * w, y: y0 + h * (1 - Math.max(0.05, Math.min(0.95, v))) })
    }
    return svgSmooth(pts)
  }
  const c1X = 16
  b += R(c1X, cardY, cW, cardH, CARD, 14)
  b += T(c1X + 16, cardY + 24, 'Earnings', { fs: 10.5, fill: GRAY })
  b += `<circle cx="${c1X + 72}" cy="${cardY + 20}" r="6" fill="none" stroke="${GRAY}" stroke-width="1.2"/><text x="${c1X + 72}" y="${cardY + 23}" font-size="8" fill="${GRAY}" text-anchor="middle">i</text>`
  b += T(c1X + 16, cardY + 52, earningsAmt, { fs: 21, fw: '700' })
  b += T(c1X + 16, cardY + 68, 'Since Aug 2024', { fs: 9, fill: GRAY })
  b += `<path d="${spark(c1X + 16, cardY + 78, cW - 32, 30, 0.4)}" fill="none" stroke="${GRN}" stroke-width="1.6" filter="url(#fvGlow)"/>`

  const c2X = 234
  b += R(c2X, cardY, cW, cardH, CARD, 14)
  b += T(c2X + 16, cardY + 24, 'This month', { fs: 10.5, fill: GRAY })
  b += T(c2X + 16, cardY + 52, monthAmt, { fs: 21, fw: '700' })
  b += T(c2X + 16, cardY + 68, monthLabel, { fs: 9, fill: GRAY })
  b += `<path d="${spark(c2X + 16, cardY + 78, cW - 32, 30, 2.1)}" fill="none" stroke="${GRN}" stroke-width="1.6" filter="url(#fvGlow)"/>`

  // earnings over time
  const eoY = 292
  b += T(16, eoY, 'Earnings over time', { fs: 14, fw: '700' })
  b += R(255, eoY - 16, 44, 22, GRN, 11)
  b += T(277, eoY - 1, 'Net', { fs: 9.5, fill: '#062b16', fw: '700', anchor: 'middle' })
  b += R(301, eoY - 16, 42, 22, '#1c1c1c', 11, BORDER, 1)
  b += T(322, eoY - 1, 'Gross', { fs: 9.5, fill: GRAY, anchor: 'middle' })

  const chX = 16, chY = eoY + 30, chW = 327, chH = 130
  ;[0.25, 0.5, 0.75].forEach(f => b += L(chX, chY + chH * f, chX + chW, chY + chH * f, '#2a2a2a', 1, '3,4'))
  const lines = [
    { c: '#ffffff', base: 0.18, amp: 0.10, ph: 0.2, freq: 6 },
    { c: '#7a2b2b', base: 0.46, amp: 0.08, ph: 1.1, freq: 7 },
    { c: '#34d6c4', base: 0.52, amp: 0.09, ph: 2.0, freq: 5.5 },
    { c: '#f5a623', base: 0.58, amp: 0.07, ph: 3.0, freq: 6.5 },
    { c: '#4a7dff', base: 0.64, amp: 0.08, ph: 4.0, freq: 6 },
    { c: '#c34ae0', base: 0.66, amp: 0.07, ph: 5.0, freq: 7.5 },
  ]
  lines.forEach(ln => {
    const pts = []
    for (let i = 0; i <= 40; i++) {
      const t = i / 40
      const v = ln.base - ln.amp * 0.5 + ln.amp * Math.sin(t * ln.freq + ln.ph) * 0.6 + ln.amp * 0.4 * Math.sin(t * ln.freq * 2.3 + ln.ph * 1.7)
      pts.push({ x: chX + t * chW, y: chY + chH * Math.max(0.02, Math.min(0.98, v)) })
    }
    b += `<path d="${svgSmooth(pts)}" fill="none" stroke="${ln.c}" stroke-width="1.4" filter="url(#fvGlow)" opacity="0.95"/>`
  })
  b += T(chX, chY + chH + 18, chartStart, { fs: 9.5, fill: GRAY })
  b += T(chX + chW, chY + chH + 18, chartEnd, { fs: 9.5, fill: GRAY, anchor: 'end' })
  b += L(16, chY + chH + 30, 343, chY + chH + 30, BORDER, 1)

  // summary rows
  const rowY1 = chY + chH + 58, rowY2 = rowY1 + 38
  b += Crc(22, rowY1 - 4, 4.5, '#8b5cf6')
  b += T(34, rowY1, 'Total', { fs: 11.5 })
  b += T(150, rowY1, totalAmt, { fs: 13, fw: '700' })
  b += R(280, rowY1 - 15, 60, 22, 'rgba(34,229,132,0.15)', 11)
  b += T(310, rowY1, totalDelta, { fs: 10, fill: GRN, fw: '600', anchor: 'middle' })

  b += Crc(22, rowY2 - 4, 4.5, '#ffffff')
  b += T(34, rowY2, 'Subs', { fs: 11.5 })
  b += T(150, rowY2, subsAmt, { fs: 13, fw: '700' })
  b += R(280, rowY2 - 15, 60, 22, 'rgba(34,229,132,0.15)', 11)
  b += T(310, rowY2, subsDelta, { fs: 10, fill: GRN, fw: '600', anchor: 'middle' })

  // bottom nav
  const navY = H - 30
  const icons = [36, 108, 180, 251, 323]
  b += L(0, navY - 23, W, navY - 23, BORDER, 1)
  b += `<path d="M${icons[0]-9},${navY-3} L${icons[0]},${navY-12} L${icons[0]+9},${navY-3}" fill="none" stroke="#ccc" stroke-width="1.6" stroke-linejoin="round"/>`
  b += `<rect x="${icons[0]-6}" y="${navY-3}" width="12" height="11" fill="none" stroke="#ccc" stroke-width="1.6"/>`
  b += `<path d="M${icons[1]},${navY-13} C${icons[1]-8},${navY-13} ${icons[1]-8},${navY-3} ${icons[1]-8},${navY} L${icons[1]+8},${navY} C${icons[1]+8},${navY-3} ${icons[1]+8},${navY-13} ${icons[1]},${navY-13}" fill="none" stroke="#ccc" stroke-width="1.6"/>`
  b += `<circle cx="${icons[1]}" cy="${navY+4}" r="3" fill="none" stroke="#ccc" stroke-width="1.6"/>`
  b += Crc(icons[2], navY - 5, 15, WHT)
  b += L(icons[2] - 7, navY - 5, icons[2] + 7, navY - 5, '#0a0a0a', 2)
  b += L(icons[2], navY - 12, icons[2], navY + 2, '#0a0a0a', 2)
  b += `<path d="M${icons[3]-10},${navY-14} L${icons[3]+10},${navY-14} L${icons[3]+10},${navY-2} L${icons[3]+3},${navY-2} L${icons[3]},${navY+4} L${icons[3]-3},${navY-2} L${icons[3]-10},${navY-2} Z" fill="none" stroke="#ccc" stroke-width="1.6" stroke-linejoin="round"/>`
  b += `<circle cx="${icons[4]}" cy="${navY-5}" r="15" fill="none" stroke="${GRN}" stroke-width="1.6"/>`
  b += T(icons[4], navY - 1, 'FV', { fs: 9, fw: '700', anchor: 'middle' })

  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${b}</svg>`
}

// ─── REVEAL/INFLOW: dark "Creator earnings overview" SaaS dashboard (1740×875)
function buildRevealSvg(d) {
  const { subsAmt, tipsAmt, postsAmt, referralsAmt, messagesAmt, streamsAmt, totalAmt,
          activeTab, chartDates, bars } = d
  const W = 870, H = 437.5, SCALE = 2
  const BG = '#070708', PANEL = '#131316', BORDER = '#222226', GRAY = '#8a8a8e', BLUE = '#3b82f6'

  const R = (x, y, w, h, fill, rx = 0, stroke = 'none', sw = 0) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" rx="${rx}"` +
    (stroke !== 'none' ? ` stroke="${stroke}" stroke-width="${sw}"` : '') + '/>'
  const T = (x, y, s, { fs = 10, fill = '#ffffff', fw = 'normal', anchor = 'start', ls = '0' } = {}) =>
    `<text x="${x}" y="${y}" font-family="Liberation Sans,Arial,sans-serif" font-size="${fs}" fill="${fill}" font-weight="${fw}" text-anchor="${anchor}" letter-spacing="${ls}">${escXml(String(s))}</text>`
  const L = (x1, y1, x2, y2, stroke, sw = 1, dash = '') =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}"` + (dash ? ` stroke-dasharray="${dash}"` : '') + '/>'
  const Crc = (cx, cy, r, fill, stroke = 'none', sw = 0) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"` + (stroke !== 'none' ? ` stroke="${stroke}" stroke-width="${sw}"` : '') + '/>'

  const icon = (type, x, y) => {
    const bg = { sub: '#103726', tip: '#0f2438', post: '#103726', ref: '#3a1320', msg: '#2a1240', stream: '#0f2438' }[type]
    const st = { sub: '#22c55e', tip: '#60a5fa', post: '#22c55e', ref: '#f472b6', msg: '#a78bfa', stream: '#60a5fa' }[type]
    let s = R(x, y, 26, 26, bg, 6)
    const cx = x + 13, cy = y + 13
    if (type === 'sub') s += `<rect x="${cx-5}" y="${cy-6}" width="10" height="12" rx="1.5" fill="none" stroke="${st}" stroke-width="1.3"/><line x1="${cx}" y1="${cy-1}" x2="${cx}" y2="${cy+3}" stroke="${st}" stroke-width="1.3"/><line x1="${cx-2}" y1="${cy+1}" x2="${cx+2}" y2="${cy+1}" stroke="${st}" stroke-width="1.3"/>`
    else if (type === 'tip') s += `<circle cx="${cx}" cy="${cy-2}" r="5" fill="none" stroke="${st}" stroke-width="1.3"/><line x1="${cx-2}" y1="${cy+6}" x2="${cx+2}" y2="${cy+6}" stroke="${st}" stroke-width="1.3"/>`
    else if (type === 'post') s += `<rect x="${cx-5}" y="${cy-6}" width="10" height="12" rx="1.5" fill="none" stroke="${st}" stroke-width="1.3"/><line x1="${cx-3}" y1="${cy-2}" x2="${cx+3}" y2="${cy-2}" stroke="${st}" stroke-width="1"/><line x1="${cx-3}" y1="${cy+1}" x2="${cx+3}" y2="${cy+1}" stroke="${st}" stroke-width="1"/>`
    else if (type === 'ref') s += `<circle cx="${cx}" cy="${cy-3}" r="3.5" fill="none" stroke="${st}" stroke-width="1.3"/><path d="M${cx-6},${cy+7} C${cx-6},${cy+1} ${cx+6},${cy+1} ${cx+6},${cy+7}" fill="none" stroke="${st}" stroke-width="1.3"/>`
    else if (type === 'msg') s += `<path d="M${cx-6},${cy-5} L${cx+6},${cy-5} L${cx+6},${cy+2} L${cx+1},${cy+2} L${cx-2},${cy+6} L${cx-2},${cy+2} L${cx-6},${cy+2} Z" fill="none" stroke="${st}" stroke-width="1.3" stroke-linejoin="round"/>`
    else s += `<line x1="${cx-5}" y1="${cy+5}" x2="${cx-5}" y2="${cy-2}" stroke="${st}" stroke-width="1.6"/><line x1="${cx}" y1="${cy+5}" x2="${cx}" y2="${cy-6}" stroke="${st}" stroke-width="1.6"/><line x1="${cx+5}" y1="${cy+5}" x2="${cx+5}" y2="${cy-1}" stroke="${st}" stroke-width="1.6"/>`
    return s
  }
  const metric = (x, y, amt, label, type) =>
    T(x, y, amt, { fs: 13, fw: '700' }) + T(x, y + 14, label, { fs: 8.5, fill: GRAY }) + icon(type, x + 125, y - 19)

  let b = ''
  b += `<defs><radialGradient id="rvLogo" cx="35%" cy="30%" r="75%"><stop offset="0%" stop-color="#60a5fa"/><stop offset="100%" stop-color="#2563eb"/></radialGradient></defs>`
  b += R(0, 0, W, H, BG)

  // top bar
  b += R(0, 0, W, 26, '#050505')
  b += L(0, 26, W, 26, BORDER, 1)
  ;[0, 1, 2].forEach(i => b += L(12, 9 + i * 4, 24, 9 + i * 4, '#999', 1.3))
  b += Crc(40, 13, 9, 'url(#rvLogo)')
  b += `<path d="M36,13 L39,16 L45,9" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`
  let hx = 432
  b += Crc(hx, 13, 3, '#22c55e'); b += T(hx + 8, 16, 'Operational', { fs: 9, fill: '#22c55e' }); hx += 80
  b += T(hx, 16, '◐ UTC+02:00', { fs: 9, fill: GRAY }); hx += 78
  b += T(hx, 16, '⇄ Referrals', { fs: 9, fill: GRAY }); hx += 64
  b += T(hx, 16, '🏆 Leaderboard', { fs: 9, fill: GRAY }); hx += 84
  b += T(hx, 16, '🔔', { fs: 10, fill: GRAY })
  b += R(hx + 6, 5, 22, 12, '#ec4899', 6); b += T(hx + 17, 14, '99+', { fs: 6.5, fill: '#fff', fw: '700', anchor: 'middle' }); hx += 40
  b += Crc(hx + 6, 13, 9, '#444')

  // header row
  b += T(34, 50, 'Creator earnings overview', { fs: 13, fw: '700' })
  b += `<circle cx="195" cy="46" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/><text x="195" y="49" font-size="7" fill="${GRAY}" text-anchor="middle">i</text>`
  b += T(211, 50, 'UTC+01:00', { fs: 9.5, fill: GRAY })
  b += R(540, 38, 108, 18, '#171719', 9, BORDER, 1)
  b += T(594, 50, 'Gross earnings ⌄', { fs: 8.5, fill: '#ccc', anchor: 'middle' })
  const tabs = ['Yesterday', 'Today', 'This week', 'This month']
  let tbx = 658
  tabs.forEach(t => {
    const tw = t.length * 5.6 + 16
    const active = t === activeTab
    if (active) b += R(tbx, 38, tw, 18, BLUE, 9)
    b += T(tbx + tw / 2, 50, t, { fs: 8.5, fill: active ? '#fff' : GRAY, fw: active ? '600' : '400', anchor: 'middle' })
    tbx += tw + 6
  })

  // main earnings card
  const MC_Y = 68, MC_H = 128
  b += R(34, MC_Y, 824, MC_H, PANEL, 10, BORDER, 1)
  b += Crc(60, MC_Y + 34, 15, 'url(#rvLogo)')
  b += `<path d="M54,${MC_Y+34} L58,${MC_Y+38} L67,${MC_Y+27}" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
  b += T(42, MC_Y + 72, totalAmt, { fs: 19, fill: BLUE, fw: '800' })
  b += T(42, MC_Y + 86, 'Total earnings', { fs: 8.5, fill: GRAY })
  ;[197, 397, 597].forEach(lx => b += L(lx, MC_Y + 18, lx, MC_Y + MC_H - 18, BORDER, 1))
  b += metric(217, MC_Y + 45, subsAmt, 'Subscriptions', 'sub')
  b += metric(217, MC_Y + 90, tipsAmt, 'Tips', 'tip')
  b += metric(420, MC_Y + 45, postsAmt, 'Posts', 'post')
  b += metric(420, MC_Y + 90, referralsAmt, 'Referrals', 'ref')
  b += metric(623, MC_Y + 45, messagesAmt, 'Messages', 'msg')
  b += metric(623, MC_Y + 90, streamsAmt, 'Streams', 'stream')

  // lower area
  const LY = MC_Y + MC_H + 12
  b += R(0, 26, 26, H - 26, '#050505')
  // sidebar nav icons
  const sideIcons = [
    iy => [0,3,6].map(dy => `<line x1="8" y1="${iy+1+dy}" x2="18" y2="${iy+1+dy}" stroke="#555" stroke-width="1.2" stroke-linecap="round"/>`).join(''),
    iy => [0,1].flatMap(r=>[0,1].map(c=>`<rect x="${8+c*5}" y="${iy+r*5}" width="4" height="4" rx="0.5" fill="#444"/>`)).join(''),
    iy => `<rect x="8" y="${iy+5}" width="2.5" height="5" fill="#555" rx="0.5"/><rect x="11.5" y="${iy+2}" width="2.5" height="8" fill="#555" rx="0.5"/><rect x="15" y="${iy}" width="2.5" height="10" fill="#555" rx="0.5"/>`,
    iy => `<circle cx="13" cy="${iy+3}" r="2.5" fill="none" stroke="#555" stroke-width="1.2"/><path d="M8,${iy+10} C8,${iy+5} 18,${iy+5} 18,${iy+10}" fill="none" stroke="#555" stroke-width="1.2"/>`,
    iy => `<circle cx="13" cy="${iy+5}" r="2" fill="none" stroke="#555" stroke-width="1.2"/><circle cx="13" cy="${iy+5}" r="4.5" fill="none" stroke="#555" stroke-width="1.2" stroke-dasharray="2 1.5"/>`,
  ]
  ;[60, 100, 140, 180, 220].forEach((iy, i) => b += sideIcons[i](iy))

  // My shifts panel
  const SH_H = H - LY - 14
  b += R(34, LY, 178, SH_H, PANEL, 10, BORDER, 1)
  b += T(50, LY + 22, 'My shifts', { fs: 11.5, fw: '700' })
  b += `<circle cx="106" cy="${LY+18}" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/><text x="106" y="${LY+21}" font-size="7" fill="${GRAY}" text-anchor="middle">i</text>`
  const myCx = 34 + 89, myCy = LY + SH_H / 2 + 10
  b += R(myCx - 16, myCy - 16, 32, 28, 'none', 4, '#444', 1.3)
  b += L(myCx - 9, myCy - 7, myCx + 9, myCy - 7, '#444', 1.2)
  b += L(myCx - 9, myCy - 1, myCx + 9, myCy - 1, '#444', 1.2)
  b += T(myCx, myCy + 34, 'No data', { fs: 9.5, fill: GRAY, anchor: 'middle' })

  // right column: clocked-in employees + employee sales chart
  const RX = 222
  b += R(RX, LY, 636, 46, PANEL, 10, BORDER, 1)
  b += T(RX + 16, LY + 22, 'Current clocked-in employees', { fs: 11.5, fw: '700' })
  b += T(RX + 235, LY + 22, '👥 1', { fs: 9.5, fill: GRAY })
  b += R(RX + 16, LY + 30, 46, 16, '#222226', 8)
  b += T(RX + 39, LY + 41, 'Junior', { fs: 8, fill: '#ccc', anchor: 'middle' })

  const y2 = LY + 46 + 10, h2 = SH_H - 46 - 10
  b += R(RX, y2, 636, h2, PANEL, 10, BORDER, 1)
  b += T(RX + 16, y2 + 20, 'Employee sales', { fs: 11.5, fw: '700' })
  b += `<circle cx="${RX+108}" cy="${y2+16}" r="6" fill="none" stroke="${GRAY}" stroke-width="1"/><text x="${RX+108}" y="${y2+19}" font-size="7" fill="${GRAY}" text-anchor="middle">i</text>`

  const chX = RX + 95, chY = y2 + 34, chW = 525, chH = h2 - 50
  ;[0, 1, 2, 3, 4].forEach(i => {
    const gy = chY + chH * i / 4
    b += L(chX, gy, chX + chW, gy, '#262629', 1, '2,4')
    b += T(chX - 10, gy + 3, String(2000 - i * 500), { fs: 8, fill: GRAY, anchor: 'end' })
  })
  const SHAPE = [0.75, 0.48, 0.57, 0.80, 0.74, 0.36, 0.50, 0.02, 0, 0, 0, 0, 0, 0, 0]
  const resample = (arr, n) => Array.from({ length: n }, (_, i) => {
    const t = n > 1 ? i / (n - 1) * (arr.length - 1) : 0
    const i0 = Math.floor(t), i1 = Math.min(i0 + 1, arr.length - 1), f = t - i0
    return arr[i0] * (1 - f) + arr[i1] * f
  })
  const chartVals = resample(SHAPE, bars)
  const pts = chartVals.map((v, i) => ({ x: chX + (bars > 1 ? i / (bars - 1) : 0) * chW, y: chY + chH * (1 - v) }))
  b += `<path d="${svgSmooth(pts)}" fill="none" stroke="${BLUE}" stroke-width="1.6"/>`
  pts.forEach(p => b += Crc(p.x, p.y, 2.6, '#0a0a0a', BLUE, 1.6))
  chartDates.forEach((lbl, i) => {
    const lx = chX + (chartDates.length > 1 ? i / (chartDates.length - 1) : 0) * chW
    b += T(lx, chY + chH + 16, lbl, { fs: 7.8, fill: GRAY, anchor: i === 0 ? 'start' : i === chartDates.length - 1 ? 'end' : 'middle' })
  })

  return `<svg width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${b}</svg>`
}

// ─── PUPPETEER BROWSER ───────────────────────────────────────────────────────
let _browser = null
async function getBrowser() {
  if (_browser && _browser.connected) return _browser
  let executablePath
  if (process.platform !== 'darwin') {
    // Linux/Railway: use @sparticuz/chromium
    try {
      const chromiumPkg = require('@sparticuz/chromium')
      const chromium = chromiumPkg.default || chromiumPkg
      if (typeof chromium.executablePath === 'function') {
        executablePath = await chromium.executablePath()
      }
    } catch (_) {}
    // Also check system chromium on Linux
    if (!executablePath) {
      for (const p of ['/usr/bin/chromium-browser', '/usr/bin/chromium']) {
        try { fs.accessSync(p); executablePath = p; break } catch (_2) {}
      }
    }
  } else {
    // macOS dev: use system Chrome/Chromium
    for (const p of [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]) { try { fs.accessSync(p); executablePath = p; break } catch (_2) {} }
  }
  _browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-gpu', '--no-first-run', '--disable-extensions',
           '--disable-background-networking', '--disable-sync'],
  })
  return _browser
}

async function renderHtml(html, vpWidth, vpHeight) {
  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: vpWidth, height: vpHeight, deviceScaleFactor: 2 })
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
    await page.goto(dataUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: vpWidth, height: vpHeight } })
    return buf
  } finally {
    await page.close()
  }
}

// ─── CHART SVG HELPERS (shared for HTML injection) ──────────────────────────
function makeOFMainChart(cData, bars) {
  const W = 768, CH = 280, CPL = 8, CPR = 68, CPT = 16
  const CPW = W - CPL - CPR, CPH = CH - CPT
  const BLUE = '#00aff0', BDR = '#e5e5e5', LGR = '#9e9e9e'
  const maxD = Math.max(...cData, 1)
  const yTop = roundToNice(maxD * 1.05)
  const yLvls = [
    { v: yTop,            gy: CPT },
    { v: Math.round(yTop * 2 / 3), gy: CPT + CPH * (1 / 3) },
    { v: Math.round(yTop * 1 / 3), gy: CPT + CPH * (2 / 3) },
  ]
  const cPts = cData.map((v, i) => ({
    x: CPL + (bars > 1 ? i / (bars - 1) : 0) * CPW,
    y: CPT + (1 - v / yTop) * CPH,
  }))
  const cLine = svgLine(cPts)
  const cFill = cLine + ` L ${cPts[cPts.length - 1].x.toFixed(1)} ${(CPT + CPH).toFixed(1)} L ${CPL} ${(CPT + CPH).toFixed(1)} Z`
  let s = `<svg width="${W}" height="${CH}" viewBox="0 0 ${W} ${CH}" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0">`
  s += `<rect width="${W}" height="${CH}" fill="#f0faff"/>`
  s += `<defs><linearGradient id="ofG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${BLUE}" stop-opacity="0.28"/><stop offset="100%" stop-color="${BLUE}" stop-opacity="0.04"/></linearGradient></defs>`
  for (let i = 1; i <= 4; i++) { const gx = CPL + CPW * i / 5; s += `<line x1="${gx.toFixed(1)}" y1="${CPT}" x2="${gx.toFixed(1)}" y2="${(CPT + CPH).toFixed(1)}" stroke="${BDR}" stroke-width="0.8"/>` }
  yLvls.forEach(lv => { s += `<line x1="${CPL}" y1="${lv.gy.toFixed(1)}" x2="${(W - CPR).toFixed(1)}" y2="${lv.gy.toFixed(1)}" stroke="${BDR}" stroke-width="0.8"/>` })
  s += `<path d="${cFill}" fill="url(#ofG)"/>`
  s += `<path d="${cLine}" fill="none" stroke="${BLUE}" stroke-width="2.5" stroke-linejoin="miter"/>`
  yLvls.forEach(lv => { s += `<text x="${W - CPR + 10}" y="${(lv.gy + 4).toFixed(1)}" font-family="Arial,sans-serif" font-size="13" fill="${LGR}">$${Math.round(lv.v).toLocaleString('en-US')}</text>` })
  s += '</svg>'
  return s
}

function makeOFSecChart(cData2, bars) {
  const W = 768, C2H = 62, C2PL = 8, C2PR = 68, C2PT = 7, C2PB = 5
  const C2PW = W - C2PL - C2PR, C2PH = C2H - C2PT - C2PB
  const LGR = '#9e9e9e', BDR = '#e5e5e5'
  const maxV2 = Math.max(...cData2, 1)
  const y2Top = roundToNice(maxV2 * 1.15)
  const c2Pts = cData2.map((v, i) => ({
    x: C2PL + (bars > 1 ? i / (bars - 1) : 0) * C2PW,
    y: C2PT + (1 - v / y2Top) * C2PH,
  }))
  const c2Line = svgLine(c2Pts)
  const c2Fill = c2Line + ` L ${c2Pts[c2Pts.length - 1].x.toFixed(1)} ${(C2PT + C2PH).toFixed(1)} L ${C2PL} ${(C2PT + C2PH).toFixed(1)} Z`
  let s = `<svg width="${W}" height="${C2H}" viewBox="0 0 ${W} ${C2H}" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0">`
  s += `<rect width="${W}" height="${C2H}" fill="#ffffff"/>`
  s += `<line x1="0" y1="0" x2="${W}" y2="0" stroke="${BDR}" stroke-width="0.8"/>`
  s += `<path d="${c2Fill}" fill="rgba(0,0,0,0.05)"/>`
  s += `<path d="${c2Line}" fill="none" stroke="#aaaaaa" stroke-width="2" stroke-linejoin="miter"/>`
  s += `<text x="${W - C2PR + 10}" y="${C2PT + 4}" font-family="Arial,sans-serif" font-size="13" fill="${LGR}">${Math.round(y2Top)}</text>`
  s += `<text x="${W - C2PR + 10}" y="${(C2PT + C2PH * 0.5 + 4).toFixed(1)}" font-family="Arial,sans-serif" font-size="13" fill="${LGR}">${Math.round(y2Top / 2)}</text>`
  s += '</svg>'
  return s
}

function makeFanfixWaveChart(dateLabels) {
  const CW = 444, CH = 148
  const svgSmooth2 = svgSmooth
  const wave = (baseFrac, ampFrac, phase) => {
    const pts = []
    for (let i = 0; i <= 5; i++) {
      const t = i / 5
      const v = baseFrac + ampFrac * Math.sin(t * Math.PI * 1.6 + phase)
      pts.push({ x: t * CW, y: CH * (1 - v) })
    }
    return pts
  }
  const layer = (pts, fill) => {
    const dd = svgSmooth2(pts) + ` L ${pts[pts.length - 1].x.toFixed(1)} ${CH} L 0 ${CH} Z`
    return `<path d="${dd}" fill="${fill}" opacity="0.85"/>`
  }
  let s = `<svg width="${CW}" height="${CH + 20}" viewBox="0 0 ${CW} ${CH + 20}" xmlns="http://www.w3.org/2000/svg" style="display:block">`
  s += layer(wave(0.62, 0.14, 0.6), '#f9a8d4')
  s += layer(wave(0.44, 0.16, 2.4), '#a78bfa')
  s += layer(wave(0.26, 0.13, 4.1), '#7c3aed')
  const dlLen = dateLabels.length
  dateLabels.forEach((lbl, i) => {
    const lx = dlLen > 1 ? i / (dlLen - 1) * CW : 0
    const anchor = i === 0 ? 'start' : i === dlLen - 1 ? 'end' : 'middle'
    s += `<text x="${lx.toFixed(1)}" y="${CH + 14}" font-family="Arial,sans-serif" font-size="9.5" fill="#aaa" text-anchor="${anchor}">${escXml(lbl)}</text>`
  })
  s += '</svg>'
  return s
}

function makeFanfixDonut() {
  const CX = 70, CY = 60, RO = 42, RI = 26
  const segs = [{ frac: 0.5, c: '#ec4899' }, { frac: 0.15, c: '#a78bfa' }, { frac: 0.35, c: '#7c3aed' }]
  let ang = -Math.PI / 2
  let s = `<svg width="140" height="130" viewBox="0 0 140 130" xmlns="http://www.w3.org/2000/svg" style="display:block">`
  segs.forEach(a => {
    const a0 = ang, a1 = ang + a.frac * 2 * Math.PI
    const x0o = CX + RO * Math.cos(a0), y0o = CY + RO * Math.sin(a0)
    const x1o = CX + RO * Math.cos(a1), y1o = CY + RO * Math.sin(a1)
    const x1i = CX + RI * Math.cos(a1), y1i = CY + RI * Math.sin(a1)
    const x0i = CX + RI * Math.cos(a0), y0i = CY + RI * Math.sin(a0)
    const large = a.frac > 0.5 ? 1 : 0
    s += `<path d="M${x0o.toFixed(1)},${y0o.toFixed(1)} A${RO},${RO} 0 ${large} 1 ${x1o.toFixed(1)},${y1o.toFixed(1)} L${x1i.toFixed(1)},${y1i.toFixed(1)} A${RI},${RI} 0 ${large} 0 ${x0i.toFixed(1)},${y0i.toFixed(1)} Z" fill="${a.c}"/>`
    ang = a1
  })
  s += `<text x="${CX}" y="${CY + 7}" font-family="Arial,sans-serif" font-size="20" font-weight="800" text-anchor="middle" fill="#0a0a0a">17</text>`
  s += '</svg>'
  return s
}

function makeFanfixBars(revenueAmt) {
  const W = 175, H = 120
  const days = ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed']
  const barBaseY = H - 22, barMaxH = 80, bw = 14, gap = 10
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;margin-top:6px">`
  let bx = 4
  days.forEach((day, i) => {
    const isPeak = i === 2
    const h2 = isPeak ? barMaxH : 2
    const fill = isPeak ? '#7c3aed' : '#eee'
    s += `<rect x="${bx}" y="${barBaseY - h2}" width="${bw}" height="${h2}" rx="2" fill="${fill}"/>`
    if (isPeak) s += `<text x="${bx + bw / 2}" y="${barBaseY - h2 - 5}" font-family="Arial,sans-serif" font-size="7.6" fill="#333" text-anchor="middle">${escXml(revenueAmt)}</text>`
    s += `<text x="${bx + bw / 2}" y="${barBaseY + 12}" font-family="Arial,sans-serif" font-size="8" fill="#999" text-anchor="middle">${day}</text>`
    bx += bw + gap
  })
  s += '</svg>'
  return s
}

function makeFanvueSpark(phase) {
  const W = 178, H = 30
  const pts = []
  for (let i = 0; i <= 12; i++) {
    const t = i / 12
    const v = 0.5 + 0.28 * Math.sin(t * 7 + phase) + 0.12 * Math.sin(t * 13 + phase * 2)
    pts.push({ x: t * W, y: H * (1 - Math.max(0.05, Math.min(0.95, v))) })
  }
  const line = svgSmooth(pts)
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;margin-top:6px"><path d="${line}" fill="none" stroke="#22e584" stroke-width="1.6"/></svg>`
}

function makeFanvueChart(bars) {
  const CW = 327, CH = 130
  const linesSpec = [
    { c: '#ffffff', base: 0.18, amp: 0.10, ph: 0.2, freq: 6 },
    { c: '#7a2b2b', base: 0.46, amp: 0.08, ph: 1.1, freq: 7 },
    { c: '#34d6c4', base: 0.52, amp: 0.09, ph: 2.0, freq: 5.5 },
    { c: '#f5a623', base: 0.58, amp: 0.07, ph: 3.0, freq: 6.5 },
    { c: '#4a7dff', base: 0.64, amp: 0.08, ph: 4.0, freq: 6 },
    { c: '#c34ae0', base: 0.66, amp: 0.07, ph: 5.0, freq: 7.5 },
  ]
  let s = `<svg width="${CW}" height="${CH + 20}" viewBox="0 0 ${CW} ${CH + 20}" xmlns="http://www.w3.org/2000/svg" style="display:block">`
  ;[0.25, 0.5, 0.75].forEach(f => { s += `<line x1="0" y1="${(CH * f).toFixed(1)}" x2="${CW}" y2="${(CH * f).toFixed(1)}" stroke="#2a2a2a" stroke-width="1" stroke-dasharray="3,4"/>` })
  linesSpec.forEach(ln => {
    const pts = []
    for (let i = 0; i <= 40; i++) {
      const t = i / 40
      const v = ln.base - ln.amp * 0.5 + ln.amp * Math.sin(t * ln.freq + ln.ph) * 0.6 + ln.amp * 0.4 * Math.sin(t * ln.freq * 2.3 + ln.ph * 1.7)
      pts.push({ x: t * CW, y: CH * Math.max(0.02, Math.min(0.98, v)) })
    }
    s += `<path d="${svgSmooth(pts)}" fill="none" stroke="${ln.c}" stroke-width="1.4" opacity="0.95"/>`
  })
  s += '</svg>'
  return s
}

function makeRevealChart(bars, chartDates, chartMax, seed) {
  const YLBL_W = 38, CPR = 4
  const CW = 490, CH = 130, PW = CW - YLBL_W - CPR
  const BLUE = '#3b82f6', GRAY = '#8a8a8e', GRID = '#262629'
  const yMax = chartMax || 2000
  // Seeded shape: activity peak then drop to 0 — matches real Inflow/Reveal look
  const rngS = seededRng(seed || Math.round(yMax))
  const peakPos   = 3 + Math.floor(rngS() * 3)   // peak at index 3-5
  const peakH     = 0.78 + rngS() * 0.18          // peak height 0.78-0.96
  const dropStart = peakPos + 2 + Math.floor(rngS() * 2)  // drop starts 2-3 after peak
  const SHAPE = Array.from({ length: 15 }, (_, i) => {
    if (i < peakPos) return peakH * (0.5 + 0.5 * (i / peakPos)) * (0.85 + rngS() * 0.15)
    if (i === peakPos) return peakH
    if (i <= dropStart) return peakH * (0.9 - 0.15 * (i - peakPos)) * (0.9 + rngS() * 0.1)
    if (i === dropStart + 1) return 0.04 + rngS() * 0.06
    return 0
  })
  const resample = (arr, n) => Array.from({ length: n }, (_, i) => {
    const t = n > 1 ? i / (n - 1) * (arr.length - 1) : 0
    const i0 = Math.floor(t), i1 = Math.min(i0 + 1, arr.length - 1), f = t - i0
    return arr[i0] * (1 - f) + arr[i1] * f
  })
  const vals = resample(SHAPE, bars)
  const pts = vals.map((v, i) => ({
    x: YLBL_W + (bars > 1 ? i / (bars - 1) : 0) * PW,
    y: CH * (1 - Math.max(0, Math.min(1, v))),
  }))
  const TOTAL_H = CH + 18
  let s = `<svg width="${CW}" height="${TOTAL_H}" viewBox="0 0 ${CW} ${TOTAL_H}" xmlns="http://www.w3.org/2000/svg" style="display:block;width:100%">`
  // Y-axis grid lines + labels
  const yLevels = [0, 0.25, 0.5, 0.75, 1]
  yLevels.forEach(f => {
    const gy = (CH * (1 - f)).toFixed(1)
    s += `<line x1="${YLBL_W}" y1="${gy}" x2="${CW - CPR}" y2="${gy}" stroke="${GRID}" stroke-width="0.8" stroke-dasharray="2,4"/>`
    const labelVal = Math.round(yMax * f)
    s += `<text x="${(YLBL_W - 4).toFixed(1)}" y="${(parseFloat(gy) + 3.5).toFixed(1)}" font-family="Arial,sans-serif" font-size="8" fill="${GRAY}" text-anchor="end">${labelVal}</text>`
  })
  s += `<path d="${svgSmooth(pts)}" fill="none" stroke="${BLUE}" stroke-width="1.8"/>`
  pts.forEach(p => { s += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.8" fill="#070708" stroke="${BLUE}" stroke-width="1.6"/>` })
  // X-axis date labels
  const dlLen = chartDates.length
  chartDates.forEach((lbl, i) => {
    const lx = YLBL_W + (dlLen > 1 ? i / (dlLen - 1) : 0) * PW
    const anchor = i === 0 ? 'start' : i === dlLen - 1 ? 'end' : 'middle'
    s += `<text x="${lx.toFixed(1)}" y="${CH + 13}" font-family="Arial,sans-serif" font-size="7.8" fill="${GRAY}" text-anchor="${anchor}">${escXml(lbl)}</text>`
  })
  s += '</svg>'
  return s
}

// ─── HTML BUILDERS ───────────────────────────────────────────────────────────
function loadTemplate(name) {
  return fs.readFileSync(path.join(__dirname, 'templates', `${name}.html`), 'utf8')
}

function buildOFHtml(d) {
  const { curBal, pendBal, periodLabel, dateRange, netAmt, grossAmt, growthPct, cData, cData2, bars, dateLabels } = d
  const mainSvg = makeOFMainChart(cData, bars)
  const secSvg  = makeOFSecChart(cData2, bars)
  const dateHtml = dateLabels.map((l, i) => {
    const parts = l.split('\n')
    const style = i === 0 ? 'text-align:left' : i === dateLabels.length - 1 ? 'text-align:right' : 'text-align:center'
    return `<span style="${style}">${parts.map(p => escXml(p)).join('<br>')}</span>`
  }).join('')
  return loadTemplate('OF')
    .replace('{{CUR_BAL}}',      escXml(curBal))
    .replace('{{PEND_BAL}}',     escXml(pendBal))
    .replace('{{PERIOD_LABEL}}', escXml(periodLabel))
    .replace('{{DATE_RANGE}}',   escXml(dateRange))
    .replace('{{NET_AMT}}',      escXml(netAmt))
    .replace('{{GROSS_AMT}}',    escXml(grossAmt))
    .replace('{{GROWTH_PCT}}',   String(growthPct))
    .replace('{{CHART_MAIN}}',   mainSvg)
    .replace('{{CHART_SEC}}',    secSvg)
    .replace('{{DATE_LABELS}}',  dateHtml)
}

function buildFanfixHtml(d) {
  const { revenueAmt, periodLabel, dateLabels } = d
  return loadTemplate('Fanfix')
    .replace('{{PERIOD_LABEL}}', escXml(periodLabel))
    .replace('{{REVENUE_AMT}}',  escXml(revenueAmt))
    .replace('{{CHART_WAVE}}',   makeFanfixWaveChart(dateLabels))
    .replace('{{CHART_DONUT}}',  makeFanfixDonut())
    .replace('{{CHART_BARS}}',   makeFanfixBars(revenueAmt))
}

function buildFanvueHtml(d) {
  const { earningsAmt, monthAmt, monthLabel, periodLabel, dateRange, totalAmt, totalDelta, subsAmt, subsDelta, bars } = d
  return loadTemplate('Fanvue')
    .replace('{{EARNINGS_AMT}}', escXml(earningsAmt))
    .replace('{{MONTH_AMT}}',    escXml(monthAmt))
    .replace('{{MONTH_LABEL}}',  escXml(monthLabel))
    .replace('{{PERIOD_LABEL}}', escXml(periodLabel))
    .replace('{{DATE_RANGE}}',   escXml(dateRange))
    .replace('{{TOTAL_AMT}}',    escXml(totalAmt))
    .replace('{{TOTAL_DELTA}}',  escXml(totalDelta))
    .replace('{{SUBS_AMT}}',     escXml(subsAmt))
    .replace('{{SUBS_DELTA}}',   escXml(subsDelta))
    .replace('{{SPARK1}}',       makeFanvueSpark(0.4))
    .replace('{{SPARK2}}',       makeFanvueSpark(2.1))
    .replace('{{CHART_LINES}}',  makeFanvueChart(bars))
}

function buildRevealHtml(d) {
  const { subsAmt, tipsAmt, postsAmt, referralsAmt, messagesAmt, streamsAmt, totalAmt, activeTab, chartDates, bars, chartMax, seed } = d
  const tabClass = t => activeTab === t ? 'a' : ''
  return loadTemplate('Reveal')
    .replace('{{TOTAL_AMT}}',    escXml(totalAmt))
    .replace('{{SUBS_AMT}}',     escXml(subsAmt))
    .replace('{{TIPS_AMT}}',     escXml(tipsAmt))
    .replace('{{POSTS_AMT}}',    escXml(postsAmt))
    .replace('{{REFS_AMT}}',     escXml(referralsAmt))
    .replace('{{MSGS_AMT}}',     escXml(messagesAmt))
    .replace('{{STREAMS_AMT}}',  escXml(streamsAmt))
    .replace('{{TAB_YESTERDAY}}', tabClass('Yesterday'))
    .replace('{{TAB_TODAY}}',     tabClass('Today'))
    .replace('{{TAB_WEEK}}',      tabClass('This week'))
    .replace('{{TAB_MONTH}}',     tabClass('This month'))
    .replace('{{CHART_LINE}}',   makeRevealChart(bars, chartDates, chartMax, seed))
}

const DASH_TEMPLATES = new Set(['OF', 'Fanfix', 'Fanvue', 'Reveal'])

app.post('/dashboard/generate', genericLimiter, async (req, res) => {
  try {
    const { amount, period, template, startDate, endDate } = req.body
    const gross = parseFloat(amount) || 0
    const tpl   = (template || 'OF').trim()

    if (!DASH_TEMPLATES.has(tpl)) return res.status(404).json({ error: `Template introuvable: ${tpl}` })

    // Period
    let bars = 30, pStart, pEnd
    const now = new Date()
    if (period === '24h') {
      bars = 24; pStart = new Date(now - 86400000); pEnd = now
    } else if (period === '7d' || period === '1w') {
      bars = 7; pStart = new Date(now - 7 * 86400000); pEnd = now
    } else if (period === 'custom' && startDate && endDate) {
      pStart = new Date(startDate); pEnd = new Date(endDate)
      bars = Math.min(Math.max(1, Math.ceil((pEnd - pStart) / 86400000)), 60)
    } else {
      pStart = new Date(now - 30 * 86400000); pEnd = now
    }

    // Organic ±15% variation — seeded so same input always yields same result
    const orgRng     = seededRng(Math.round(Math.abs(gross) * 137 + 31337))
    const orgPct     = (orgRng() - 0.5) * 0.30
    const orgRaw     = gross * (1 + orgPct)
    const CENTS_POOL = [12,17,21,28,34,38,43,47,52,58,61,67,72,76,83,87,91,94,97]
    const orgCents   = CENTS_POOL[Math.floor(orgRng() * CENTS_POOL.length)]
    const displayGross = Math.floor(orgRaw) + orgCents / 100

    // Shared financials (seeded from displayGross)
    const rng0      = seededRng(Math.round(displayGross * 1000))
    // Helper: round to cents
    const r2 = v => Math.round(v * 100) / 100
    const net       = tpl === 'Reveal' ? displayGross : r2(displayGross * 0.80)
    const curBal    = r2(displayGross * (0.06 + rng0() * 0.04))
    const pendBal   = r2(displayGross * (0.22 + rng0() * 0.08))
    const growthPct = Math.floor(15 + rng0() * 30)
    const fmtUSD    = v => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const fmtFV     = v => '$ ' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

    let htmlStr, vpW, vpH

    if (tpl === 'OF') {
      // ── OF: pixel-perfect layout matching OF.png ──────────────────────────
      // English date format to match real OnlyFans UI
      const fmtEN = dt => dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      const periodEN =
        period === '24h'               ? 'Last 24 hours' :
        period === '7d' || period === '1w' ? 'Last 7 days'   :
        period === 'custom'            ? 'Custom period'  : 'Last 30 days'
      const dateRangeEN = `${fmtEN(pStart)} - ${fmtEN(pEnd)} (local time UTC +02:00)`

      let fmtXLbl
      if (period === '24h') {
        fmtXLbl = dt => `${dt.getHours()}:00\n${dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
      } else if (period === '7d' || period === '1w') {
        fmtXLbl = dt => dt.toLocaleDateString('en-US', { weekday: 'short' }) +
                        '\n' + dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      } else {
        fmtXLbl = dt => {
          const md = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          return `${md},\n${dt.getFullYear()}`
        }
      }
      const dateLabels = Array.from({ length: 5 }, (_, i) => {
        const t  = i / 4
        const dt = new Date(pStart.getTime() + t * (pEnd.getTime() - pStart.getTime()))
        return fmtXLbl(dt)
      })

      // Daily net values: organic shape (stable ±8%, 2-3 natural peaks)
      const cData  = dashOrganic(net, bars, Math.round(displayGross))
      // Secondary chart: engagement-scale counts, organic shape
      const cData2 = dashOrganic(displayGross * 0.02, bars, Math.round(displayGross) + 1)

      htmlStr = buildOFHtml({
        curBal:     fmtUSD(curBal),
        pendBal:    fmtUSD(pendBal),
        periodLabel: periodEN,
        dateRange:  dateRangeEN,
        netAmt:     fmtUSD(net),
        grossAmt:   fmtUSD(displayGross),
        growthPct,
        cData, cData2, bars, dateLabels,
      })
      vpW = 768; vpH = 1194
    } else if (tpl === 'Fanfix') {
      // ── Fanfix: Content Protection layout matching Fanfix.png ─────────────
      const periodLabel =
        period === '24h'                   ? 'Last 24 hours' :
        period === '7d' || period === '1w' ? 'Last 7 days'   :
        period === 'custom'                ? 'Custom period' : 'Last 30 days'
      const dateLabels = Array.from({ length: 6 }, (_, i) => {
        const t  = i / 5
        const dt = new Date(pStart.getTime() + t * (pEnd.getTime() - pStart.getTime()))
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      })

      htmlStr = buildFanfixHtml({
        revenueAmt: fmtUSD(net),
        periodLabel,
        dateLabels,
      })
      vpW = 1000; vpH = 611
    } else if (tpl === 'Fanvue') {
      // ── Fanvue: dark mobile Insights layout matching Fanvue.png ───────────
      const fmtEN = dt => dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      const periodLabel =
        period === '24h'                   ? 'Last 24 Hours' :
        period === '7d' || period === '1w' ? 'Last 7 Days'   :
        period === 'custom'                ? 'Custom Period' : 'Last 30 Days'

      // Period fraction: 30-day period = reference unit
      const fvPeriodFrac =
        period === '24h'                   ? 1/30 :
        (period === '7d' || period === '1w') ? 7/30 :
        period === 'custom'                ? Math.min(bars, 30) / 30 : 1
      // Period total (in summary rows) — coherent with period selected
      const fvTotal  = r2(net * (0.14 + rng0() * 0.04) * fvPeriodFrac)
      const fvSubs   = r2(fvTotal * (0.48 + rng0() * 0.10))
      const fvTDelta = '+$' + Math.round(fvTotal * (0.035 + rng0() * 0.03)).toLocaleString('en-US')
      const fvSDelta = '+' + (fvSubs * (0.08 + rng0() * 0.05)).toFixed(1)
      // "This month" shows monthly share of earnings (always full month basis)
      const fvMonthAmt = r2(net * (0.11 + rng0() * 0.04))

      htmlStr = buildFanvueHtml({
        earningsAmt: fmtFV(net),
        monthAmt:    fmtFV(fvMonthAmt),
        monthLabel:  pEnd.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
        periodLabel,
        dateRange:   `${fmtEN(pStart)} - ${fmtEN(pEnd)}`,
        totalAmt:    fmtFV(fvTotal),
        totalDelta:  fvTDelta,
        subsAmt:     fmtFV(fvSubs),
        subsDelta:   fvSDelta,
        bars,
      })
      vpW = 359; vpH = 764
    } else {
      // ── Reveal: dark "Creator earnings overview" layout matching Reveal.png ─
      const activeTab =
        period === '24h'                   ? 'Today'     :
        period === '7d' || period === '1w' ? 'This week' : 'This month'
      const labelCount = Math.min(bars, 8)
      const chartDates = Array.from({ length: labelCount }, (_, i) => {
        const t  = labelCount > 1 ? i / (labelCount - 1) : 0
        const dt = new Date(pStart.getTime() + t * (pEnd.getTime() - pStart.getTime()))
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      })

      // rvMax: Y-axis ceiling — peak of chart corresponds to displayGross/bars * peak_factor
      const rvDailyAvg = displayGross / Math.max(bars, 1)
      const rvMax = Math.round(roundToNice(rvDailyAvg * 3.5))

      // Sub-amounts — compute last one as exact remainder to avoid rounding drift
      const rvSubs = r2(displayGross * 0.1127)
      const rvTips = r2(displayGross * 0.0790)
      const rvMsgs = r2(r2(displayGross) - rvSubs - rvTips)  // exact remainder

      htmlStr = buildRevealHtml({
        totalAmt:     fmtUSD(displayGross),
        subsAmt:      fmtUSD(rvSubs),
        tipsAmt:      fmtUSD(rvTips),
        postsAmt:     fmtUSD(0),
        referralsAmt: fmtUSD(0),
        messagesAmt:  fmtUSD(rvMsgs),
        streamsAmt:   fmtUSD(0),
        chartMax:     rvMax,
        seed:         Math.round(displayGross * 1000),
        activeTab, chartDates, bars,
      })
      vpW = 870; vpH = 438
    }

    const pngBuf = await renderHtml(htmlStr, vpW, vpH)
    res.json({ image: `data:image/png;base64,${pngBuf.toString('base64')}` })
  } catch (err) {
    console.error('[dashboard/generate]', err)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => console.log(`ClimbClip server running on port ${PORT}`))