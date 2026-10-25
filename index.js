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
const { exec } = require("child_process")
const { promisify } = require("util")
const execAsync = promisify(exec)

ffmpeg.setFfmpegPath(ffmpegPath)

const app = express()
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"] }))
app.use(express.json({ limit: "50mb" }))

const PORT = process.env.PORT || 3001
const aai = new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY })
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const upload = multer({ dest: "/tmp/uploads/", limits: { fileSize: 2 * 1024 * 1024 * 1024 } })
const jobs = {}

app.get("/health", (req, res) => res.json({ status: "ok" }))

app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Aucun fichier" })
  res.json({ path: req.file.path })
})

app.post("/check-file", (req, res) => {
  const { path: filePath } = req.body
  if (!filePath || filePath === "undefined") return res.json({ exists: false })
  res.json({ exists: fs.existsSync(filePath) })
})

app.post("/download", async (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: "URL requise" })
  const outputPath = path.join("/tmp", `yt_${Date.now()}.mp4`)
  try {
    await execAsync(`yt-dlp --cookies /app/cookies.txt -f "best[ext=mp4]/best" -o "${outputPath}" "${url}"`)
    res.json({ path: outputPath })
  } catch (err) {
    console.error("Erreur yt-dlp:", err.message)
    res.status(500).json({ error: err.message })
  }
})

app.post("/thumbnail", async (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: "URL requise" })
  try {
    const { stdout } = await execAsync(`yt-dlp --get-thumbnail "${url}"`)
    res.json({ thumbnail: stdout.trim() })
  } catch { res.json({ thumbnail: null }) }
})

