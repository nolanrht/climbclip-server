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
app.use(cors())
app.use(express.json())

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
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: `Tu es un éditeur vidéo expert. La vidéo fait ${Math.round(totalDuration)}s. Prompt: "${prompt || "edits dynamiques"}". Génère les timestamps. Réponds UNIQUEMENT JSON brut sans backticks: [{"start":0,"duration":15,"name":"Edit #1","description":"Description courte du moment"}]`
      }]
    })
    const text = aiResponse.content[0].type === "text" ? aiResponse.content[0].text : "[]"
    const parsed = JSON.parse(text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim())
    res.json({ timestamps: parsed, totalDuration })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post("/prompt-help", async (req, res) => {
  const { description, refVideoFrames } = req.body
  try {
    const messages = [{
      role: "user",
      content: refVideoFrames ? [
        ...refVideoFrames.map(frame => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame } })),
        { type: "text", text: `Tu es un expert en edits TikTok foot/sport. Description: "${description}". Génère un prompt parfait. Réponds uniquement avec le prompt.` }
      ] : [{ type: "text", text: `Tu es un expert en edits TikTok foot/sport. L'utilisateur veut: "${description}". Génère un prompt parfait. Réponds uniquement avec le prompt.` }]
    }]
    const response = await anthropic.messages.create({ model: "claude-sonnet-4-5", max_tokens: 500, messages })
    res.json({ prompt: response.content[0].type === "text" ? response.content[0].text : "" })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post("/generate", async (req, res) => {
  const { videoUrls, videoPaths, prompt, options, musicUrl, format, zoomIntensity, speedIntensity, addIntroOutro, customTimestamps } = req.body
  if (!videoUrls?.length && !videoPaths?.length) return res.status(400).json({ error: "Aucune vidéo" })
  const jobId = `job_${Date.now()}`
  jobs[jobId] = { status: "processing", progress: 0, clips: null, error: null }
  res.json({ jobId })
  processVideo({ jobId, videoUrls, videoPaths, prompt, options, musicUrl, format, zoomIntensity, speedIntensity, addIntroOutro, customTimestamps })
})

app.get("/status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId]
  if (!job) return res.status(404).json({ error: "Job introuvable" })
  res.json(job)
})

function getFormatFilter(format, inputW, inputH) {
  const formats = {
    "9:16": { w: 1080, h: 1920 },
    "16:9": { w: 1920, h: 1080 },
    "1:1": { w: 1080, h: 1080 },
    "4:5": { w: 1080, h: 1350 },
  }
  const target = formats[format] || formats["9:16"]
  // Scale to fit inside target, then pad with black bars
  return `scale=${target.w}:${target.h}:force_original_aspect_ratio=decrease,pad=${target.w}:${target.h}:(ow-iw)/2:(oh-ih)/2:black`
}

function buildLogoFilter(addIntroOutro, clipDuration, format) {
  if (!addIntroOutro) return null
  const formats = { "9:16": { w: 1080, h: 1920 }, "16:9": { w: 1920, h: 1080 }, "1:1": { w: 1080, h: 1080 }, "4:5": { w: 1080, h: 1350 } }
  const target = formats[format] || formats["9:16"]
  const cx = target.w / 2
  const cy = target.h / 2
  // Intro: 1.5s logo fade in, Outro: 1.5s logo fade in at end
  const introFilter = `drawtext=text='CLIMB':fontsize=${Math.floor(target.w * 0.12)}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:alpha='if(lt(t,1.5),t/1.5,0)':fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf`
  const outroFilter = `drawtext=text='CLIMB':fontsize=${Math.floor(target.w * 0.12)}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:alpha='if(gt(t,${clipDuration - 1.5}),(t-(${clipDuration - 1.5}))/1.5,0)':fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf`
  return `${introFilter},${outroFilter}`
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
      model: "claude-sonnet-4-5",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: `Expert montage vidéo TikTok. Prompt: "${prompt || "edit dynamique"}". Vidéo: ${Math.round(totalDuration)}s. Options: ${options?.join(", ")}.
Zoom max autorisé: ${zoomMax.toFixed(2)}. Speed max: ${speedMax.toFixed(2)}, Speed min: ${speedMin.toFixed(2)}.
Réponds UNIQUEMENT JSON brut:
{
  "autozoom": {"enabled": ${needsZoom}, "intensity": ${zoomMax.toFixed(2)}},
  "speedramp": {"enabled": ${needsSpeedRamp}, "segments": [
    {"start_pct": 0, "end_pct": 0.25, "speed": 1.5},
    {"start_pct": 0.25, "end_pct": 0.6, "speed": 0.7},
    {"start_pct": 0.6, "end_pct": 1.0, "speed": 1.8}
  ]}
}`
      }]
    })
    const text = response.content[0].type === "text" ? response.content[0].text : ""
    return JSON.parse(text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim())
  } catch (e) {
    console.error("Erreur effets:", e.message)
    return {
      autozoom: { enabled: needsZoom, intensity: zoomMax },
      speedramp: { enabled: needsSpeedRamp, segments: [{ start_pct: 0, end_pct: 0.5, speed: 1.5 }, { start_pct: 0.5, end_pct: 1.0, speed: 0.8 }] }
    }
  }
}

