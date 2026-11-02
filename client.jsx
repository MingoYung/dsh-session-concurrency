import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TYPERT_REMOTE } from './remote.js'

export const name = 'dsh-session-concurrency-client'
export const inject = ['slots', 'remote', 'sessions']

const CSS = `
.dsh-sc-button{box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;flex:none;height:26px;padding:2px 8px;border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.dsh-sc-button:hover,.dsh-sc-button[aria-expanded="true"]{background:var(--dsw-alias-button-floating-fill,rgba(128,128,128,.13));color:var(--dsw-alias-label-primary,inherit)}
.dsh-sc-button:focus-visible,.dsh-sc-panel button:focus-visible,.dsh-sc-panel input:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#38a9b2);outline-offset:3px}
.dsh-sc-button:disabled,.dsh-sc-panel button:disabled{cursor:default;opacity:.55}
.dsh-sc-dot{width:5px;height:5px;flex:none;border-radius:50%;background:#d36a49}
.dsh-sc-panel{box-sizing:border-box;position:fixed;z-index:2147483000;max-width:calc(100vw - 24px);width:312px;padding:16px;border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));border-radius:14px;background:var(--dsw-alias-background-primary,#fff);color:var(--dsw-alias-label-primary,#222);box-shadow:0 8px 32px rgba(0,0,0,.2);font-family:inherit;font-size:13px;line-height:1.5}
body[data-ds-dark-theme] .dsh-sc-panel{background:var(--dsw-static-neutral-850,#252525);color:var(--dsw-alias-label-primary,#eee)}
.dsh-sc-title{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:2px;font-size:14px;font-weight:600}
.dsh-sc-close{display:grid;place-items:center;width:24px;height:24px;flex:none;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,inherit);font:inherit;font-size:18px;cursor:pointer}
.dsh-sc-close:hover{background:rgba(128,128,128,.12)}
.dsh-sc-muted{color:var(--dsw-alias-label-tertiary,#808080);font-size:12px}
.dsh-sc-mode{display:flex;gap:4px;padding:3px;margin:14px 0;border-radius:8px;background:rgba(128,128,128,.1)}
.dsh-sc-mode button{flex:1;min-height:28px;padding:4px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;cursor:pointer}
.dsh-sc-mode button[aria-pressed="true"]{background:var(--dsw-alias-button-floating-fill,rgba(128,128,128,.18));color:var(--dsw-alias-label-primary,inherit);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.dsh-sc-value{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:8px}
.dsh-sc-value output{font-size:23px;font-weight:600;font-variant-numeric:tabular-nums}
.dsh-sc-range{display:block;width:100%;margin:0;accent-color:var(--dsw-alias-state-business-primary,#259ba4);cursor:pointer}
.dsh-sc-ticks{display:flex;justify-content:space-between;margin:5px 1px 0;color:var(--dsw-alias-label-tertiary,#808080);font-size:11px;font-variant-numeric:tabular-nums}
.dsh-sc-help{min-height:38px;margin:12px 0 0;color:var(--dsw-alias-label-secondary,inherit);font-size:12px}
.dsh-sc-status{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:12px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));color:var(--dsw-alias-label-tertiary,#808080);font-size:11px;font-variant-numeric:tabular-nums}
.dsh-sc-feedback{margin:10px 0 0;color:var(--dsw-alias-label-tertiary,#808080);font-size:12px;overflow-wrap:anywhere}
.dsh-sc-feedback[data-error="true"]{color:var(--dsw-alias-state-danger-primary,#d36a49)}
.dsh-sc-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:14px}
.dsh-sc-apply{min-width:68px;min-height:30px;padding:5px 12px;border:0;border-radius:8px;background:var(--dsw-alias-state-business-primary,#259ba4);color:white;font:inherit;font-size:12px;font-weight:500;cursor:pointer}
`

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function normalizeState(response) {
  // Typed DSH Remote unary calls return RemoteResult<T>. Accepting the plain
  // business shape as well keeps the component usable in isolated UI checks.
  if (response && response.ok === false) {
    throw new Error(response.error?.message || '无法读取会话并发设置')
  }
  const state = response && response.ok === true ? response.value : response
  if (!state || (state.limit !== null && (!Number.isInteger(state.limit) || state.limit < 1 || state.limit > 10))) {
    throw new Error('Host 返回了无效的并发额度')
  }
  const count = key => Number.isFinite(state[key]) && state[key] >= 0 ? state[key] : 0
  return {
    limit: state.limit, active: count('active'), queued: count('queued'), waiting: count('waiting'),
    trackedChildren: count('trackedChildren'), parkedChildren: count('parkedChildren'),
    monitorMode: state.monitorMode,
    hostCapacity: Number.isInteger(state.hostCapacity) && state.hostCapacity > 0 ? state.hostCapacity : null,
  }
}

