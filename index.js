const express = require("express")
const cors = require("cors")
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

ffmpeg.setFfmpegPath(ffmpegPath)

const app = express()
app.use(cors({ origin: "*", credentials: true }))
app.use(express.json({ limit: "100mb" }))

const PORT = process.env.PORT || 3001
const aai = new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY })
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "")
const supabase = SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } })
  : null

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
const GOOGLE_REDIRECT_URI = "https://climbclip-server.onrender.com/auth/google/callback"
const FRONTEND_URL = process.env.FRONTEND_URL || "https://climbclip.vercel.app"

const upload = multer({ dest: "/tmp/uploads/", limits: { fileSize: 2 * 1024 * 1024 * 1024 } })
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

app.get("/debug/drive-config", (req, res) => {
  const rawUrl = process.env.SUPABASE_URL || ""
  res.json({
    supabase_initialized: !!supabase,
    supabase_url_raw: rawUrl,
    supabase_url_used: SUPABASE_URL,
    google_client_id: !!GOOGLE_CLIENT_ID,
    google_client_secret: !!GOOGLE_CLIENT_SECRET,
    redirect_uri: GOOGLE_REDIRECT_URI,
    frontend_url: FRONTEND_URL,
  })
})

app.get("/debug/test-upsert", async (req, res) => {
  if (!supabase) return res.json({ ok: false, error: "supabase not initialized" })

  const results = {}

  // 1. Simple SELECT
  const { data: selectData, error: selectErr } = await supabase.from("google_tokens").select("*").limit(1)
  results.select = selectErr ? { ok: false, code: selectErr.code, error: selectErr.message } : { ok: true, rows: selectData?.length }

  // 2. Simple INSERT (no conflict handling)
  const { error: insertErr } = await supabase.from("google_tokens")
    .insert({ user_email: "debug-test@climbclip.io", refresh_token: "debug_token" })
  results.insert = insertErr ? { ok: false, code: insertErr.code, error: insertErr.message } : { ok: true }

  // 3. Upsert without onConflict
  const { error: upsertNoConflict } = await supabase.from("google_tokens")
    .upsert({ user_email: "debug-test2@climbclip.io", refresh_token: "debug_token" })
  results.upsert_no_conflict = upsertNoConflict ? { ok: false, code: upsertNoConflict.code, error: upsertNoConflict.message } : { ok: true }

  // 4. Upsert with onConflict
  const { error: upsertConflict } = await supabase.from("google_tokens")
    .upsert({ user_email: "debug-test@climbclip.io", refresh_token: "debug_token_2" }, { onConflict: "user_email" })
  results.upsert_with_conflict = upsertConflict ? { ok: false, code: upsertConflict.code, error: upsertConflict.message } : { ok: true }

  // cleanup
  await supabase.from("google_tokens").delete().in("user_email", ["debug-test@climbclip.io", "debug-test2@climbclip.io"])

  res.json(results)
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
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.flushHeaders()
  if (!sseClients[jobId]) sseClients[jobId] = []
  sseClients[jobId].push(res)
  if (jobs[jobId]) res.write(`data: ${JSON.stringify(jobs[jobId])}\n\n`)
  req.on("close", () => {
    sseClients[jobId] = (sseClients[jobId] || []).filter(r => r !== res)
    if (sseClients[jobId].length === 0) delete sseClients[jobId]
  })
})

app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Aucun fichier" })
  res.json({ path: req.file.path })
})

