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

const upload = multer({
  dest: "/tmp/uploads/",
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
})

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
    console.log("Téléchargement:", url)
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
  } catch {
    res.json({ thumbnail: null })
  }
})

app.post("/prompt-help", async (req, res) => {
  const { description, refVideoFrames } = req.body
  try {
    const messages = [{
      role: "user",
      content: refVideoFrames ? [
        ...refVideoFrames.map((frame) => ({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: frame }
        })),
        { type: "text", text: `Tu es un expert en edits TikTok foot/sport. L'utilisateur veut créer un edit et a fourni des images de référence + cette description: "${description}". Génère un prompt parfait et détaillé pour générer cet edit. Réponds uniquement avec le prompt, rien d'autre.` }
      ] : [{ type: "text", text: `Tu es un expert en edits TikTok foot/sport. L'utilisateur veut: "${description}". Génère un prompt parfait et détaillé pour générer cet edit. Réponds uniquement avec le prompt, rien d'autre.` }]
    }]
    const response = await anthropic.messages.create({ model: "claude-sonnet-4-5", max_tokens: 500, messages })
    res.json({ prompt: response.content[0].type === "text" ? response.content[0].text : "" })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post("/generate", async (req, res) => {
  const { videoUrls, videoPaths, prompt, options, musicUrl } = req.body
  if (!videoUrls?.length && !videoPaths?.length) return res.status(400).json({ error: "Aucune vidéo" })
  const jobId = `job_${Date.now()}`
  jobs[jobId] = { status: "processing", progress: 0, clips: null, error: null }
  res.json({ jobId })
  processVideo({ jobId, videoUrls, videoPaths, prompt, options, musicUrl })
})

app.get("/status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId]
  if (!job) return res.status(404).json({ error: "Job introuvable" })
  res.json(job)
})

async function analyzeEffects(prompt, totalDuration, options) {
  try {
    const needsZoom = options?.includes("Auto-zoom")
    const needsSpeedRamp = options?.includes("Speed ramp")
    if (!needsZoom && !needsSpeedRamp) return null

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: `Tu es un expert en montage vidéo TikTok/sport. Analyse ce prompt: "${prompt || "edit dynamique sport"}"
La vidéo fait ${Math.round(totalDuration)} secondes.
Options activées: ${options?.join(", ")}

Génère les paramètres d'effets optimaux. Réponds UNIQUEMENT avec du JSON brut sans backticks:
{
  "autozoom": {
    "enabled": ${needsZoom},
    "intensity": 1.15,
    "zoom_points": [
      {"time": 0, "scale": 1.0},
      {"time": 0.3, "scale": 1.15},
      {"time": 0.7, "scale": 1.05},
      {"time": 1.0, "scale": 1.0}
    ]
  },
  "speedramp": {
    "enabled": ${needsSpeedRamp},
    "segments": [
      {"start_pct": 0, "end_pct": 0.2, "speed": 1.5},
      {"start_pct": 0.2, "end_pct": 0.5, "speed": 0.7},
      {"start_pct": 0.5, "end_pct": 0.8, "speed": 1.8},
      {"start_pct": 0.8, "end_pct": 1.0, "speed": 1.0}
    ]
  }
}

Règles:
- Pour un edit dynamique/sport/foot: zoom entre 1.05 et 1.25, speed entre 0.5 et 2.5
- Pour un edit chill/slow: zoom entre 1.02 et 1.1, speed entre 0.5 et 1.2
- Pour des capsules: zoom léger 1.05-1.1, speed stable 1.0
- Adapte l'intensité selon le style demandé dans le prompt`
      }]
    })

    const text = response.content[0].type === "text" ? response.content[0].text : ""
    const clean = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim()
    return JSON.parse(clean)
  } catch (e) {
    console.error("Erreur analyse effets:", e.message)
    return null
  }
}

