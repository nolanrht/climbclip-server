const express = require("express")
const cors = require("cors")
const ffmpeg = require("fluent-ffmpeg")
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path
const axios = require("axios")
const fs = require("fs")
const path = require("path")

ffmpeg.setFfmpegPath(ffmpegPath)

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3001

app.get("/health", (req, res) => {
  res.json({ status: "ok" })
})

app.post("/generate", async (req, res) => {
  const { videoUrl, prompt, options, musicUrl } = req.body

  if (!videoUrl) return res.status(400).json({ error: "videoUrl requis" })

  const tmpDir = "/tmp"
  const inputPath = path.join(tmpDir, `input_${Date.now()}.mp4`)
  const clips = []

  try {
    // Télécharger la vidéo depuis Supabase
    const response = await axios({ url: videoUrl, method: "GET", responseType: "stream" })
    const writer = fs.createWriteStream(inputPath)
    response.data.pipe(writer)
    await new Promise((resolve, reject) => {
      writer.on("finish", resolve)
      writer.on("error", reject)
    })

    // Générer 3 clips de durées différentes
    const durations = [
      { start: 0, duration: 15, name: "clip1" },
      { start: 5, duration: 20, name: "clip2" },
      { start: 10, duration: 25, name: "clip3" },
    ]

    for (const clip of durations) {
      const outputPath = path.join(tmpDir, `${clip.name}_${Date.now()}.mp4`)

      await new Promise((resolve, reject) => {
        let cmd = ffmpeg(inputPath)
          .setStartTime(clip.start)
          .setDuration(clip.duration)
          .size("1080x1920")
          .autopad()
          .outputOptions(["-c:v libx264", "-c:a aac", "-movflags faststart"])

        if (options?.includes("Sous-titres")) {
          cmd = cmd.outputOptions([
            "-vf drawtext=text='ClimbClip':fontcolor=white:fontsize=40:x=(w-text_w)/2:y=h-100"
          ])
        }

        cmd.output(outputPath)
          .on("end", () => resolve(outputPath))
          .on("error", reject)
          .run()
      })

      // Lire le fichier et le convertir en base64
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
    res.json({ clips })

  } catch (err) {
    console.error(err)
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => console.log(`ClimbClip server running on port ${PORT}`))