app.post("/preview-timestamps", async (req, res) => {
  const { videoPaths, prompt, options } = req.body
  if (!videoPaths?.length) return res.status(400).json({ error: "Aucune vidéo" })
  try {
    const mainInput = videoPaths[0]
    const { stdout: durationStr } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${mainInput}"`)
    const totalDuration = parseFloat(durationStr.trim())
    const aiResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-5", max_tokens: 1000,
      messages: [{ role: "user", content: `Éditeur vidéo expert. Vidéo: ${Math.round(totalDuration)}s. Prompt: "${prompt || "edits dynamiques"}". Génère les timestamps. JSON brut sans backticks: [{"start":0,"duration":15,"name":"Edit #1","description":"Description courte"}]` }]
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

app.post("/generate", async (req, res) => {
  console.log("[generate] requête reçue — videoPaths:", req.body?.videoPaths, "videoUrls:", req.body?.videoUrls)
  const { videoUrls, videoPaths, prompt, options, musicUrl, format, zoomIntensity, speedIntensity, addIntroOutro, customTimestamps, colorGrade, transition, textOverlay, stabilize, vocalVolume, exportQuality, exportCodec, watermark, visualFilter } = req.body
  if (!videoUrls?.length && !videoPaths?.length) { console.log("[generate] ERREUR: aucune vidéo"); return res.status(400).json({ error: "Aucune vidéo" }) }
  const jobId = `job_${Date.now()}`
  jobs[jobId] = { status: "processing", progress: 0, clips: null, error: null }
  res.json({ jobId })
  processVideo({ jobId, videoUrls, videoPaths, prompt, options, musicUrl, format, zoomIntensity, speedIntensity, addIntroOutro, customTimestamps, colorGrade, transition, textOverlay, stabilize, vocalVolume, exportQuality, exportCodec, watermark, visualFilter })
})

app.get("/status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId]
  if (!job) return res.status(404).json({ error: "Job introuvable" })
  res.json(job)
})

// ─── HELPERS ───────────────────────────────────────────────────────────────

function getFormatFilter(format) {
  const formats = { "9:16": { w: 1080, h: 1920 }, "16:9": { w: 1920, h: 1080 }, "1:1": { w: 1080, h: 1080 }, "4:5": { w: 1080, h: 1350 } }
  const target = formats[format] || formats["9:16"]
  return `scale=${target.w}:${target.h}:force_original_aspect_ratio=decrease,pad=${target.w}:${target.h}:(ow-iw)/2:(oh-ih)/2:black`
}

function getExportResolution(quality, format) {
  const formats = { "9:16": { w: 1080, h: 1920 }, "16:9": { w: 1920, h: 1080 }, "1:1": { w: 1080, h: 1080 }, "4:5": { w: 1080, h: 1350 } }
  const base = formats[format] || formats["9:16"]
  const scales = { "720p": 0.667, "1080p": 1, "4K": 2 }
  const scale = scales[quality] || 1
  return { w: Math.round(base.w * scale / 2) * 2, h: Math.round(base.h * scale / 2) * 2 }
}

function getColorGradeFilter(grade) {
  const grades = {
    "cinematic": "curves=r='0/0 0.2/0.15 0.8/0.9 1/1':g='0/0 0.2/0.18 0.8/0.85 1/1':b='0/0.05 0.5/0.55 1/0.95',eq=saturation=1.2:contrast=1.1",
    "orange_teal": "colorchannelmixer=rr=1.1:rb=-0.05:gr=-0.05:gg=0.95:gb=0.1:br=-0.1:bg=0.1:bb=1.15,eq=saturation=1.3",
    "bw": "hue=s=0,eq=contrast=1.3:brightness=0.05",
    "vibrant": "eq=saturation=1.6:contrast=1.05:brightness=0.02",
    "moody": "curves=r='0/0 0.3/0.25 0.7/0.65 1/0.9':g='0/0 0.3/0.27 0.7/0.67 1/0.92':b='0/0.05 0.3/0.32 0.7/0.72 1/1',eq=saturation=0.9:contrast=1.15",
    "warm": "curves=r='0/0.05 0.5/0.58 1/1':g='0/0 0.5/0.5 1/0.95':b='0/0 0.5/0.44 1/0.88',eq=saturation=1.1",
    "cold": "curves=r='0/0 0.5/0.44 1/0.9':g='0/0 0.5/0.5 1/0.97':b='0/0.04 0.5/0.56 1/1',eq=saturation=1.05",
  }
  return grades[grade] || null
}

function getVisualFilterFFmpeg(filter) {
  const filters = {
    "clarendon": "eq=saturation=1.35:contrast=1.2:brightness=0.08",
    "gingham":   "eq=brightness=0.05:saturation=0.9:contrast=0.95,hue=h=-10",
    "juno":      "eq=saturation=1.4:contrast=1.1:brightness=0.05,hue=h=5",
    "lark":      "eq=contrast=0.9:brightness=0.12:saturation=0.85",
    "ludwig":    "eq=saturation=1.05:contrast=1.08:brightness=0.06,curves=r='0/0.03 1/0.97':b='0/0 1/0.92'",
    "moon":      "hue=s=0,eq=contrast=1.18:brightness=0.08",
    "reyes":     "curves=r='0/0.04 1/0.96':g='0/0.02 1/0.94':b='0/0 1/0.88',eq=brightness=0.1:contrast=0.85:saturation=0.75",
    "valencia":  "curves=r='0/0.02 1/0.98':b='0/0 1/0.9',eq=contrast=1.08:brightness=0.04:saturation=1.1",
    "chaud":    "curves=r='0/0.06 0.5/0.6 1/1':g='0/0 0.5/0.5 1/0.94':b='0/0 0.5/0.42 1/0.85',eq=saturation=1.15:brightness=0.02",
    "froid":    "curves=r='0/0 0.5/0.42 1/0.88':g='0/0 0.5/0.5 1/0.97':b='0/0.05 0.5/0.58 1/1',eq=saturation=1.08",
    "contraste":"eq=contrast=1.25:brightness=-0.02:saturation=1.1,unsharp=3:3:0.6:3:3:0.4",
    "doux":     "gblur=sigma=0.6,eq=saturation=0.88:brightness=0.03:contrast=0.95",
    "vintage":  "curves=r='0/0.05 0.5/0.52 1/0.92':g='0/0.02 0.5/0.48 1/0.88':b='0/0.04 0.5/0.46 1/0.80',eq=saturation=0.72:contrast=1.08,vignette=PI/4",
    "cinema":   "curves=r='0/0 0.2/0.14 0.8/0.88 1/1':g='0/0 0.2/0.16 0.8/0.84 1/1':b='0/0.04 0.5/0.54 1/0.94',eq=saturation=1.18:contrast=1.12,vignette=PI/6",
    "neon":     "eq=saturation=1.8:contrast=1.15:brightness=0.04,colorchannelmixer=rr=1.05:gg=0.95:bb=1.1",
  }
  return filters[filter] || null
}

function getNativeMetadata() {
  const devices = [
    { make: "Apple", model: "iPhone 15 Pro", software: "17.0" },
    { make: "Apple", model: "iPhone 14", software: "16.6" },
    { make: "Samsung", model: "Galaxy S23", software: "13" },
    { make: "Samsung", model: "Galaxy S22 Ultra", software: "12" },
    { make: "Google", model: "Pixel 8 Pro", software: "14" },
  ]
  const device = devices[Math.floor(Math.random() * devices.length)]
  const now = new Date()
  now.setDate(now.getDate() - Math.floor(Math.random() * 30))
  now.setHours(Math.floor(Math.random() * 14) + 8)
  now.setMinutes(Math.floor(Math.random() * 60))
  return { ...device, date: now.toISOString().replace(/\.\d{3}Z$/, "").replace("T", " ") }
}

async function detectSceneCuts(inputPath) {
  try {
    const { stdout } = await execAsync(`ffprobe -v quiet -show_frames -select_streams v -skip_frame noref -show_entries frame=pkt_pts_time,pict_type -of csv "${inputPath}" 2>/dev/null | grep ",I" | head -50`)
    return stdout.trim().split("\n").map(line => parseFloat(line.split(",")[0])).filter(t => !isNaN(t))
  } catch { return [] }
}

async function analyzeBPM(musicPath) {
  try {
    const { stdout } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${musicPath}"`)
    const duration = parseFloat(stdout.trim())
    const estimatedBPM = 120
    const beatInterval = 60 / estimatedBPM
    const beats = []
    for (let t = 0; t < duration; t += beatInterval) beats.push(parseFloat(t.toFixed(3)))
    return { bpm: estimatedBPM, beats }
  } catch { return { bpm: 120, beats: [] } }
}

function buildTransitionFilter(transition, clipDuration) {
  if (!transition || transition === "none") return null
  const transitions = {
    "flash": `fade=t=in:st=0:d=0.08:color=white,fade=t=out:st=${(clipDuration - 0.08).toFixed(2)}:d=0.08:color=white`,
    "fade": `fade=t=in:st=0:d=0.2,fade=t=out:st=${(clipDuration - 0.2).toFixed(2)}:d=0.2`,
    "glitch": `rgbashift=rh=3:rv=-3:gh=0:gv=0:bh=-3:bv=3`,
    "zoom_in": `zoompan=z='min(zoom+0.002,1.1)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
  }
  return transitions[transition] || null
}

function buildTextOverlayFilter(text, clipDuration, format) {
  if (!text) return null
  const formats = { "9:16": { w: 1080, h: 1920 }, "16:9": { w: 1920, h: 1080 }, "1:1": { w: 1080, h: 1080 }, "4:5": { w: 1080, h: 1350 } }
  const target = formats[format] || formats["9:16"]
  const fontSize = Math.floor(target.w * 0.07)
  const escapedText = text.replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/\[/g, "\\[").replace(/\]/g, "\\]")
  return `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:alpha='if(lt(t,0.3),t/0.3,if(gt(t,${(clipDuration - 0.3).toFixed(2)}),(${clipDuration.toFixed(2)}-t)/0.3,1))':shadowcolor=black:shadowx=2:shadowy=2`
}

function buildWatermarkFilter(clipDuration, format) {
  const formats = { "9:16": { w: 1080, h: 1920 }, "16:9": { w: 1920, h: 1080 }, "1:1": { w: 1080, h: 1080 }, "4:5": { w: 1080, h: 1350 } }
  const target = formats[format] || formats["9:16"]
  const fontSize = Math.floor(target.w * 0.045)
  return `drawtext=text='CLIMB':fontsize=${fontSize}:fontcolor=white:alpha=0.35:x=w-text_w-20:y=20:shadowcolor=black:shadowx=1:shadowy=1`
}

function buildIntroOutroFilter(clipDuration, format) {
  const formats = { "9:16": { w: 1080, h: 1920 }, "16:9": { w: 1920, h: 1080 }, "1:1": { w: 1080, h: 1080 }, "4:5": { w: 1080, h: 1350 } }
  const target = formats[format] || formats["9:16"]
  const fontSize = Math.floor(target.w * 0.11)
  const introAlpha = `if(lt(t,1.2),t/1.2,if(lt(t,2.4),1,0))`
  const outroAlpha = `if(gt(t,${(clipDuration - 1.5).toFixed(2)}),(t-${(clipDuration - 1.5).toFixed(2)})/1.5,0)`
  return [
    `drawtext=text='CLIMB':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:alpha='${introAlpha}'`,
    `drawtext=text='CLIMB':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:alpha='${outroAlpha}'`
  ].join(",")
}

async function analyzeEffects(prompt, totalDuration, options, zoomIntensity, speedIntensity) {
  const needsZoom = options?.includes("Auto-zoom")
  const needsSpeedRamp = options?.includes("Speed ramp")
  if (!needsZoom && !needsSpeedRamp) return null
  const zoomMax = zoomIntensity ? 1 + (zoomIntensity / 100) * 0.3 : 1.15
  const speedMax = speedIntensity ? 1 + (speedIntensity / 100) * 2 : 2.0
  const speedMin = speedIntensity ? Math.max(0.3, 1 - (speedIntensity / 100) * 0.7) : 0.6
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5", max_tokens: 600,
      messages: [{ role: "user", content: `Expert montage TikTok. Prompt: "${prompt || "edit dynamique"}". Vidéo: ${Math.round(totalDuration)}s. Zoom max: ${zoomMax.toFixed(2)}, Speed max: ${speedMax.toFixed(2)}, min: ${speedMin.toFixed(2)}. JSON brut: {"autozoom":{"enabled":${needsZoom},"intensity":${zoomMax.toFixed(2)}},"speedramp":{"enabled":${needsSpeedRamp},"segments":[{"start_pct":0,"end_pct":0.3,"speed":1.5},{"start_pct":0.3,"end_pct":0.65,"speed":0.7},{"start_pct":0.65,"end_pct":1.0,"speed":1.8}]}}` }]
    })
    const text = response.content[0].type === "text" ? response.content[0].text : ""
    return JSON.parse(text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim())
  } catch {
    return { autozoom: { enabled: needsZoom, intensity: zoomMax }, speedramp: { enabled: needsSpeedRamp, segments: [{ start_pct: 0, end_pct: 0.5, speed: 1.5 }, { start_pct: 0.5, end_pct: 1.0, speed: 0.8 }] } }
  }
}

// ─── MAIN PROCESS ──────────────────────────────────────────────────────────

async function processVideo({ jobId, videoUrls, videoPaths, prompt, options, musicUrl, format, zoomIntensity, speedIntensity, addIntroOutro, customTimestamps, colorGrade, transition, textOverlay, stabilize, vocalVolume, exportQuality, exportCodec, watermark, visualFilter }) {
  const tmpDir = "/tmp"
  const inputPaths = []
  const clips = []

  try {
    jobs[jobId] = { status: "processing", progress: 5 }

    for (let i = 0; i < (videoUrls || []).length; i++) {
      const url = videoUrls[i]
      const inputPath = path.join(tmpDir, `input_${Date.now()}_${i}.mp4`)
      const response = await axios({ url, method: "GET", responseType: "stream" })
      const writer = fs.createWriteStream(inputPath)
      response.data.pipe(writer)
      await new Promise((resolve, reject) => { writer.on("finish", resolve); writer.on("error", reject) })
      inputPaths.push(inputPath)
    }
    for (const p of (videoPaths || [])) {
      if (!p || p === "undefined") { jobs[jobId].error = "Vidéo introuvable — réimporte le fichier"; throw new Error("invalid path: " + p) }
      if (fs.existsSync(p)) inputPaths.push(p)
      else { jobs[jobId].error = "Fichier vidéo perdu (serveur redémarré) — réimporte le fichier"; throw new Error("file not found: " + p) }
    }
    if (inputPaths.length === 0) { jobs[jobId].error = "Aucun fichier vidéo valide"; throw new Error("no valid input") }

    jobs[jobId].progress = 20

    let mainInput = inputPaths[0]
    if (inputPaths.length > 1) {
      const listPath = path.join(tmpDir, `list_${Date.now()}.txt`)
      const concatPath = path.join(tmpDir, `concat_${Date.now()}.mp4`)
      fs.writeFileSync(listPath, inputPaths.map(p => `file '${p}'`).join("\n"))
      await new Promise((resolve, reject) => {
        ffmpeg().input(listPath).inputOptions(["-f", "concat", "-safe", "0"]).outputOptions(["-c copy"]).output(concatPath)
          .on("end", resolve).on("error", reject).run()
      })
      mainInput = concatPath
      fs.unlinkSync(listPath)
    }

    jobs[jobId].progress = 25

    // Stabilization
    if (stabilize) {
      try {
        const stabPath = path.join(tmpDir, `stab_${Date.now()}.mp4`)
        const transformsPath = path.join(tmpDir, `transforms_${Date.now()}.trf`)
        await new Promise((resolve, reject) => {
          ffmpeg(mainInput).outputOptions([`-vf vidstabdetect=stepsize=6:shakiness=8:accuracy=9:result=${transformsPath}`, "-f null"]).output("/dev/null").on("end", resolve).on("error", reject).run()
        })
        await new Promise((resolve, reject) => {
          ffmpeg(mainInput).outputOptions([`-vf vidstabtransform=input=${transformsPath}:zoom=1:smoothing=15,unsharp=5:5:0.8:3:3:0.4`, "-c:v libx264", "-c:a copy"]).output(stabPath).on("end", resolve).on("error", reject).run()
        })
        if (fs.existsSync(stabPath)) mainInput = stabPath
        if (fs.existsSync(transformsPath)) fs.unlinkSync(transformsPath)
      } catch (e) { console.error("Stab failed:", e.message) }
    }

    jobs[jobId].progress = 30

    let musicPath = null
    if (musicUrl) {
      try {
        musicPath = path.join(tmpDir, `music_${Date.now()}.mp3`)
        const musicResponse = await axios({ url: musicUrl, method: "GET", responseType: "stream" })
        const musicWriter = fs.createWriteStream(musicPath)
        musicResponse.data.pipe(musicWriter)
        await new Promise((resolve, reject) => { musicWriter.on("finish", resolve); musicWriter.on("error", reject) })
      } catch { musicPath = null }
    }

    let beatData = null
    if (options?.includes("Beat sync") && musicPath) beatData = await analyzeBPM(musicPath)

    let subtitles = []
    if (options?.includes("Sous-titres")) {
      try {
        const transcript = await aai.transcripts.transcribe({ audio: mainInput, language_detection: true })
        if (transcript.words) subtitles = transcript.words.map(w => ({ text: w.text, start: w.start / 1000, end: w.end / 1000 }))
      } catch (e) { console.error("Transcription:", e.message) }
    }

    jobs[jobId].progress = 38

    const { stdout: durationStr } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${mainInput}"`)
    const totalDuration = parseFloat(durationStr.trim())
    const sceneCuts = await detectSceneCuts(mainInput)
    const effects = await analyzeEffects(prompt, totalDuration, options, zoomIntensity, speedIntensity)

    jobs[jobId].progress = 45

    let durations = customTimestamps?.length > 0 ? customTimestamps : null
    if (!durations) {
      try {
        const beatContext = beatData?.beats?.length > 0 ? `Beats à: ${beatData.beats.slice(0, 16).join(", ")}s.` : ""
        const sceneContext = sceneCuts.length > 0 ? `Scènes à: ${sceneCuts.slice(0, 10).map(t => t.toFixed(1)).join(", ")}s.` : ""
        const aiResponse = await anthropic.messages.create({
          model: "claude-sonnet-4-5", max_tokens: 1000,
          messages: [
            { role: "user", content: `Tu es un éditeur vidéo. Vidéo: ${Math.round(totalDuration)}s. Prompt: "${prompt || "edits dynamiques"}". ${beatContext} ${sceneContext} Réponds UNIQUEMENT avec un tableau JSON valide, rien d'autre. Règles: start+duration<=${Math.round(totalDuration)}, durées 10-30s.` },
            { role: "assistant", content: "[" }
          ]
        })
        const aiText = aiResponse.content[0].type === "text" ? aiResponse.content[0].text : ""
        const cleanedAiText = ("[" + aiText).replace(/```json\n?/g, "").replace(/```\n?/g, "").replace(/^#[^\n]*\n?/gm, "").replace(/^\[+/, "[").trim()
        const parsed = JSON.parse(cleanedAiText)
        if (Array.isArray(parsed) && parsed.length > 0) {
          durations = parsed.map((d, i) => ({ start: Math.max(0, Math.min(d.start, totalDuration - (d.duration || 15))), duration: Math.min(d.duration || 15, totalDuration), name: d.name || `Edit #${i + 1}` }))
        }
      } catch (e) { console.error("Erreur IA clips:", e.message) }
    }
    if (!durations) durations = [{ start: 0, duration: 15, name: "Edit #1" }, { start: 10, duration: 20, name: "Edit #2" }, { start: 25, duration: 15, name: "Edit #3" }]

    jobs[jobId].progress = 48

    const targetFormat = format || "9:16"
    const resolution = getExportResolution(exportQuality || "1080p", targetFormat)
    const metadata = getNativeMetadata()

    // Codec settings
    const codecMap = { "h264": "libx264", "h265": "libx265", "vp9": "libvpx-vp9" }
    const videoCodec = codecMap[exportCodec] || "libx264"
    const qualityCrf = { "720p": "26", "1080p": "22", "4K": "18" }[exportQuality || "1080p"] || "22"

    for (let ci = 0; ci < durations.length; ci++) {
      const clip = durations[ci]
      const outputPath = path.join(tmpDir, `clip_${ci}_${Date.now()}.mp4`)
      const srtPath = path.join(tmpDir, `clip_${ci}_${Date.now()}.srt`)

      let hasSrt = false
      if (subtitles.length > 0) {
        const clipSubs = subtitles.filter(s => s.start >= clip.start && s.start < clip.start + clip.duration)
        if (clipSubs.length > 0) {
          const toSrtTime = t => { const h = Math.floor(t / 3600).toString().padStart(2, "0"); const m = Math.floor((t % 3600) / 60).toString().padStart(2, "0"); const s2 = Math.floor(t % 60).toString().padStart(2, "0"); const ms = Math.floor((t % 1) * 1000).toString().padStart(3, "0"); return `${h}:${m}:${s2},${ms}` }
          let srtContent = ""
          clipSubs.forEach((s, i) => { srtContent += `${i + 1}\n${toSrtTime(s.start - clip.start)} --> ${toSrtTime(s.end - clip.start)}\n${s.text}\n\n` })
          fs.writeFileSync(srtPath, srtContent)
          hasSrt = true
        }
      }

      const vfFilters = []

      // Speed ramp
      let atempoVal = "1.0"
      if (effects?.speedramp?.enabled && effects.speedramp.segments?.length > 0) {
        const avgSpeed = effects.speedramp.segments.reduce((s, seg) => s + seg.speed, 0) / effects.speedramp.segments.length
        const clampedSpeed = Math.max(0.5, Math.min(2.0, avgSpeed))
        vfFilters.push(`setpts=${(1 / clampedSpeed).toFixed(3)}*PTS`)
        atempoVal = clampedSpeed.toFixed(2)
      }

      // Format + resolution
      vfFilters.push(`scale=${resolution.w}:${resolution.h}:force_original_aspect_ratio=decrease,pad=${resolution.w}:${resolution.h}:(ow-iw)/2:(oh-ih)/2:black`)

      // Auto-zoom
      if (effects?.autozoom?.enabled) {
        const intensity = Math.min(effects.autozoom.intensity || 1.15, 1.3)
        vfFilters.push(`scale=iw*${intensity.toFixed(3)}:ih*${intensity.toFixed(3)},crop=iw/${intensity.toFixed(3)}:ih/${intensity.toFixed(3)}`)
      }

      // Color grade
      const gradeFilter = getColorGradeFilter(colorGrade)
      if (gradeFilter) vfFilters.push(gradeFilter)

      // Visual filter (Instagram-like presets)
      const vFilter = getVisualFilterFFmpeg(visualFilter)
      if (vFilter) vfFilters.push(vFilter)

      // Film grain + vignette désactivés (trop lourds en mémoire sur Render 512MB)

      // Transition
      const transFilter = buildTransitionFilter(transition, clip.duration)
      if (transFilter) vfFilters.push(transFilter)

      // Text overlay
      const textFilter = buildTextOverlayFilter(textOverlay, clip.duration, targetFormat)
      if (textFilter) vfFilters.push(textFilter)

      // Intro/Outro
      if (addIntroOutro) vfFilters.push(buildIntroOutroFilter(clip.duration, targetFormat))

      // Watermark
      if (watermark) vfFilters.push(buildWatermarkFilter(clip.duration, targetFormat))

      // Subtitles
      if (hasSrt) vfFilters.push(`subtitles=${srtPath}:force_style='FontSize=16,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2,Alignment=2'`)

      const vfString = vfFilters.join(",")

      // Audio filters
      const audioFilters = []
      if (atempoVal !== "1.0") {
        const speed = parseFloat(atempoVal)
        if (speed >= 0.5 && speed <= 2.0) audioFilters.push(`atempo=${speed}`)
        else if (speed > 2.0) { audioFilters.push("atempo=2.0"); audioFilters.push(`atempo=${(speed / 2.0).toFixed(2)}`) }
        else if (speed < 0.5) { audioFilters.push("atempo=0.5"); audioFilters.push(`atempo=${(speed / 0.5).toFixed(2)}`) }
      }
      const vocalVol = vocalVolume !== undefined ? vocalVolume : 0.3
      if (musicPath && vocalVol > 0) audioFilters.push(`volume=${vocalVol}`)

      await new Promise((resolve, reject) => {
        let cmd = ffmpeg(mainInput).setStartTime(clip.start).setDuration(clip.duration)

        const outputOpts = [
          "-movflags faststart",
          `-c:v ${videoCodec}`,
          "-preset ultrafast",
          `-crf ${qualityCrf}`,
          `-vf ${vfString}`,
          "-map_metadata -1",
          `-b:v ${Math.floor(2500 + Math.random() * 500)}k`,
          `-maxrate ${Math.floor(3500 + Math.random() * 500)}k`,
          `-bufsize 4000k`,
        ]

        if (musicPath && fs.existsSync(musicPath)) {
          cmd = cmd.input(musicPath)
          outputOpts.push("-c:a aac", "-b:a 192k", "-map 0:v:0", "-map 1:a:0", "-shortest")
          if (audioFilters.length > 0) outputOpts.push(`-af ${audioFilters.join(",")}`)
        } else {
          outputOpts.push("-c:a aac", "-b:a 192k")
          if (audioFilters.length > 0) outputOpts.push(`-af ${audioFilters.join(",")}`)
        }

        cmd.outputOptions(outputOpts).output(outputPath)
          .on("end", () => { if (hasSrt && fs.existsSync(srtPath)) fs.unlinkSync(srtPath); resolve() })
          .on("error", (err, stdout, stderr) => {
            console.error("FFmpeg err:", stderr?.slice(-500))
            if (hasSrt && fs.existsSync(srtPath)) try { fs.unlinkSync(srtPath) } catch {}
            reject(err)
          })
          .run()
      })

      const thumbPath = path.join(tmpDir, `thumb_${ci}_${Date.now()}.jpg`)
      try { await execAsync(`ffmpeg -i "${outputPath}" -ss 0.5 -vframes 1 -q:v 2 "${thumbPath}" -y 2>/dev/null`) } catch {}

      const fileBuffer = fs.readFileSync(outputPath)
      const base64 = fileBuffer.toString("base64")
      let thumbBase64 = null
      if (fs.existsSync(thumbPath)) { thumbBase64 = `data:image/jpeg;base64,${fs.readFileSync(thumbPath).toString("base64")}`; fs.unlinkSync(thumbPath) }

      clips.push({ name: clip.name || `Edit #${ci + 1}`, base64: `data:video/mp4;base64,${base64}`, duration: clip.duration, thumbnail: thumbBase64 })
      fs.unlinkSync(outputPath)
      jobs[jobId].progress = 48 + Math.floor((ci + 1) / durations.length * 52)
    }

    if (musicPath && fs.existsSync(musicPath)) fs.unlinkSync(musicPath)
    for (const p of inputPaths) { if (fs.existsSync(p)) try { fs.unlinkSync(p) } catch {} }

    jobs[jobId] = { status: "done", progress: 100, clips }

  } catch (err) {
    console.error(err)
    for (const p of inputPaths) { if (fs.existsSync(p)) try { fs.unlinkSync(p) } catch {} }
    jobs[jobId] = { status: "error", progress: 0, error: err.message }
  }
}

app.listen(PORT, () => console.log(`ClimbClip server running on port ${PORT}`))
// cache bust Sun Oct 25 00:54:07 CEST 2026
