const express = require("express")
const cors = require("cors")
const ffmpeg = require("fluent-ffmpeg")
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path
const axios = require("axios")
const fs = require("fs")
const path = require("path")
const { AssemblyAI } = require("assemblyai")

ffmpeg.setFfmpegPath(ffmpegPath)

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3001
const aai = new AssemblyAI({ apiKey: "cebb6f1cb4ff45859bec0510b9d92c0f" })

app.get("/health", (req, res) => {
  res.json({ status: "ok" })
})

app.post("/generate", async (req, res) => {
  const { videoUrl, prompt, options, musicUrl } = req.body
  console.log("Options reçues:", options)
  console.log("Prompt reçu:", prompt)

  if (!videoUrl) return res.status(400).json({ error: "videoUrl requis" })

  const tmpDir = "/tmp"
  const inputPath = path.join(tmpDir, `input_${Date.now()}.mp4`)
  const clips = []

  try {
    // Télécharger la vidéo
    const response = await axios({ url: videoUrl, method: "GET", responseType: "stream" })
    const writer = fs.createWriteStream(inputPath)
    response.data.pipe(writer)
    await new Promise((resolve, reject) => {
      writer.on("finish", resolve)
      writer.on("error", reject)
    })

    // Transcription avec AssemblyAI si sous-titres demandés
    let subtitles = []
    if (options?.includes("Sous-titres")) {
      console.log("Transcription en cours...")
      try {
        const transcript = await aai.transcripts.transcribe({ audio: videoUrl, language_detection: true })
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

      // Générer le fichier SRT pour ce clip
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
            `-vf subtitles=${srtPath}:force_style='FontName=Helvetica,FontSize=18,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2,Alignment=2'`
          ])
        } else if (options?.includes("Sous-titres")) {
          cmd = cmd.outputOptions([
            "-vf drawtext=fontfile=/System/Library/Fonts/Helvetica.ttc:text='...':fontcolor=white:fontsize=40:x=(w-text_w)/2:y=h-100"
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

    fs.unlinkSync(inputPath)
    console.log("Génération terminée !")
    res.json({ clips })

  } catch (err) {
    console.error(err)
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => console.log(`ClimbClip server running on port ${PORT}`))