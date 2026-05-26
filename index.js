const handleGenerate = async () => {
  if (!videoUrl && !videoPath) {
    alert("Insère une vidéo d'abord !")
    return
  }
  setHasGenerated(false)
  setGenerating(true)
  try {
    const res = await fetch(`${SERVER_URL}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoUrl: videoUrl || null,
        videoPath: videoPath || null,
        prompt: promptText,
        options: activeOptions,
        musicUrl: selectedMusic?.preview || null,
      }),
    })
    const { jobId } = await res.json()

    // Polling toutes les 5 secondes
    const interval = setInterval(async () => {
      const statusRes = await fetch(`${SERVER_URL}/status/${jobId}`)
      const data = await statusRes.json()
      if (data.status === "done") {
        clearInterval(interval)
        setGeneratedClips(data.clips)
        setHasGenerated(true)
        setGenerating(false)
      } else if (data.status === "error") {
        clearInterval(interval)
        alert("Erreur lors de la génération")
        setGenerating(false)
      }
    }, 5000)
  } catch {
    alert("Erreur lors de la génération")
    setGenerating(false)
  }
}