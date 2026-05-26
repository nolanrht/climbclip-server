const express = require("express")
const cors = require("cors")
const ffmpeg = require("fluent-ffmpeg")
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path
const axios = require("axios")
const fs = require("fs")
const path = require("path")
const multer = require("multer")
const { AssemblyAI } = require("assemblyai")

ffmpeg.setFfmpegPath(ffmpegPath)

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3001
const aai = new AssemblyAI({ apiKey: "cebb6f1cb4ff45859bec0510b9d92c0f" })

const upload = multer({
  dest: "/tmp/uploads/",
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
})

app.get("/health", (req, res) => {
  res.json({ status: "ok" })
})

app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Aucun fichier" })
  console.log("Fichier reçu:", req.file.path)
  res.json({ path: req.file.path })
})

app.post("/generate", async (req, res) => {
  const { videoUrl, videoPath, prompt, options, musicUrl } = req.body
  console.log("Generate appelé - videoPath:", videoPath, "videoUrl:", videoUrl)
  console.log("Options reçues:", options)
  console.log("Prompt reçu:", prompt)

  if (!videoUrl && !videoPath) return res.status(400).json({ error: "videoUrl ou videoPath requis" })

  const tmpDir = "/tmp"
  const inputPath = videoPath || path.join(tmpDir, `input_${Date.now()}.mp4`)
  const clips = []
  let downloadedFile = false

  try {
    if (videoUrl && !videoPath) {
      downloadedFile = true
      const response = await axios({ url: videoUrl, method: "GET", responseType: "stream" })
      const writer = fs.createWriteStream(inputPath)
      response.data.pipe(writer)
      await new Promise((resolve, reject) => {
        writer.on("finish", resolve)
        writer.on("error", reject)
      })
    }

    let subtitles = []
    if (options?.includes("Sous-titres")) {
      console.log("Transcription en cours...")
      try {
        const transcript = await aai.transcripts.transcribe({
          audio: videoUrl || inputPath,
          language_detection: true
        })
        if (transcript.words) {
          subtitles = transcript.words.map(w => ({
            text: w.text,
            start: w.start / 1000,
            end: w.end / 1000,
          }))
        }
        console.log("Transcription terminée:", subtitles.length, "mots")
      } catch (e) {
        console.error("Erreur transcription:", e.message)
      }
    }

    const durations = [
      { start: 0, duration: 15, name: "clip1" },
      { start: 5, duration: 20, name: "clip2" },
      { start: 10, duration: 25, name: "clip3" },
    ]

    for (const clip of durations) {
      const outputPath = path.join(tmpDir, `${clip.name}_${Date.now()}.mp4`)
      const srtPath = path.join(tmpDir, `${clip.name}_${Date.now()}.srt`)

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
        let cmd = ffmpeg(inputPath)
          .setStartTime(clip.start)
          .setDuration(clip.duration)
          .outputOptions(["-c:v libx264", "-c:a aac", "-movflags faststart"])

        if (subtitles.length > 0 && fs.existsSync(srtPath)) {
          cmd = cmd.outputOptions([
            `-vf subtitles=${srtPath}:force_style='FontSize=18,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2,Alignment=2'`
          ])
        }

        cmd.output(outputPath)
          .on("end", () => {
            console.log(`Clip ${clip.name} généré`)
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
      clips.push({
        name: `Edit #${clips.length + 1}`,
        base64: `data:video/mp4;base64,${base64}`,
        duration: clip.duration,
      })

      fs.unlinkSync(outputPath)
    }

    if (downloadedFile && fs.existsSync(inputPath)) fs.unlinkSync(inputPath)
    if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath)
    console.log("Génération terminée !")
    res.json({ clips })

  } catch (err) {
    console.error(err)
    if (downloadedFile && fs.existsSync(inputPath)) fs.unlinkSync(inputPath)
    if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => console.log(`ClimbClip server running on port ${PORT}`))