export function ConcurrencyControl({ sessionId, readState, saveLimit }) {
  const [state, setState] = useState(null)
  const [draft, setDraft] = useState(null)
  const [custom, setCustom] = useState(1)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [position, setPosition] = useState({ left: 12, top: 12, visibility: 'hidden' })
  const trigger = useRef(null)
  const panel = useRef(null)
  const epoch = useRef(0)
  const request = useRef(0)
  const busy = useRef(false)
  const writeFailure = useRef(false)
  const readRef = useRef(readState)
  const saveRef = useRef(saveLimit)
  readRef.current = readState
  saveRef.current = saveLimit

  const refresh = useCallback(async (adoptDraft = false) => {
    const generation = epoch.current
    const invocation = ++request.current
    try {
      const value = normalizeState(await readRef.current())
      if (generation !== epoch.current || invocation !== request.current) return
      setState(value)
      if (!writeFailure.current) setError('')
      if (adoptDraft) {
        setDraft(value.limit)
        if (value.limit !== null) setCustom(value.limit)
      }
    } catch (reason) {
      if (generation !== epoch.current || invocation !== request.current) return
      if (!writeFailure.current) setError(errorText(reason))
    } finally {
      if (generation === epoch.current && invocation === request.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    ++epoch.current
    ++request.current
    busy.current = false
    writeFailure.current = false
    setState(null)
    setDraft(null)
    setCustom(1)
    setOpen(false)
    setLoading(true)
    setSaving(false)
    setError('')
    setFeedback('')
    void refresh(true)
    return () => { ++epoch.current; ++request.current }
  }, [sessionId, refresh])

  // Status is read only while the controls are open. It does not send model
  // requests and does not keep a background timer for every retained Session.
  useEffect(() => {
    if (!open) return undefined
    const timer = window.setInterval(() => {
      if (!busy.current) void refresh(false)
    }, 1800)
    return () => window.clearInterval(timer)
  }, [open, refresh])

  const dismiss = useCallback((restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus()
  }, [])

  useLayoutEffect(() => {
    if (!open) return undefined
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect()
      const popover = panel.current
      if (!anchor || !popover) return
      const width = Math.min(312, window.innerWidth - 24)
      const height = popover.offsetHeight
      const left = Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))
      const above = anchor.top - height - 8
      const top = above >= 12 ? above : Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - height - 12))
      setPosition({ left, top, visibility: 'visible' })
    }
    place()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null
    if (panel.current) observer?.observe(panel.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    const outside = event => {
      if (panel.current?.contains(event.target) || trigger.current?.contains(event.target)) return
      dismiss()
    }
    const escape = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      dismiss(true)
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open, dismiss])

  const toggle = () => {
    if (open) { dismiss(); return }
    setDraft(state?.limit ?? null)
    if (state?.limit !== null && state?.limit !== undefined) setCustom(state.limit)
    setFeedback('')
    setPosition(previous => ({ ...previous, visibility: 'hidden' }))
    setOpen(true)
    void refresh(state === null)
  }

  const apply = async () => {
    if (busy.current || state === null) return
    busy.current = true
    writeFailure.current = false
    setSaving(true)
    setError('')
    setFeedback('')
    const generation = epoch.current
    ++request.current // a preceding status read must not overwrite this write
    const selected = draft
    try {
      const value = normalizeState(await saveRef.current(selected))
      if (generation !== epoch.current) return
      setState(value)
      setDraft(value.limit)
      setFeedback(value.limit === null ? '已恢复为此会话的宿主默认规则' : `已应用：此会话并发 ${value.limit}`)
    } catch (reason) {
      if (generation === epoch.current) {
        writeFailure.current = true
        setError(errorText(reason))
      }
    } finally {
      if (generation === epoch.current) {
        busy.current = false
        setSaving(false)
      }
    }
  }

  const label = state === null ? (loading ? '…' : '未连接') : (state.limit ?? '默认')
  const changed = state !== null && draft !== state.limit
  const titleId = `dsh-sc-title-${sessionId}`
  const helpId = `dsh-sc-help-${sessionId}`

  return <>
    <button
      ref={trigger}
      type="button"
      className="dsh-sc-button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`当前会话 Agent 并发：${label}`}
      title={error || '设置当前会话的 Agent 并发额度（包含主 Agent）'}
      onClick={toggle}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        <circle cx="6" cy="4" r="1.5" fill="currentColor" /><circle cx="10" cy="8" r="1.5" fill="currentColor" /><circle cx="6" cy="12" r="1.5" fill="currentColor" />
      </svg>
      <span>并发 {label}</span>
      {error && <span className="dsh-sc-dot" aria-hidden="true" />}
    </button>
    {open && createPortal(<section
      ref={panel}
      className="dsh-sc-panel"
      style={position}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={helpId}
      onKeyDown={event => { if (event.key === 'Enter') event.stopPropagation() }}
    >
      <div className="dsh-sc-title"><span id={titleId}>Agent 并发</span><button type="button" className="dsh-sc-close" aria-label="关闭并发设置" onClick={() => dismiss(true)}>×</button></div>
      <div className="dsh-sc-muted">仅当前会话 · 主、子 Agent 共用推理额度</div>
      <div className="dsh-sc-mode" role="group" aria-label="并发设置方式">
        <button type="button" aria-pressed={draft !== null} disabled={saving || state === null} onClick={() => { setDraft(custom); setFeedback('') }}>自定义</button>
        <button type="button" aria-pressed={draft === null} disabled={saving || state === null} onClick={() => { setDraft(null); setFeedback('') }}>宿主默认</button>
      </div>
      <div className="dsh-sc-value"><span>{draft === null ? '沿用宿主规则' : '最多同时推理'}</span><output aria-live="polite">{draft === null ? '默认' : draft}</output></div>
      <input
        className="dsh-sc-range"
        type="range"
        min="1"
        max="10"
        step="1"
        value={draft ?? custom}
        disabled={saving || state === null || draft === null}
        aria-label="当前会话最大同时推理数"
        aria-valuetext={`最多 ${draft ?? custom} 个推理请求，包含主 Agent`}
        onChange={event => { const value = Number(event.target.value); setCustom(value); setDraft(value); setFeedback('') }}
      />
      <div className="dsh-sc-ticks" aria-hidden="true"><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>6</span><span>7</span><span>8</span><span>9</span><span>10</span></div>
      <p id={helpId} className="dsh-sc-help">{draft === null ? '沿用宿主的派发与并发规则。其他会话的设置不受影响。' : draft === 1 ? '单通道：按子任务分支顺序运行，主 Agent 让出通道。完成或失败后由宿主交回结果，无需模型轮询。' : '超出额度的推理请求等待，工具 I/O 可重叠；等待子任务的 Agent 不占推理名额。'}</p>
      {state && state.active > 0 && draft !== null && <p className="dsh-sc-feedback">进行中的推理会完成，新额度约束后续请求。</p>}
      {state && <div className="dsh-sc-status" aria-label="当前会话调度状态"><span>推理中 {state.active}</span><span>排队 Agent {state.queued}</span><span>让位等待 {state.waiting}</span><span>未结束子任务 {state.trackedChildren}</span></div>}
      {state?.limit === 1 && <p className="dsh-sc-feedback">{state.monitorMode === 'native' ? '后台监控：原生事件即时响应，每 5 秒校准任务状态，不占模型通道。' : '后台监控：使用原生事件；此宿主不支持运行状态补接。'}</p>}
      {state?.parkedChildren > 0 && <p className="dsh-sc-feedback">{state.parkedChildren} 个子任务已暂停并保留待处理输入；未自动重启，也未标记完成。</p>}
      {state?.hostCapacity !== null && state?.hostCapacity !== undefined && <p className="dsh-sc-feedback">宿主最多驻留 {state.hostCapacity} 个子 Agent，与推理额度独立。</p>}
      {(error || feedback || loading) && <p className="dsh-sc-feedback" data-error={Boolean(error)} role={error ? 'alert' : 'status'}>{error || feedback || '正在读取会话设置…'}</p>}
      <div className="dsh-sc-footer"><span className="dsh-sc-muted">{changed ? '应用后生效' : '已保存的设置会随会话保留'}</span><button type="button" className="dsh-sc-apply" disabled={saving || state === null || !changed} onClick={() => void apply()}>{saving ? '应用中…' : '应用'}</button></div>
    </section>, document.body)}
  </>
}

