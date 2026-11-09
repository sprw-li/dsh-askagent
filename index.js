/**
 * User-initiated child agents on the subagent runtime.
 *
 * The Client composes the whole first prompt and posts it here; this Host half
 * creates a real continuable child Agent under the addressing Session. Children
 * keep subagent semantics: `parentSession` lineage, `origin: 'subagent'`
 * (hidden from the workspace session list), the shipped subagent sidebar chat,
 * and the ordinary Session event log (trajectory included).
 *
 * Two delivery policies are exposed:
 * - `notifyParent: false` (askagent): `delivery: 'caller'`; the settlement
 *   notice never reaches the parent. The child is additionally silenced (no
 *   `send_message` tool, silent prompt section) so it cannot wake the main
 *   conversation on its own.
 * - `notifyParent: true` (exec): `delivery: 'parent'`; the result is delivered
 *   back to the main Session and wakes its Agent.
 *
 * `POST /askagent` — JSON `{ sessionId, prompt, label?, notifyParent? }`;
 * answers `{ childId, provider, label, delivery }`.
 * `GET  /askagent/providers` — JSON `{ providers: [{ name, continuable }] }`.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * 诊断日志与「静默子代理」注册表所在目录。
 * 默认落在系统临时目录；需要持久化时用 DSH_ASKAGENT_HOME 指定。
 */
const STATE_DIR = process.env.DSH_ASKAGENT_HOME || join(tmpdir(), 'dsh-askagent')
const LOG_PATH = join(STATE_DIR, 'askagent.log')
const REGISTRY_PATH = join(STATE_DIR, 'askagent-silent.json')
const MAX_LABEL = 60
const SILENT_SECTION_ORDER = 2950

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function log(line) {
  try {
    await mkdir(dirname(LOG_PATH), { recursive: true })
    await appendFile(LOG_PATH, `${new Date().toISOString()}\t${line}\n`, 'utf8')
  } catch {
    /* diagnostics only */
  }
}

export const inject = ['webServer', 'subagents', 'agents']

