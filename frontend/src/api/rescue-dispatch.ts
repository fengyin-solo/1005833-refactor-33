import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 抢险任务的出动时限判定：列表、详情、归队清单三处共用这一份实现。
// 谁要判定都调 rescueDeadline，按任务编号取一次出队时间，页面不再各自算一遍。
//
// 超时口径（既有规则）：自最后一次出队记录起 24 小时内归队不算超时。
// 口径只在这一个常量里定义，要改就改这里，三处入口自然跟着变。
export const RESCUE_TIME_LIMIT_HOURS = 24

const RESCUE_KEY = 'rescueteam'
const DISPATCH_LOG_KEY = 'rescueteam-dispatch-log'
const RETURN_REVIEW_KEY = 'dispatchplan-return-reviews'

// 任务状态只许沿 待派队 → 抢险中 → 已归队 单向推进；已终止是终态。
// 已归队、已终止都算收拢：判定冻结，之后不再重算。
const STATUS_PENDING = '待派队'
const STATUS_DISPATCHED = '抢险中'
const STATUS_RETURNED = '已归队'
const STATUS_TERMINATED = '已终止'

export type RescueDeadline = {
  taskNo: string
  status: string
  dispatchAt: string | null // 最后一次出队时间
  deadlineAt: string | null // 时限截止时间
  overdue: boolean
  frozen: boolean // 已收拢（已归队/已终止）：判定冻结，不再重算
  verdict: string // 直接拿去展示的判定文案
}

