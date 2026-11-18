// One button: press, speak, press. The note is kept on the phone first and
// leaves for the inbox as soon as there is network.
;(() => {
  const { Outbox, VOCE } = self
  const app = document.getElementById('app')
  const button = document.getElementById('button')
  const timer = document.getElementById('timer')
  const status = document.getElementById('status')
  const setup = document.getElementById('setup')
  const tokenField = document.getElementById('token')
  const problem = document.getElementById('problem')
  const connect = document.getElementById('connect')

  const MIN_MS = 800
  const TYPES = [
    ['audio/webm;codecs=opus', 'webm'],
    ['audio/webm', 'webm'],
    ['audio/mp4', 'm4a'],
    ['audio/ogg;codecs=opus', 'ogg'],
  ]

  let live = null // the recording in progress
  let wakeLock = null
  let statusTimer = 0

  const setState = state => {
    app.dataset.state = state
    setup.hidden = state !== 'setup'
    button.setAttribute('aria-label', state === 'recording' ? 'Ferma e invia' : 'Registra una nota')
  }

  const say = (text, tone = '', forMs = 0) => {
    clearTimeout(statusTimer)
    status.textContent = text
    status.dataset.tone = tone

    if (forMs > 0) {
      statusTimer = setTimeout(showWaiting, forMs)
    }
  }

  // What the bottom line says when nothing else is happening.
  const showWaiting = async () => {
    const count = (await Outbox.pending()).length

    say(count === 0 ? '' : count === 1 ? '1 nota aspetta la rete.' : `${count} note aspettano la rete.`)
  }

  const clock = ms => {
    const seconds = Math.floor(ms / 1000)

    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  }

  const buzz = pattern => {
    try {
      navigator.vibrate?.(pattern)
    } catch {
      // No vibration here: nothing to do.
    }
  }

  const keepAwake = async () => {
    try {
      wakeLock = await navigator.wakeLock?.request('screen')
    } catch {
      wakeLock = null
    }
  }

  // ---- Sending ----

  const openSetup = message => {
    problem.textContent = message ?? ''
    setState('setup')
  }

  const send = async () => {
    let result

    try {
      result = await Outbox.flush()
    } catch {
      result = { sent: 0, left: 1, refused: false, offline: true }
    }

    if (result.refused) {
      openSetup('GitHub non accetta più la chiave. Le note registrate sono al sicuro sul telefono: incolla una chiave nuova e partono.')
    } else if (result.offline) {
      // The phone sends it by itself when the network is back, where it can.
      navigator.serviceWorker?.ready.then(registration => registration.sync?.register('invia')).catch(() => {})
    }

    return result
  }

  // ---- Recording ----

  const listen = (stream, startedMs) => {
    try {
      const context = new (self.AudioContext ?? self.webkitAudioContext)()
      const analyser = context.createAnalyser()
      const samples = new Uint8Array(1024)
      let level = 0
      let frame = 0

      analyser.fftSize = 1024
      context.createMediaStreamSource(stream).connect(analyser)
      context.resume?.()

      const draw = () => {
        analyser.getByteTimeDomainData(samples)

        let sum = 0

        for (const sample of samples) {
          sum += ((sample - 128) / 128) ** 2
        }

        const heard = Math.min(1, Math.sqrt(sum / samples.length) * 4.5)

        // Rises at once, falls slowly: the way a voice meter is read.
        level = heard > level ? heard : level * 0.9 + heard * 0.1
        button.style.setProperty('--level', level.toFixed(3))
        timer.textContent = clock(Date.now() - startedMs)
        frame = requestAnimationFrame(draw)
      }

      draw()

      return () => {
        cancelAnimationFrame(frame)
        context.close().catch(() => {})
        button.style.removeProperty('--level')
      }
    } catch {
      const tick = setInterval(() => (timer.textContent = clock(Date.now() - startedMs)), 250)

      return () => clearInterval(tick)
    }
  }

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || !self.MediaRecorder) {
      return say('Questo browser non sa registrare. Apri la pagina con Chrome o Safari.', 'bad')
    }

    let stream

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      })
    } catch (error) {
      return say(
        error.name === 'NotAllowedError'
          ? 'Il microfono è bloccato. Consenti il microfono per questa app nelle impostazioni del telefono.'
          : 'Non riesco ad accendere il microfono.',
        'bad',
      )
    }

    const [type, extension] = TYPES.find(([mime]) => MediaRecorder.isTypeSupported(mime)) ?? ['', 'webm']
    const recorder = new MediaRecorder(stream, { ...(type && { mimeType: type }), audioBitsPerSecond: 32000 })
    const startedMs = Date.now()
    const name = `${new Date(startedMs).toISOString().replace(/[:.]/g, '-')}.${extension}`
    const mime = recorder.mimeType || type || 'audio/webm'

    const chunks = []

    live = { recorder, stream, startedMs, name, type: mime, chunks, stopListening: () => {} }

    Outbox.startDraft({ name, type: mime, createdMs: startedMs })
    // The last piece arrives after the stop was asked: it is kept all the same.
    recorder.ondataavailable = event => {
      if (event.data.size > 0) {
        chunks.push(event.data)
        Outbox.addDraft(event.data)
      }
    }
    // The microphone taken away (a phone call, a pulled headset): what was
    // said so far is sent.
    stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => live && stop()))
    recorder.start(3000)

    timer.textContent = '0:00'
    live.stopListening = listen(stream, startedMs)
    setState('recording')
    say('')
    buzz(25)
    keepAwake()
  }

  const stop = async () => {
    const taken = live

    if (!taken) {
      return
    }

    live = null
    setState('saving')
    buzz([15, 70, 15])

    await new Promise(done => {
      taken.recorder.addEventListener('stop', done, { once: true })

      try {
        taken.recorder.stop()
      } catch {
        done()
      }
    })
    taken.stopListening()
    taken.stream.getTracks().forEach(track => track.stop())
    wakeLock?.release().catch(() => {})
    wakeLock = null

    const durationMs = Date.now() - taken.startedMs

    if (durationMs < MIN_MS || taken.chunks.length === 0) {
      await Outbox.clearDraft()
      setState('idle')

      return say('Troppo breve: non ho inviato niente.', '', 2500)
    }

    try {
      const bytes = await new Blob(taken.chunks, { type: taken.type }).arrayBuffer()

      await Outbox.enqueue({ name: taken.name, type: taken.type, bytes, createdMs: taken.startedMs })
      await Outbox.clearDraft()
    } catch {
      setState('idle')

      return say('Non sono riuscito a salvare la nota sul telefono.', 'bad')
    }

    say('Invio…')

    const result = await send()

    if (app.dataset.state === 'setup') {
      return
    }

    setState('idle')

    if (result.left === 0) {
      say('Inviata.', 'good', 2500)
    } else {
      say('Salvata sul telefono. Parte da sola appena c’è rete.', '', 4000)
    }
  }

  // A second tap while the microphone is still being asked for starts nothing.
  let isStarting = false

  button.addEventListener('click', () => {
    if (app.dataset.state === 'idle' && !isStarting) {
      isStarting = true
      start().finally(() => (isStarting = false))
    } else if (app.dataset.state === 'recording') {
      stop()
    }
  })

  // ---- Connecting the phone, once ----

  setup.addEventListener('submit', async event => {
    event.preventDefault()

    const token = tokenField.value.trim()

    if (token === '') {
      problem.textContent = 'Incolla la chiave.'

      return
    }

    connect.disabled = true
    problem.textContent = ''

    try {
      if ((await Outbox.checkToken(token)) === 'ok') {
        await Outbox.setSetting('token', token)
        tokenField.value = ''
        setState('idle')
        say('Collegato. Premi il bottone e parla.', 'good', 4000)
        send()
      } else {
        problem.textContent = `Questa chiave non arriva a ${VOCE.repo}. Controlla di aver scelto quel repository e il permesso Contents: Read and write.`
      }
    } catch {
      problem.textContent = 'Non riesco a raggiungere GitHub: controlla la rete e riprova.'
    } finally {
      connect.disabled = false
    }
  })

  // ---- Opening ----

  const boot = async () => {
    const description = 'Chiave del telefono per l’app Voce: scrive solo nella casella delle note.'

    document.getElementById('repoName').textContent = VOCE.repo.split('/')[1]
    document.getElementById('tokenLink').href =
      `https://github.com/settings/personal-access-tokens/new?name=Voce&description=${encodeURIComponent(description)}&expires_in=none&contents=write`

    // On this computer only, a test can point the app at a stand-in for GitHub.
    if (Outbox.isLocal) {
      const override = new URLSearchParams(location.search).get('api')

      if (override) {
        await Outbox.setSetting('apiOverride', override)
      }
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {})
    }

    const recovered = await Outbox.recoverDraft().catch(() => false)
    const token = await Outbox.getSetting('token')

    if (!token || location.hash === '#chiave') {
      return openSetup()
    }

    setState('idle')

    if (recovered) {
      say('Ho recuperato una registrazione interrotta.', '', 4000)
    } else {
      showWaiting()
    }

    send().then(result => {
      if (result.sent > 0 && app.dataset.state === 'idle') {
        say(result.sent === 1 ? 'Inviata la nota che aspettava.' : `Inviate ${result.sent} note che aspettavano.`, 'good', 3000)
      }
    })
  }

  self.addEventListener('online', () => {
    if (app.dataset.state === 'idle') {
      send().then(showWaiting)
    }
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      return
    }

    if (live) {
      keepAwake()
    } else if (app.dataset.state === 'idle') {
      send().then(showWaiting)
    }
  })

  boot().catch(() => {
    setState('idle')
    say('Qualcosa non va all’apertura. Chiudi e riapri l’app.', 'bad')
  })
})()
