import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 抢险任务出动时限判定：全系统只有这一份实现。
// 列表、详情、归队清单三个入口都读这里的结果，改口径只改这个文件。
//
// 既有口径：
// - 抢险队出队后 RESCUE_DISPATCH_LIMIT_HOURS 小时内应归队办结，超出记为超时；
// - 超时以最后一次出队记录为准（再次出队重新起算）；
// - 已归队的任务在归队那一刻定格结论，之后保持原样、不再重算；
// - 已终止的任务不再计时。
export const RESCUE_DISPATCH_LIMIT_HOURS = 4

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const LIMIT_MS = RESCUE_DISPATCH_LIMIT_HOURS * HOUR_MS

// 出队记录单独落库：同一任务编号可能多次出队，判定时只取最后一次。
export const DISPATCH_LOG_KEY = 'rescueteamDispatches'

export type RescueDeadlineState =
  | '未出队'
  | '计时中'
  | '已超时'
  | '按时归队'
  | '超时归队'
  | '未计时办结'
  | '历史办结'
  | '已终止'

export type RescueDeadlineVerdict = {
  /** 判定结论 */
  state: RescueDeadlineState
  /** true 表示结论已定格（归队办结或任务终止），之后不再随时间重算 */
  settled: boolean
  /** 判定采用的最后一次出队时间，未出队时为 '' */
  dispatchAt: string
  /** 应归队时刻，未出队或已定格时为 '' */
  deadlineAt: string
  /** 剩余分钟：计时中为正、已超时为负、其余为 0 */
  remainingMinutes: number
  /** 三个入口统一展示的文本 */
  text: string
}

/** 解析「YYYY-MM-DD」或「YYYY-MM-DD HH:mm」，非法输入返回 null。 */
export function parseMoment(text: string): number | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text.trim())
  if (!matched) {
    return null
  }
  const [, year, month, day, hour = '0', minute = '0', second = '0'] = matched
  const at = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  return Number.isNaN(at.getTime()) ? null : at.getTime()
}

/** 统一落成「YYYY-MM-DD HH:mm」，出队、归队、办结都用这个格式。 */
export function formatMoment(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function humanDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / MINUTE_MS))
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []
  if (days > 0) {
    parts.push(`${days} 天`)
  }
  if (hours > 0) {
    parts.push(`${hours} 小时`)
  }
  if (parts.length === 0 || minutes > 0) {
    parts.push(`${minutes} 分钟`)
  }
  return parts.join(' ')
}

type DispatchRecord = { taskNo: string; at: string; seq: number }

function readDispatchLog(): DispatchRecord[] {
  return listRows(DISPATCH_LOG_KEY)
    .map((row) => ({
      taskNo: String(row['任务编号'] ?? ''),
      at: String(row['出队时间'] ?? ''),
      seq: Number(row['出队次第'] ?? 0),
    }))
    .filter((record) => record.taskNo !== '')
}

/**
 * 出队记录按任务编号归拢，每个编号只留最后一次。
 * 出队记录只读这一次，列表、详情、归队清单共用归拢结果。
 */
export function lastDispatchByTaskNo(): Map<string, string> {
  const latest = new Map<string, DispatchRecord>()
  for (const record of readDispatchLog()) {
    const prev = latest.get(record.taskNo)
    if (!prev || record.seq > prev.seq || (record.seq === prev.seq && record.at >= prev.at)) {
      latest.set(record.taskNo, record)
    }
  }
  return new Map([...latest.entries()].map(([taskNo, record]) => [taskNo, record.at]))
}

/** 判定一条任务。已归队的只认定格结论，历史记录没有结论就保持原样、不重算。 */
export function judgeRescueDeadline(input: {
  status: string
  /** 已归队任务在归队时定格的办结结论 */
  conclusion?: string
  /** 最后一次出队时间 */
  dispatchAt?: string
  /** 判定时刻（归队办结时传归队时间戳），默认当前 */
  now?: number
}): RescueDeadlineVerdict {
  const status = input.status
  const conclusion = (input.conclusion ?? '').trim()
  const dispatchAt = (input.dispatchAt ?? '').trim()

  if (status === '已终止') {
    return { state: '已终止', settled: true, dispatchAt, deadlineAt: '', remainingMinutes: 0, text: '任务已终止，不再计时' }
  }
  if (status === '已归队') {
    if (conclusion === '按时归队' || conclusion === '超时归队' || conclusion === '未计时办结') {
      return { state: conclusion, settled: true, dispatchAt, deadlineAt: '', remainingMinutes: 0, text: `已办结：${conclusion}` }
    }
    // 历史记录：归队时没有定格结论，保持原样，不按新口径补算
    return { state: '历史办结', settled: true, dispatchAt, deadlineAt: '', remainingMinutes: 0, text: '历史办结记录，不再重算' }
  }

  const start = dispatchAt === '' ? null : parseMoment(dispatchAt)
  if (start === null) {
    return { state: '未出队', settled: false, dispatchAt: '', deadlineAt: '', remainingMinutes: 0, text: '未出队，尚未计时' }
  }
  const now = input.now ?? Date.now()
  const deadline = start + LIMIT_MS
  const remain = deadline - now
  const deadlineAt = formatMoment(deadline)
  if (remain >= 0) {
    return {
      state: '计时中',
      settled: false,
      dispatchAt,
      deadlineAt,
      remainingMinutes: Math.ceil(remain / MINUTE_MS),
      text: `剩余 ${humanDuration(remain)}`,
    }
  }
  return {
    state: '已超时',
    settled: false,
    dispatchAt,
    deadlineAt,
    remainingMinutes: Math.floor(remain / MINUTE_MS),
    text: `已超时 ${humanDuration(-remain)}`,
  }
}

/** 归队办结时把进行中的判定定格成结论，收拢后不再重算。 */
export function conclusionForReturn(verdict: RescueDeadlineVerdict): string {
  if (verdict.state === '已超时') {
    return '超时归队'
  }
  if (verdict.state === '计时中') {
    return '按时归队'
  }
  return '未计时办结'
}

/**
 * 一批任务的判定结果，按任务编号取一次出队时间后逐条判定。
 * 列表、详情、归队清单都从这里读同一份结果。
 */
export function loadRescueDeadlineBook(tasks: EntryRow[], now: number = Date.now()): Map<string, RescueDeadlineVerdict> {
  const lastByTaskNo = lastDispatchByTaskNo()
  const book = new Map<string, RescueDeadlineVerdict>()
  for (const task of tasks) {
    const taskNo = String(task['任务编号'] ?? '')
    // 出队记录里没有的老数据，回退到任务单上的出队时间
    const dispatchAt = lastByTaskNo.get(taskNo) ?? String(task['出队时间'] ?? '')
    book.set(
      taskNo,
      judgeRescueDeadline({
        status: String(task.status ?? ''),
        conclusion: String(task['办结结论'] ?? ''),
        dispatchAt,
        now,
      }),
    )
  }
  return book
}