async function processVideo({ jobId, videoUrls, videoPaths, prompt, options, musicUrl, format, zoomIntensity, speedIntensity, addIntroOutro, customTimestamps }) {
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
      jobs[jobId].progress = 10 + Math.floor((i + 1) / videoUrls.length * 15)
    }

    for (const p of (videoPaths || [])) { if (fs.existsSync(p)) inputPaths.push(p) }

    jobs[jobId].progress = 25

    let mainInput = inputPaths[0]
    if (inputPaths.length > 1) {
      const listPath = path.join(tmpDir, `list_${Date.now()}.txt`)
      const concatPath = path.join(tmpDir, `concat_${Date.now()}.mp4`)
      fs.writeFileSync(listPath, inputPaths.map(p => `file '${p}'`).join("\n"))
      await new Promise((resolve, reject) => {
        ffmpeg().input(listPath).inputOptions(["-f", "concat", "-safe", "0"]).outputOptions(["-c copy"]).output(concatPath)
          .on("end", () => resolve()).on("error", reject).run()
      })
      mainInput = concatPath
      fs.unlinkSync(listPath)
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
      } catch (e) { musicPath = null }
    }

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

    // Probe video dimensions
    const { stdout: probeOut } = await execAsync(`ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${mainInput}"`)
    const [inputW, inputH] = probeOut.trim().split(",").map(Number)

    const effects = await analyzeEffects(prompt, totalDuration, options, zoomIntensity, speedIntensity)
    jobs[jobId].progress = 43

    let durations = customTimestamps?.length > 0 ? customTimestamps : null

    if (!durations) {
      try {
        const aiResponse = await anthropic.messages.create({
          model: "claude-sonnet-4-5",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: `Éditeur vidéo expert TikTok/sport. Vidéo: ${Math.round(totalDuration)}s. Prompt: "${prompt || "edits dynamiques"}". Génère les clips. JSON brut sans backticks: [{"start":0,"duration":15,"name":"Edit #1"}]. Règles: start+duration<=${Math.round(totalDuration)}, durées 10-30s, si "1 clip" = 1 seul objet.`
          }]
        })
        const aiText = aiResponse.content[0].type === "text" ? aiResponse.content[0].text : ""
        const parsed = JSON.parse(aiText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim())
        if (Array.isArray(parsed) && parsed.length > 0) {
          durations = parsed.map((d, i) => ({
            start: Math.max(0, Math.min(d.start, totalDuration - (d.duration || 15))),
            duration: Math.min(d.duration || 15, totalDuration),
            name: d.name || `Edit #${i + 1}`
          }))
        }
      } catch (e) { console.error("Erreur IA clips:", e.message) }
    }

    if (!durations) durations = [{ start: 0, duration: 15, name: "Edit #1" }, { start: 10, duration: 20, name: "Edit #2" }, { start: 25, duration: 15, name: "Edit #3" }]

    jobs[jobId].progress = 48

    const targetFormat = format || "9:16"
    const formatFilter = getFormatFilter(targetFormat, inputW, inputH)

    for (let ci = 0; ci < durations.length; ci++) {
      const clip = durations[ci]
      const outputPath = path.join(tmpDir, `clip_${ci}_${Date.now()}.mp4`)
      const srtPath = path.join(tmpDir, `clip_${ci}_${Date.now()}.srt`)

      let hasSrt = false
      if (subtitles.length > 0) {
        const clipSubs = subtitles.filter(s => s.start >= clip.start && s.start < clip.start + clip.duration)
        if (clipSubs.length > 0) {
          const toSrtTime = t => {
            const h = Math.floor(t / 3600).toString().padStart(2, "0")
            const m = Math.floor((t % 3600) / 60).toString().padStart(2, "0")
            const s2 = Math.floor(t % 60).toString().padStart(2, "0")
            const ms = Math.floor((t % 1) * 1000).toString().padStart(3, "0")
            return `${h}:${m}:${s2},${ms}`
          }
          let srtContent = ""
          clipSubs.forEach((s, i) => { srtContent += `${i + 1}\n${toSrtTime(s.start - clip.start)} --> ${toSrtTime(s.end - clip.start)}\n${s.text}\n\n` })
          fs.writeFileSync(srtPath, srtContent)
          hasSrt = true
        }
      }

      // Build vf filter chain
      const vfFilters = []

      // 1. Format/letterbox
      vfFilters.push(formatFilter)

      // 2. Auto-zoom
      if (effects?.autozoom?.enabled) {
        const intensity = effects.autozoom.intensity || 1.15
        vfFilters.push(`scale=iw*${intensity.toFixed(3)}:ih*${intensity.toFixed(3)},crop=iw/${intensity.toFixed(3)}:ih/${intensity.toFixed(3)}`)
      }

      // 3. Sous-titres
      if (hasSrt) {
        vfFilters.push(`subtitles=${srtPath}:force_style='FontSize=16,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2,Alignment=2'`)
      }

      // 4. Logo intro/outro
      if (addIntroOutro) {
        const logoFilter = buildLogoFilter(true, clip.duration, targetFormat)
        if (logoFilter) vfFilters.push(logoFilter)
      }

      const vfString = vfFilters.join(",")

      // Speed ramp via setpts
      let atempo = ""
      let setptsFilter = ""
      if (effects?.speedramp?.enabled && effects.speedramp.segments?.length > 0) {
        const segs = effects.speedramp.segments
        const avgSpeed = segs.reduce((sum, s) => sum + s.speed, 0) / segs.length
        const clampedSpeed = Math.max(0.5, Math.min(2.0, avgSpeed))
        setptsFilter = `setpts=${(1 / clampedSpeed).toFixed(3)}*PTS`
        atempo = clampedSpeed.toFixed(2)
      }

      await new Promise((resolve, reject) => {
        let cmd = ffmpeg(mainInput)
          .setStartTime(clip.start)
          .setDuration(clip.duration)

        const outputOpts = ["-movflags faststart", "-c:v libx264", "-preset fast", "-crf 23"]

        const fullVf = setptsFilter ? `${setptsFilter},${vfString}` : vfString
        outputOpts.push(`-vf ${fullVf}`)

        if (musicPath && fs.existsSync(musicPath)) {
          cmd = cmd.input(musicPath)
          outputOpts.push("-c:a aac", "-map 0:v:0", "-map 1:a:0", "-shortest")
        } else {
          outputOpts.push("-c:a aac")
          if (atempo) outputOpts.push(`-af atempo=${atempo}`)
        }

        cmd.outputOptions(outputOpts).output(outputPath)
          .on("end", () => { if (hasSrt && fs.existsSync(srtPath)) fs.unlinkSync(srtPath); resolve() })
          .on("error", (err, stdout, stderr) => {
            console.error("FFmpeg err:", stderr)
            if (hasSrt && fs.existsSync(srtPath)) try { fs.unlinkSync(srtPath) } catch {}
            reject(err)
          })
          .run()
      })

      // Generate thumbnail
      const thumbPath = path.join(tmpDir, `thumb_${ci}_${Date.now()}.jpg`)
      try {
        await execAsync(`ffmpeg -i "${outputPath}" -ss 0.5 -vframes 1 -q:v 2 "${thumbPath}" -y`)
      } catch {}

      const fileBuffer = fs.readFileSync(outputPath)
      const base64 = fileBuffer.toString("base64")
      let thumbBase64 = null
      if (fs.existsSync(thumbPath)) {
        thumbBase64 = `data:image/jpeg;base64,${fs.readFileSync(thumbPath).toString("base64")}`
        fs.unlinkSync(thumbPath)
      }

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