app.post("/download", async (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: "URL requise" })
  const outputPath = path.join("/tmp", `yt_${Date.now()}.mp4`)
  try {
    await execAsync(`yt-dlp --cookies /app/cookies.txt -f "best[ext=mp4]/best" -o "${outputPath}" "${url}"`)
    res.json({ path: outputPath })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post("/thumbnail", async (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: "URL requise" })
  try {
    const { stdout } = await execAsync(`yt-dlp --get-thumbnail "${url}"`)
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

app.post("/preview-timestamps", async (req, res) => {
  const { videoPaths, prompt, options } = req.body
  if (!videoPaths?.length) return res.status(400).json({ error: "Aucune vidéo" })
  try {
    const mainInput = videoPaths[0]
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

app.post("/prompt-help", async (req, res) => {
  const { description, refVideoFrames } = req.body
  try {
    const messages = [{ role: "user", content: refVideoFrames
      ? [...refVideoFrames.map(frame => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame } })), { type: "text", text: `Expert edits TikTok. Description: "${description}". Génère un prompt parfait. Uniquement le prompt.` }]
      : [{ type: "text", text: `Expert edits TikTok. L'utilisateur veut: "${description}". Génère un prompt parfait. Uniquement le prompt.` }]
    }]
    const response = await anthropic.messages.create({ model: "claude-sonnet-4-5", max_tokens: 500, messages })
    res.json({ prompt: response.content[0].type === "text" ? response.content[0].text : "" })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post("/analyze-video", async (req, res) => {
  const { videoPath } = req.body
  if (!videoPath) return res.status(400).json({ error: "videoPath requis" })
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

app.post("/generate", async (req, res) => {
  const { videoUrls, videoPaths, prompt, options, musicUrl, format, zoomIntensity, speedIntensity, addIntroOutro, customTimestamps, colorGrade, transition, textOverlay, textEffect, stabilize, vocalVolume, watermark, exportQuality, exportCodec, subtitleStyle, capsulesCount, isCapsule } = req.body
  if (!videoUrls?.length && !videoPaths?.length) return res.status(400).json({ error: "Aucune vidéo" })
  const jobId = `job_${Date.now()}`
  jobs[jobId] = { status: "processing", progress: 0, clips: null, error: null }
  res.json({ jobId })
  processVideo({ jobId, videoUrls, videoPaths, prompt, options, musicUrl, format, zoomIntensity, speedIntensity, addIntroOutro, customTimestamps, colorGrade, transition, textOverlay, textEffect, stabilize, vocalVolume, watermark, exportQuality, exportCodec, subtitleStyle, capsulesCount, isCapsule })
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
      // Force 720p for capsules — keeps ffmpeg buffers and output files small on 512MB Render
      const capsuleScale = "1280:720"
      const capsuleBitrate = 2000
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
              "-preset ultrafast",
              "-crf 28",
              `-vf ${formatFilter}`,
              "-map_metadata -1",
              `-b:v ${capsuleBitrate}k`,
              `-maxrate ${Math.floor(capsuleBitrate * 1.3)}k`,
              `-bufsize ${capsuleBitrate}k`,
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
      options?.includes("Beat sync") && musicPath ? detectBeats(musicPath) : Promise.resolve(null),
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
      const audioFilters = []

      if (atempoVal !== "1.0") {
        const speed = parseFloat(atempoVal)
        if (speed >= 0.5 && speed <= 2.0) audioFilters.push(`atempo=${speed}`)
        else if (speed > 2.0) { audioFilters.push("atempo=2.0"); audioFilters.push(`atempo=${(speed/2.0).toFixed(2)}`) }
        else if (speed < 0.5) { audioFilters.push("atempo=0.5"); audioFilters.push(`atempo=${(speed/0.5).toFixed(2)}`) }
      }
      const vocalVol = vocalVolume !== undefined ? vocalVolume : 0.3
      if (musicPath && vocalVol > 0) audioFilters.push(`volume=${vocalVol}`)

      await new Promise((resolve, reject) => {
        let cmd = ffmpeg(mainInput).setStartTime(clip.start).setDuration(clip.duration)
        const outputOpts = [
          "-movflags faststart", `-c:v ${codec}`, "-preset fast", `-crf ${crf}`, `-vf ${vfString}`,
          "-map_metadata -1",
          `-b:v ${Math.floor(bitrate+Math.random()*500)}k`,
          `-maxrate ${Math.floor(bitrate*1.4+Math.random()*500)}k`,
          `-bufsize ${bitrate*2}k`,
        ]
        if (musicPath && fs.existsSync(musicPath)) {
          cmd = cmd.input(musicPath)
          outputOpts.push("-c:a aac","-b:a 192k","-map 0:v:0","-map 1:a:0","-shortest")
          if (audioFilters.length > 0) outputOpts.push(`-af ${audioFilters.join(",")}`)
        } else {
          outputOpts.push("-c:a aac","-b:a 192k")
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

app.listen(PORT, () => console.log(`ClimbClip server running on port ${PORT}`))