export type RescueTaskInput = {
  任务编号: string
  任务类型: string
  目标点位: string
  抢险队: string
  负责人: string
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatDateTime(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`
}

function parseTime(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) {
    return `${days} 天 ${hours} 小时`
  }
  if (hours > 0) {
    return `${hours} 小时 ${rest} 分`
  }
  return `${rest} 分钟`
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function findTask(taskNo: string): EntryRow | undefined {
  return listRows(RESCUE_KEY).find((row) => String(row['任务编号']) === taskNo)
}

function findTaskById(id: number): EntryRow | undefined {
  return listRows(RESCUE_KEY).find((row) => Number(row.id) === id)
}

function patchTask(id: number, patch: Record<string, string | boolean>): void {
  const rows = listRows(RESCUE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return
  }
  const next = [...rows]
  next[index] = { ...rows[index], ...patch }
  saveRows(RESCUE_KEY, next)
}

// 按任务编号取一次出队时间：出队记录里最后一条为准；老数据没有记录，回退到任务单上的出队时间。
export function lastDispatchAt(taskNo: string, task?: EntryRow): string | null {
  const logs = listRows(DISPATCH_LOG_KEY).filter((row) => String(row['任务编号']) === taskNo)
  if (logs.length > 0) {
    return String(logs[logs.length - 1]['出队时间'])
  }
  const row = task ?? findTask(taskNo)
  const fallback = row ? String(row['出队时间'] ?? '').trim() : ''
  return fallback === '' ? null : fallback
}

function deadlineOf(dispatchAt: string): Date | null {
  const start = parseTime(dispatchAt)
  if (!start) {
    return null
  }
  return new Date(start.getTime() + RESCUE_TIME_LIMIT_HOURS * 3600_000)
}

// 出动时限判定唯一入口：列表、详情、归队清单读的都是它返回的同一份结果。
export function rescueDeadline(taskNo: string, now: Date = new Date()): RescueDeadline | null {
  const task = findTask(taskNo)
  if (!task) {
    return null
  }
  const status = String(task.status)
  const dispatchAt = lastDispatchAt(taskNo, task)
  const deadline = dispatchAt ? deadlineOf(dispatchAt) : null
  const base = { taskNo, status, dispatchAt, deadlineAt: deadline ? formatDateTime(deadline) : null }

  if (status === STATUS_RETURNED) {
    // 已归队：判定在归队办结时冻结在任务单上，历史记录保持原样，一律不重算。
    const verdict = String(task['超时判定'] ?? '').trim()
    return { ...base, overdue: verdict === '已超时', frozen: true, verdict: verdict || '历史记录未重算' }
  }
  if (status === STATUS_TERMINATED) {
    return { ...base, overdue: false, frozen: true, verdict: '任务已终止，不再判定' }
  }
  if (status === STATUS_PENDING) {
    return { ...base, overdue: false, frozen: false, verdict: '尚未出队，时限未起算' }
  }
  if (!dispatchAt || !deadline) {
    return { ...base, overdue: false, frozen: false, verdict: '缺出队记录，无法判定' }
  }
  const remaining = deadline.getTime() - now.getTime()
  if (remaining >= 0) {
    return { ...base, overdue: false, frozen: false, verdict: `剩余 ${formatDuration(remaining)}` }
  }
  return { ...base, overdue: true, frozen: false, verdict: `已超时 ${formatDuration(-remaining)}` }
}

// 登记抢险任务：任务编号重复提交只落一条，已存在的编号直接拒掉。
export function registerRescueTask(input: RescueTaskInput): ActionResult {
  const taskNo = input.任务编号.trim()
  if (taskNo === '') {
    return { ok: false, message: '任务编号不能为空' }
  }
  const rows = listRows(RESCUE_KEY)
  if (rows.some((row) => String(row['任务编号']) === taskNo)) {
    return { ok: false, message: `任务编号 ${taskNo} 已存在，重复提交只保留一条` }
  }
  const row: EntryRow = {
    id: nextId(rows),
    status: STATUS_PENDING,
    pending: true,
    abnormal: false,
    任务编号: taskNo,
    任务类型: input.任务类型.trim(),
    目标点位: input.目标点位.trim(),
    抢险队: input.抢险队.trim(),
    出队时间: '',
    归队时间: '',
    负责人: input.负责人.trim(),
    任务状态: STATUS_PENDING,
  }
  saveRows(RESCUE_KEY, [...rows, row])
  return { ok: true, message: `抢险任务 ${taskNo} 已登记，当前状态「${STATUS_PENDING}」` }
}

// 派出抢险：待派队 → 抢险中；抢险中再派出算重新出队，超时以最后一次出队记录为准。
export function dispatchTeam(id: number): ActionResult {
  const task = findTaskById(id)
  if (!task) {
    return { ok: false, message: `没有找到编号为 ${id} 的抢险任务` }
  }
  const status = String(task.status)
  if (status === STATUS_RETURNED || status === STATUS_TERMINATED) {
    return { ok: false, message: `任务已${status}，状态只许从待派队向已归队单向推进，不能再派出` }
  }
  const now = formatDateTime(new Date())
  const taskNo = String(task['任务编号'])
  const logs = listRows(DISPATCH_LOG_KEY)
  saveRows(DISPATCH_LOG_KEY, [
    ...logs,
    { id: nextId(logs), status: '', pending: false, abnormal: false, 任务编号: taskNo, 出队时间: now },
  ])
  patchTask(id, { status: STATUS_DISPATCHED, pending: true, 出队时间: now, 任务状态: STATUS_DISPATCHED })
  return { ok: true, message: `抢险队已派出，任务状态「${STATUS_DISPATCHED}」，时限自本次出队起算` }
}

// 确认归队：只有抢险中才能归队。办结时按最后一次出队记录算一次超时判定并冻结在任务单上，
// 结论同时落到排水调度方案的待核对清单，收拢之后不再重算。
export function confirmReturn(id: number): ActionResult {
  const task = findTaskById(id)
  if (!task) {
    return { ok: false, message: `没有找到编号为 ${id} 的抢险任务` }
  }
  const status = String(task.status)
  if (status !== STATUS_DISPATCHED) {
    return { ok: false, message: `只有「${STATUS_DISPATCHED}」的任务才能确认归队（当前「${status}」），状态单向推进不回退` }
  }
  const taskNo = String(task['任务编号'])
  const returnedAt = new Date()
  const dispatchAt = lastDispatchAt(taskNo, task)
  const deadline = dispatchAt ? deadlineOf(dispatchAt) : null
  const verdict = deadline && returnedAt.getTime() > deadline.getTime() ? '已超时' : '未超时'
  const returnedText = formatDateTime(returnedAt)
  patchTask(id, {
    status: STATUS_RETURNED,
    pending: false,
    归队时间: returnedText,
    超时判定: verdict,
    任务状态: STATUS_RETURNED,
  })
  const reviews = listRows(RETURN_REVIEW_KEY)
  saveRows(RETURN_REVIEW_KEY, [
    ...reviews,
    {
      id: nextId(reviews),
      status: '待核对',
      pending: true,
      abnormal: verdict === '已超时',
      任务编号: taskNo,
      目标点位: String(task['目标点位'] ?? ''),
      抢险队: String(task['抢险队'] ?? ''),
      负责人: String(task['负责人'] ?? ''),
      出队时间: dispatchAt ?? '',
      归队时间: returnedText,
      超时判定: verdict,
      核对状态: '待核对',
    },
  ])
  return { ok: true, message: `任务已归队，判定「${verdict}」已冻结不再重算，结论已送排水调度方案待核对清单` }
}

// 终止任务：待派队、抢险中可终止；已归队、已终止是收拢状态，不再变动。
export function terminateTask(id: number): ActionResult {
  const task = findTaskById(id)
  if (!task) {
    return { ok: false, message: `没有找到编号为 ${id} 的抢险任务` }
  }
  const status = String(task.status)
  if (status === STATUS_RETURNED || status === STATUS_TERMINATED) {
    return { ok: false, message: `任务已${status}，记录已收拢，不能再终止` }
  }
  patchTask(id, { status: STATUS_TERMINATED, pending: false, 任务状态: STATUS_TERMINATED })
  return { ok: true, message: `任务已终止，当前状态「${STATUS_TERMINATED}」` }
}

// 归队清单：已归队的任务，判定读的是冻结结果，不重算。
export function listReturnedTasks(): EntryRow[] {
  return listRows(RESCUE_KEY).filter((row) => String(row.status) === STATUS_RETURNED)
}

// 排水调度方案的待核对清单：归队办结结论都落在这里。
export function listReturnReviews(): EntryRow[] {
  return listRows(RETURN_REVIEW_KEY)
}

export function checkReturnReview(id: number): ActionResult {
  const reviews = listRows(RETURN_REVIEW_KEY)
  const index = reviews.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的归队结论` }
  }
  if (String(reviews[index]['核对状态']) === '已核对') {
    return { ok: false, message: '这条结论已经核对过了' }
  }
  const next = [...reviews]
  next[index] = { ...reviews[index], status: '已核对', pending: false, 核对状态: '已核对' }
  saveRows(RETURN_REVIEW_KEY, next)
  return { ok: true, message: '归队结论已核对' }
}