function buildVideoFilters(clipDuration, effects, subtitles, srtPath) {
  const filters = []

  if (effects?.speedramp?.enabled && effects.speedramp.segments?.length > 0) {
    const segments = effects.speedramp.segments
    let setptsFilter = "setpts="
    const ptsSegments = segments.map((seg, i) => {
      const startSec = seg.start_pct * clipDuration
      const endSec = seg.end_pct * clipDuration
      const speed = Math.max(0.25, Math.min(4.0, seg.speed))
      if (i === 0) {
        return `if(between(T,${startSec.toFixed(2)},${endSec.toFixed(2)}),${(1/speed).toFixed(3)}*PTS`
      } else if (i === segments.length - 1) {
        return `if(between(T,${startSec.toFixed(2)},${endSec.toFixed(2)}),${(1/speed).toFixed(3)}*PTS,PTS)${")"
          .repeat(segments.length - 1)}`
      } else {
        return `if(between(T,${startSec.toFixed(2)},${endSec.toFixed(2)}),${(1/speed).toFixed(3)}*PTS`
      }
    })
    filters.push(`${setptsFilter}${ptsSegments.join(",")}`)
  }

  if (effects?.autozoom?.enabled && effects.autozoom.zoom_points?.length > 0) {
    const zoomPts = effects.autozoom.zoom_points
    const maxScale = effects.autozoom.intensity || 1.15
    const zoompanExpr = `scale=iw*${maxScale.toFixed(3)}:ih*${maxScale.toFixed(3)},crop=iw/${maxScale.toFixed(3)}:ih/${maxScale.toFixed(3)}`
    filters.push(zoompanExpr)
  }

  if (subtitles.length > 0 && srtPath && fs.existsSync(srtPath)) {
    filters.push(`subtitles=${srtPath}:force_style='FontSize=18,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2,Alignment=2'`)
  }

  return filters
}