export function apply(ctx) {
  void log('apply: silent-askagent')
  /** Live activations by child id; keeps their start signals owned. */
  const activations = new Map()
  /** askagent child ids that must never message or wake the parent. */
  const silentChildren = new Set()
  /** Agent contexts already silenced, so a resume re-applies exactly once. */
  const silencedCtxs = new WeakSet()
  let registryLoaded = false

  /* ---------- silent-child registry ---------- */

  async function loadRegistry() {
    if (registryLoaded) return
    registryLoaded = true
    try {
      const raw = await readFile(REGISTRY_PATH, 'utf8')
      const ids = JSON.parse(raw)
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') silentChildren.add(id)
    } catch {
      /* first run */
    }
    try {
      const raw = await readFile(LOG_PATH, 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.includes('start child=')) continue
        const idMatch = /start child=(\S+)/.exec(line)
        if (idMatch === null) continue
        const labelMatch = /label=(".*?"|\S+)/.exec(line)
        if (labelMatch !== null) {
          const label = labelMatch[1].replace(/^"|"$/g, '')
          if (label.startsWith('exec')) continue
          silentChildren.add(idMatch[1])
        } else {
          /* creations before labels existed were all askagent */
          silentChildren.add(idMatch[1])
        }
      }
    } catch {
      /* no history */
    }
    await persistRegistry()
    void log(`registry loaded silent=${silentChildren.size}`)
  }

  async function persistRegistry() {
    try {
      await mkdir(dirname(REGISTRY_PATH), { recursive: true })
      await writeFile(REGISTRY_PATH, JSON.stringify([...silentChildren].slice(-800)), 'utf8')
    } catch {
      /* best effort */
    }
  }

  /* ---------- silence one live child agent ---------- */

  /** Remove the child's ability to message the parent and tell it to stay quiet. */
  function silenceChild(childId) {
    const child = ctx.agents.get(childId)
    if (child === undefined) return false
    const agentCtx = child.ctx
    if (agentCtx === undefined) return false
    if (silencedCtxs.has(agentCtx)) return true
    silencedCtxs.add(agentCtx)
    try {
      agentCtx.tools.restrict({ deny: ['send_message'] })
    } catch (error) {
      void log(`silence restrict failed ${childId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      agentCtx.tools.guard((execution) => (execution.name === 'send_message' ? 'askagent 不向父代理发送消息' : undefined))
    } catch (error) {
      void log(`silence guard failed ${childId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      agentCtx.systemPrompt.section({
        name: 'askagent/silent',
        order: SILENT_SECTION_ORDER,
        text: [
          '【askagent】你是用户在右侧栏发起的提问子代理，因此必须保持静默：',
          '- 回答只写在本会话里，父代理不会收到；',
          '- 不要调用 send_message，也不要用任何方式向父代理发送消息、汇报或通知；',
          '- 不要等待父代理的补充输入，直接按用户问题作答。',
        ].join('\n'),
      })
    } catch (error) {
      void log(`silence section failed ${childId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    void log(`silenced child=${childId}`)
    return true
  }

  /* Re-apply on every activation, so a cold-resumed askagent stays silent. */
  try {
    ctx.on('subagent/start', (identity) => {
      try {
        if (identity === undefined || typeof identity.id !== 'string') return
        if (!silentChildren.has(identity.id)) return
        if (silenceChild(identity.id)) return
        setTimeout(() => silenceChild(identity.id), 250)
      } catch {
        /* best effort */
      }
    })
  } catch (error) {
    void log(`subscribe failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  /* ---------- spawn ---------- */

  function pickProvider() {
    let names = []
    try {
      names = ctx.subagents.list()
    } catch {
      return undefined
    }
    for (const name of names) {
      const provider = ctx.subagents.getProvider(name)
      if (provider !== undefined && typeof provider.prepareContinuable === 'function') return name
    }
    return undefined
  }

  const providers = () => {
    let names = []
    try {
      names = ctx.subagents.list()
    } catch {
      names = []
    }
    return names.map((name) => {
      const provider = ctx.subagents.getProvider(name)
      return { name, continuable: provider !== undefined && typeof provider.prepareContinuable === 'function' }
    })
  }

  async function startChild(sessionId, prompt, rawLabel, notifyParent) {
    const parent = ctx.agents.get(sessionId)
    if (parent === undefined) throw new Error('the addressing Session has no live Agent')
    if (typeof prompt !== 'string' || prompt.trim() === '') throw new Error('empty prompt')
    const provider = pickProvider()
    if (provider === undefined) throw new Error('no continuable subagent provider is registered')
    const label = String(rawLabel === undefined ? 'askagent' : rawLabel)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_LABEL) || 'askagent'
    const delivery = notifyParent === true ? 'parent' : 'caller'
    const controller = new AbortController()
    const activation = await ctx.subagents.startActivation({
      provider,
      label,
      request: {
        prompt: [{ type: 'text', text: prompt }],
        parent,
      },
      signal: controller.signal,
      delivery,
    })
    if (activation.result !== undefined && typeof activation.result.catch === 'function') activation.result.catch(() => {})
    activations.set(activation.childId, { activation, controller })
    if (delivery === 'caller') {
      silentChildren.add(activation.childId)
      void persistRegistry()
      silenceChild(activation.childId)
    }
    await log(
      `start child=${activation.childId} provider=${provider} parent=${parent.id} label=${JSON.stringify(label)} delivery=${delivery} silent=${delivery === 'caller'} promptLength=${prompt.length}`,
    )
    return { childId: activation.childId, provider, label, delivery }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/askagent',
        handler: async (req, res) => {
          const send = (code, value) => {
            res.statusCode = code
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(value))
          }
          try {
            if (req.method === 'GET') {
              send(200, { providers: providers(), silent: [...silentChildren] })
              return
            }
            if (req.method !== 'POST') {
              send(405, { error: 'POST only' })
              return
            }
            const raw = await readBody(req)
            let body
            try {
              body = JSON.parse(raw)
            } catch {
              send(400, { error: 'invalid JSON body' })
              return
            }
            const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
            const prompt = typeof body?.prompt === 'string' ? body.prompt : ''
            if (sessionId === '') {
              send(400, { error: 'missing sessionId' })
              return
            }
            const created = await startChild(sessionId, prompt, body?.label, body?.notifyParent === true)
            send(200, created)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            await log(`error ${message}`)
            send(500, { error: message })
          }
        },
      }),
    'askagent: spawn route',
  )

  ctx.effect(() => {
    void loadRegistry()
    return () => {
      for (const { controller } of activations.values()) {
        try {
          controller.abort()
        } catch {
          /* best effort */
        }
      }
      activations.clear()
    }
  }, 'askagent: lifecycle')
}
