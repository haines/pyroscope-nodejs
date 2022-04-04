import * as pprof from 'pprof'

import perftools from 'pprof/proto/profile'
import debug from 'debug'
import axios, { AxiosError } from 'axios'
import FormData from 'form-data'

type Label = perftools.perftools.profiles.Label
type TagList = Record<string, any>

const log = debug('pyroscope')

export interface PyroscopeConfig {
  server: string
  name: string
  sourceMapPath?: string[]
  autoStart: boolean
  sm?: any
  tags: TagList
}

const INTERVAL = 10000
const SAMPLERATE = 100
// Base sampling interval, constant for pyroscope
const DEFAULT_SERVER = 'http://localhost:4040'

const config: PyroscopeConfig = {
  server: DEFAULT_SERVER,
  autoStart: true,
  name: 'nodejs',
  sm: undefined,
  tags: {},
}

export function init(
  c: PyroscopeConfig = {
    server: DEFAULT_SERVER,
    autoStart: true,
    name: 'nodejs',
    tags: {},
  }
): void {
  if (c) {
    config.server = c.server || DEFAULT_SERVER
    config.sourceMapPath = c.sourceMapPath
    if (!!config.sourceMapPath) {
      pprof.SourceMapper.create(config.sourceMapPath).then(
        (sm) => (config.sm = sm)
      )
    }
    config.tags = c.tags
  }

  if (c && c.autoStart) {
    startCpuProfiling()
    startHeapProfiling()
  }
}

function handleError(error: AxiosError) {
  if (error.response) {
    // The request was made and the server responded with a status code
    // that falls out of the range of 2xx
    log('Pyroscope received error while ingesting data to server')
    log(error.response.data)
  } else if (error.request) {
    // The request was made but no response was received
    // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
    // http.ClientRequest in node.js
    log('Error when ingesting data to server:', error.message)
  } else {
    // Something happened in setting up the request that triggered an Error
    log('Error', error.message)
  }
}

async function uploadProfile(profile: perftools.perftools.profiles.IProfile) {
  // Apply labels to all samples
  const buf = await pprof.encode(profile)

  const formData = new FormData()
  formData.append('profile', buf, {
    knownLength: buf.byteLength,
    contentType: 'text/json',
    filename: 'profile',
  })

  const tagList = Object.keys(config.tags).map(
    (t: string) => `${t}=${config.tags[t]}`
  )
  const url = `${config.server}/ingest?name=${config.name}{${tagList}}&sampleRate=${SAMPLERATE}`
  log(`Sending data to ${url}`)
  // send data to the server
  return axios(url, {
    method: 'POST',
    headers: formData.getHeaders(),
    data: formData as any,
  }).catch(handleError)
}

const tagListToLabels = (tags: TagList) =>
  Object.keys(tags).map((t: string) =>
    perftools.perftools.profiles.Label.create({
      key: t as any,
      str: tags[t],
    })
  )

// Could be false or a function to stop heap profiling
let heapProfilingTimer: undefined | NodeJS.Timer = undefined
let isCpuProfilingRunning = false

import fs from 'fs'

let chunk = 0
const writeProfileAsync = (profile: perftools.perftools.profiles.IProfile) => {
  pprof.encode(profile).then((buf) => {
    fs.writeFile(`${config.name}-${chunk}.pb.gz`, buf, (err) => {
      if (err) throw err
      console.log('Chunk written')
      chunk += 1
    })
  })
}

export function startCpuProfiling(tags: TagList = {}) {
  log('Pyroscope has started CPU Profiling')
  isCpuProfilingRunning = true

  const profilingRound = () => {
    log('Collecting CPU Profile')
    pprof.time
      .profile({
        lineNumbers: true,
        sourceMapper: config.sm,
        durationMillis: INTERVAL,
        intervalMicros: 10000,
      })
      .then((profile) => {
        log('CPU Profile collected')
        if (isCpuProfilingRunning) {
          setImmediate(profilingRound)
        }
        log('CPU Profile uploading')
        return uploadProfile(profile)
      })
      .then((d) => {
        log('CPU Profile has been uploaded')
      })
  }

  profilingRound()
}

// It doesn't stop it immediately, just wait until it ends
export async function stopCpuProfiling() {
  isCpuProfilingRunning = false
}

export async function startHeapProfiling(tags: TagList = {}) {
  const intervalBytes = 1024 * 512
  const stackDepth = 32

  if (heapProfilingTimer) return false
  log('Pyroscope has started heap profiling')

  const sm = await pprof.SourceMapper.create([process.cwd()])

  pprof.heap.start(intervalBytes, stackDepth)

  heapProfilingTimer = setInterval(async () => {
    log('Collecting heap profile')
    const profile = pprof.heap.profile(undefined, sm)
    log('Heap profile collected...')
    await uploadProfile(profile)
    log('Heap profile uploaded...')
  }, INTERVAL)
}

export function stopHeapProfiling() {
  if (heapProfilingTimer) {
    log('Stopping heap profiling')
    clearInterval(heapProfilingTimer)
    heapProfilingTimer = undefined
  }
}

export default {
  init,
  startCpuProfiling,
  stopCpuProfiling,
  startHeapProfiling,
  stopHeapProfiling,
}

if (module.parent && module.parent.id === 'internal/preload') {
  // Start profiling with default config
  init()

  process.on('exit', () => {
    log('Exiting gracefully...')
    log('All non-saved data would be discarded')
  })
}
