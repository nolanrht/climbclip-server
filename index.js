const express = require("express")
const cors = require("cors")
const ffmpeg = require("fluent-ffmpeg")
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path
const axios = require("axios")
const fs = require("fs")
const path = require("path")
const multer = require("multer")
const { AssemblyAI } = require("assemblyai")
const { exec } = require("child_process")
const { promisify } = require("util")
const execAsync = promisify(exec)
const Anthropic = require("@anthropic-ai/sdk")

ffmpeg.setFfmpegPath(ffmpegPath)

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3001
const aai = new AssemblyAI({ apiKey: "cebb6f1cb4ff45859bec0510b9d92c0f" })
const anthropic = new Anthropic({ apiKey: "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" })

const upload = multer({
  dest: "/tmp/uploads/",
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
})

const jobs = {}

app.get("/health", (req, res) => {
  res.json({ status: "ok" })
})

app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Aucun fichier" })
  console.log("Fichier reçu:", req.file.path)
  res.json({ path: req.file.path })
})

app.post("/download", async (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: "URL requise" })
  const outputPath = path.join("/tmp", `yt_${Date.now()}.mp4`)
  try {
    console.log("Téléchargement:", url)
    await execAsync(`yt-dlp --extractor-args "youtube:player_client=android" -f "best[ext=mp4]/best" -o "${outputPath}" "${url}"`)
    console.log("Téléchargé:", outputPath)
    res.json({ path: outputPath })
  } catch (err) {
    console.error("Erreur yt-dlp:", err)
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
      await new Promise((resolve, reject) => {
        writer.on("finish", resolve)
        writer.on("error", reject)
      })
      inputPaths.push(inputPath)
      jobs[jobId].progress = 10 + Math.floor((i + 1) / (videoUrls.length) * 20)
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

    jobs[jobId].progress = 40

    let subtitles = []
    if (options?.includes("Sous-titres")) {
      try {
        const transcript = await aai.transcripts.transcribe({ audio: mainInput, language_detection: true })
        if (transcript.words) {
          subtitles = transcript.words.map(w => ({ text: w.text, start: w.start / 1000, end: w.end / 1000 }))
        }
      } catch (e) { console.error("Erreur transcription:", e.message) }
    }

    jobs[jobId].progress = 45

    // Analyse IA
    let durations = [
      { start: 0, duration: 15, name: "clip1" },
      { start: 5, duration: 20, name: "clip2" },
      { start: 10, duration: 25, name: "clip3" },
    ]

    try {
      const { stdout: durationStr } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${mainInput}"`)
      const totalDuration = parseFloat(durationStr.trim())

      const aiResponse = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: `Tu es un éditeur vidéo expert en edits TikTok style foot/sport.

La vidéo fait ${Math.round(totalDuration)} secondes au total.
Prompt de l'utilisateur: "${prompt || "fais des edits dynamiques"}"
Options activées: ${(options || []).join(", ")}

Génère 3 clips parfaits pour TikTok. Réponds UNIQUEMENT avec un JSON valide, rien d'autre:
[
  {"start": 0, "duration": 15, "name": "Edit #1"},
  {"start": 10, "duration": 20, "name": "Edit #2"},
  {"start": 25, "duration": 12, "name": "Edit #3"}
]

Règles:
- start + duration ne doit pas dépasser ${Math.round(totalDuration)}
- durées entre 10 et 30 secondes
- varie les moments pour couvrir toute la vidéo
- si le prompt mentionne un joueur ou action spécifique, adapte les timestamps`
        }]
      })

      const aiText = aiResponse.content[0].type === "text" ? aiResponse.content[0].text : ""
      const parsed = JSON.parse(aiText.trim())
      if (Array.isArray(parsed) && parsed.length > 0) {
        durations = parsed.map((d, i) => ({
          start: Math.max(0, Math.min(d.start, totalDuration - d.duration)),
          duration: Math.min(d.duration, totalDuration),
          name: d.name || `Edit #${i + 1}`
        }))
      }
    } catch (e) {
      console.error("Erreur analyse IA:", e.message)
    }

    jobs[jobId].progress = 50

    for (let ci = 0; ci < durations.length; ci++) {
      const clip = durations[ci]
      const outputPath = path.join(tmpDir, `clip_${ci}_${Date.now()}.mp4`)
      const srtPath = path.join(tmpDir, `clip_${ci}_${Date.now()}.srt`)

      if (subtitles.length > 0) {
        const clipSubs = subtitles.filter(s => s.start >= clip.start && s.start < clip.start + clip.duration)
        if (clipSubs.length > 0) {
          let srtContent = ""
          clipSubs.forEach((s, i) => {
            const startTime = s.start - clip.start
            const endTime = s.end - clip.start
            const toSrtTime = (t) => {
              const h = Math.floor(t / 3600).toString().padStart(2, "0")
              const m = Math.floor((t % 3600) / 60).toString().padStart(2, "0")
              const s2 = Math.floor(t % 60).toString().padStart(2, "0")
              const ms = Math.floor((t % 1) * 1000).toString().padStart(3, "0")
              return `${h}:${m}:${s2},${ms}`
            }
            srtContent += `${i + 1}\n${toSrtTime(startTime)} --> ${toSrtTime(endTime)}\n${s.text}\n\n`
          })
          fs.writeFileSync(srtPath, srtContent)
        }
      }

      await new Promise((resolve, reject) => {
        let cmd = ffmpeg(mainInput)
          .setStartTime(clip.start)
          .setDuration(clip.duration)
          .outputOptions(["-c:v libx264", "-c:a aac", "-movflags faststart"])

        if (subtitles.length > 0 && fs.existsSync(srtPath)) {
          cmd = cmd.outputOptions([`-vf subtitles=${srtPath}:force_style='FontSize=18,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2,Alignment=2'`])
        }

        cmd.output(outputPath)
          .on("end", () => {
            if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath)
            resolve(outputPath)
          })
          .on("error", (err, stdout, stderr) => {
            console.error("FFmpeg stderr:", stderr)
            if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath)
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

    for (const p of inputPaths) { if (fs.existsSync(p)) try { fs.unlinkSync(p) } catch {} }

    jobs[jobId] = { status: "done", progress: 100, clips }

  } catch (err) {
    console.error(err)
    for (const p of inputPaths) { if (fs.existsSync(p)) try { fs.unlinkSync(p) } catch {} }
    jobs[jobId] = { status: "error", progress: 0, error: err.message }
  }
}

app.listen(PORT, () => console.log(`ClimbClip server running on port ${PORT}`))