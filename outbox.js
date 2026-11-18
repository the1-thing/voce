// The outbox: recordings wait here, on the phone, until GitHub has them.
// Loaded by the page and by the service worker, so a note recorded without
// network leaves by itself when the network is back.
;(() => {
  const DB_NAME = 'voce'
  const LOCK = 'voce-outbox'
  const isLocal = ['localhost', '127.0.0.1'].includes(self.location.hostname)

  let opening = null
  const open = () => {
    opening ??= new Promise((done, fail) => {
      const request = indexedDB.open(DB_NAME, 1)

      request.onupgradeneeded = () => {
        const db = request.result

        db.createObjectStore('outbox', { keyPath: 'name' })
        db.createObjectStore('draft', { autoIncrement: true })
        db.createObjectStore('settings')
      }
      request.onsuccess = () => done(request.result)
      request.onerror = () => fail(request.error)
    })

    return opening
  }

  // One request against one store, as a promise.
  const run = async (store, mode, work) => {
    const db = await open()

    return new Promise((done, fail) => {
      const tx = db.transaction(store, mode)
      const request = work(tx.objectStore(store))

      tx.oncomplete = () => done(request?.result)
      tx.onerror = () => fail(tx.error)
      tx.onabort = () => fail(tx.error)
    })
  }

  const getSetting = key => run('settings', 'readonly', store => store.get(key))
  const setSetting = (key, value) => run('settings', 'readwrite', store => store.put(value, key))
  const dropSetting = key => run('settings', 'readwrite', store => store.delete(key))

  // The API is GitHub's, except on this computer during a test.
  const apiBase = async () => (isLocal && (await getSetting('apiOverride'))) || self.VOCE.api

  const headers = token => ({
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  })

  const toBase64 = bytes => {
    const view = new Uint8Array(bytes)
    let binary = ''

    for (let at = 0; at < view.length; at += 0x8000) {
      binary += String.fromCharCode.apply(null, view.subarray(at, at + 0x8000))
    }

    return btoa(binary)
  }

  // 'ok' when this key can reach the inbox, 'refused' when GitHub says no.
  // A network failure throws.
  const checkToken = async token => {
    const response = await fetch(`${await apiBase()}/repos/${self.VOCE.repo}/contents/`, {
      headers: headers(token),
      cache: 'no-store',
    })

    return response.ok ? 'ok' : 'refused'
  }

  // 'sent', 'refused' (the key no longer works) or 'retry'. Throws offline.
  const upload = async (item, token) => {
    const response = await fetch(`${await apiBase()}/repos/${self.VOCE.repo}/contents/${self.VOCE.folder}/${item.name}`, {
      method: 'PUT',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `nota ${item.name}`, content: toBase64(item.bytes) }),
    })

    // 422: a file with this name is already there, so an earlier try arrived
    // and only its answer was lost.
    if (response.ok || response.status === 422) {
      return 'sent'
    }

    return [401, 403, 404].includes(response.status) ? 'refused' : 'retry'
  }

  const pending = () => run('outbox', 'readonly', store => store.getAllKeys())

  const send = async () => {
    const token = await getSetting('token')
    const names = await pending()
    const result = { sent: 0, left: names.length, refused: false, offline: false }

    if (!token) {
      return { ...result, refused: names.length > 0 }
    }

    for (const name of names) {
      const item = await run('outbox', 'readonly', store => store.get(name))

      if (!item) {
        result.left -= 1
        continue
      }

      let outcome = 'retry'

      try {
        outcome = await upload(item, token)
      } catch {
        result.offline = true
        break
      }

      if (outcome === 'sent') {
        await run('outbox', 'readwrite', store => store.delete(name))
        result.sent += 1
        result.left -= 1
      } else if (outcome === 'refused') {
        result.refused = true
        break
      } else {
        result.offline = true
        break
      }
    }

    return result
  }

  // Everything waiting is sent, oldest first, by one sender at a time.
  const flush = () => (self.navigator?.locks ? navigator.locks.request(LOCK, send) : send())

  const enqueue = item => run('outbox', 'readwrite', store => store.put(item))

  // The recording in progress, kept piece by piece: if the app is closed
  // mid-sentence, what was said is still here at the next opening.
  let draftChain = Promise.resolve()
  const startDraft = meta => {
    draftChain = draftChain
      .catch(() => {})
      .then(() => run('draft', 'readwrite', store => store.clear()))
      .then(() => setSetting('draftMeta', meta))

    return draftChain
  }
  const addDraft = blob => {
    draftChain = draftChain
      .catch(() => {})
      .then(() => blob.arrayBuffer())
      .then(bytes => run('draft', 'readwrite', store => store.add(bytes)))

    return draftChain
  }
  const clearDraft = () => {
    draftChain = draftChain
      .catch(() => {})
      .then(() => run('draft', 'readwrite', store => store.clear()))
      .then(() => dropSetting('draftMeta'))

    return draftChain
  }
  // A recording that never reached its end becomes a note to send.
  const recoverDraft = async () => {
    const meta = await getSetting('draftMeta')
    const pieces = await run('draft', 'readonly', store => store.getAll())

    if (meta && pieces.length > 0) {
      const bytes = await new Blob(pieces, { type: meta.type }).arrayBuffer()

      await enqueue({ name: meta.name, type: meta.type, bytes, createdMs: meta.createdMs })
    }

    await clearDraft()

    return Boolean(meta && pieces.length > 0)
  }

  self.Outbox = {
    getSetting,
    setSetting,
    dropSetting,
    checkToken,
    enqueue,
    pending,
    flush,
    startDraft,
    addDraft,
    clearDraft,
    recoverDraft,
    isLocal,
  }
})()