async function processVideo({ jobId, videoUrls, videoPaths, prompt, options, musicUrl }) {
  const tmpDir = "/tmp"
  const inputPaths = []
  const clips = []

  try {
    jobs[jobId] = { status: "processing", progress: 5, clips: null, error: null }

    for (let i = 0; i < (videoUrls || []).length; i++) {
      const url = videoUrls[i]
      const inputPath = path.join(tmpDir, `input_${Date.now()}_${i}.mp4`)
      const response = await axios({ url, method: "GET", responseType: "stream" })
      const writer = fs.createWriteStream(inputPath)
      response.data.pipe(writer)
      await new Promise((resolve, reject) => { writer.on("finish", resolve); writer.on("error", reject) })
      inputPaths.push(inputPath)
      jobs[jobId].progress = 10 + Math.floor((i + 1) / videoUrls.length * 20)
    }

    for (const p of (videoPaths || [])) {
      if (fs.existsSync(p)) inputPaths.push(p)
    }

    jobs[jobId].progress = 30

    let mainInput = inputPaths[0]
    if (inputPaths.length > 1) {
      const listPath = path.join(tmpDir, `list_${Date.now()}.txt`)
      const concatPath = path.join(tmpDir, `concat_${Date.now()}.mp4`)
      fs.writeFileSync(listPath, inputPaths.map(p => `file '${p}'`).join("\n"))
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(listPath)
          .inputOptions(["-f", "concat", "-safe", "0"])
          .outputOptions(["-c copy"])
          .output(concatPath)
          .on("end", () => resolve(concatPath))
          .on("error", reject)
          .run()
      })
      mainInput = concatPath
      fs.unlinkSync(listPath)
    }

    jobs[jobId].progress = 35

    let musicPath = null
    if (musicUrl) {
      try {
        musicPath = path.join(tmpDir, `music_${Date.now()}.mp3`)
        const musicResponse = await axios({ url: musicUrl, method: "GET", responseType: "stream" })
        const musicWriter = fs.createWriteStream(musicPath)
        musicResponse.data.pipe(musicWriter)
        await new Promise((resolve, reject) => { musicWriter.on("finish", resolve); musicWriter.on("error", reject) })
      } catch (e) { console.error("Erreur musique:", e.message); musicPath = null }
    }

    let subtitles = []
    if (options?.includes("Sous-titres")) {
      try {
        const transcript = await aai.transcripts.transcribe({ audio: mainInput, language_detection: true })
        if (transcript.words) {
          subtitles = transcript.words.map(w => ({ text: w.text, start: w.start / 1000, end: w.end / 1000 }))
        }
      } catch (e) { console.error("Erreur transcription:", e.message) }
    }

    jobs[jobId].progress = 40

    const { stdout: durationStr } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${mainInput}"`)
    const totalDuration = parseFloat(durationStr.trim())

    // Analyse IA pour les effets (auto-zoom + speed ramp)
    const effects = await analyzeEffects(prompt, totalDuration, options)
    jobs[jobId].progress = 45

    let durations = [
      { start: 0, duration: 15, name: "Edit #1" },
      { start: 5, duration: 20, name: "Edit #2" },
      { start: 10, duration: 25, name: "Edit #3" },
    ]

    try {
      const aiResponse = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: `Tu es un éditeur vidéo expert en edits TikTok style foot/sport.
La vidéo fait ${Math.round(totalDuration)} secondes au total.
Prompt: "${prompt || "fais des edits dynamiques"}"
Analyse le prompt et détermine le nombre de clips. Réponds UNIQUEMENT avec un JSON valide sans backticks:
[{"start": 0, "duration": 15, "name": "Edit #1"}]
Règles: start+duration <= ${Math.round(totalDuration)}, durées 10-30s, couvre toute la vidéo, si "1 clip" génère un seul objet`
        }]
      })

      const aiText = aiResponse.content[0].type === "text" ? aiResponse.content[0].text : ""
      const parsed = JSON.parse(aiText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim())
      if (Array.isArray(parsed) && parsed.length > 0) {
        durations = parsed.map((d, i) => ({
          start: Math.max(0, Math.min(d.start, totalDuration - d.duration)),
          duration: Math.min(d.duration, totalDuration),
          name: d.name || `Edit #${i + 1}`
        }))
      }
    } catch (e) { console.error("Erreur analyse IA clips:", e.message) }

    jobs[jobId].progress = 50

    for (let ci = 0; ci < durations.length; ci++) {
      const clip = durations[ci]
      const outputPath = path.join(tmpDir, `clip_${ci}_${Date.now()}.mp4`)
      const srtPath = path.join(tmpDir, `clip_${ci}_${Date.now()}.srt`)

      // Générer SRT si sous-titres
      let hasSrt = false
      if (subtitles.length > 0) {
        const clipSubs = subtitles.filter(s => s.start >= clip.start && s.start < clip.start + clip.duration)
        if (clipSubs.length > 0) {
          const toSrtTime = (t) => {
            const h = Math.floor(t / 3600).toString().padStart(2, "0")
            const m = Math.floor((t % 3600) / 60).toString().padStart(2, "0")
            const s2 = Math.floor(t % 60).toString().padStart(2, "0")
            const ms = Math.floor((t % 1) * 1000).toString().padStart(3, "0")
            return `${h}:${m}:${s2},${ms}`
          }
          let srtContent = ""
          clipSubs.forEach((s, i) => {
            srtContent += `${i + 1}\n${toSrtTime(s.start - clip.start)} --> ${toSrtTime(s.end - clip.start)}\n${s.text}\n\n`
          })
          fs.writeFileSync(srtPath, srtContent)
          hasSrt = true
        }
      }

      // Construire les filtres vidéo
      const videoFilters = buildVideoFilters(clip.duration, effects, subtitles, hasSrt ? srtPath : null)

      await new Promise((resolve, reject) => {
        let cmd = ffmpeg(mainInput)
          .setStartTime(clip.start)
          .setDuration(clip.duration)

        const outputOpts = ["-movflags faststart"]

        if (videoFilters.length > 0) {
          outputOpts.push(`-vf ${videoFilters.join(",")}`)
          outputOpts.push("-c:v libx264")
          // Speed ramp nécessite re-encode audio aussi
          if (effects?.speedramp?.enabled) {
            outputOpts.push("-af atempo=1.0")
          }
        } else {
          outputOpts.push("-c:v libx264")
        }

        if (musicPath && fs.existsSync(musicPath)) {
          cmd = cmd.input(musicPath)
          outputOpts.push("-c:a aac", "-map 0:v:0", "-map 1:a:0", "-shortest")
        } else {
          outputOpts.push("-c:a aac")
        }

        cmd.outputOptions(outputOpts)
          .output(outputPath)
          .on("end", () => {
            if (hasSrt && fs.existsSync(srtPath)) fs.unlinkSync(srtPath)
            resolve(outputPath)
          })
          .on("error", (err, stdout, stderr) => {
            console.error("FFmpeg stderr:", stderr)
            if (hasSrt && fs.existsSync(srtPath)) try { fs.unlinkSync(srtPath) } catch {}
            reject(err)
          })
          .run()
      })

      const fileBuffer = fs.readFileSync(outputPath)
      const base64 = fileBuffer.toString("base64")
      clips.push({ name: clip.name || `Edit #${ci + 1}`, base64: `data:video/mp4;base64,${base64}`, duration: clip.duration })
      fs.unlinkSync(outputPath)
      jobs[jobId].progress = 50 + Math.floor((ci + 1) / durations.length * 50)
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