function SessionConcurrencyEntry(props) {
  if (props.inherited) {
    return <span title="子 Agent 继承主会话的并发设置；请在主会话调整。"><button type="button" className="dsh-sc-button" disabled aria-label="子 Agent 继承主会话的并发设置">并发 继承</button></span>
  }
  return <ConcurrencyControl {...props} />
}

/** Register into the native session-scoped left composer toolbar. */
export async function apply(ctx) {
  // The namespace is installed by this contribution, so it cannot appear in
  // this plugin's inject list before apply gets the opportunity to mount it.
  await ctx.remote.$mount(TYPERT_REMOTE)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.pluginCss = 'dsh-session-concurrency'
    style.textContent = CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'session-concurrency: toolbar styles')

  ctx.inject(['remote.sessionConcurrency'], toolbarCtx => {
    toolbarCtx.slots.inject('conversation.input.left', () => toolbarCtx.slots.register({
      name: 'conversation.input.left',
      id: 'dsh-session-concurrency',
      order: 70,
      inject: sessionId => ({
        inherited: toolbarCtx.sessions.subagentAddress(sessionId) !== undefined,
        readState: () => toolbarCtx.remote.sessionConcurrency.get({ sessionId }),
        saveLimit: limit => toolbarCtx.remote.sessionConcurrency.set({ sessionId, limit }),
      }),
    }, SessionConcurrencyEntry))
  })
}

export default { name, inject, apply }
