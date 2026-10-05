import {
  DISPATCH_LOG_KEY,
  conclusionForReturn,
  formatMoment,
  judgeRescueDeadline,
  lastDispatchByTaskNo,
} from '@/api/rescue-deadline'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 抢险任务的写侧规则都收在这里：登记、派出、归队、终止，页面不做业务判断。
// 任务状态只许单向推进：待派队 → 抢险中 → 已归队；已终止为终态，已归队/已终止都不再变动。
const MODULE_KEY = 'rescueteam'

// 归队办结结论的落脚处：排水调度方案的待核对清单。
export const PLAN_CHECK_KEY = 'dispatchplanChecks'

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function findTask(id: number): { rows: EntryRow[]; index: number } | null {
  const rows = listRows(MODULE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  return index < 0 ? null : { rows, index }
}

function replaceTask(rows: EntryRow[], index: number, updated: EntryRow): void {
  const next = [...rows]
  next[index] = updated
  saveRows(MODULE_KEY, next)
}

export function getRescueTask(id: number): EntryRow | null {
  const found = findTask(id)
  return found ? found.rows[found.index] : null
}

/** 同一任务编号的出队记录，按出队次第倒序（最后一次在最前）。 */
export function listDispatchRecords(taskNo: string): EntryRow[] {
  return listRows(DISPATCH_LOG_KEY)
    .filter((row) => String(row['任务编号'] ?? '') === taskNo)
    .sort((a, b) => Number(b['出队次第'] ?? 0) - Number(a['出队次第'] ?? 0))
}

/** 归队清单：只收已归队的任务。 */
export function listReturnedTasks(): EntryRow[] {
  return listRows(MODULE_KEY).filter((row) => String(row.status) === '已归队')
}

export type CreateRescueTaskInput = {
  任务编号: string
  任务类型: string
  目标点位: string
  抢险队: string
  负责人: string
}

/** 登记抢险任务：任务编号重复提交只落一条，已存在的编号不新增。 */
export function createRescueTask(input: CreateRescueTaskInput): ActionResult {
  const taskNo = input.任务编号.trim()
  if (taskNo === '') {
    return { ok: false, message: '任务编号不能为空' }
  }
  const rows = listRows(MODULE_KEY)
  if (rows.some((row) => String(row['任务编号'] ?? '') === taskNo)) {
    return { ok: true, message: `任务编号 ${taskNo} 已登记，重复提交只落一条，未新增记录` }
  }
  const row: EntryRow = {
    id: nextId(rows),
    status: '待派队',
    pending: true,
    abnormal: false,
    任务编号: taskNo,
    任务类型: input.任务类型.trim(),
    目标点位: input.目标点位.trim(),
    抢险队: input.抢险队.trim(),
    出队时间: '',
    归队时间: '',
    负责人: input.负责人.trim(),
    任务状态: '待派队',
  }
  saveRows(MODULE_KEY, [...rows, row])
  return { ok: true, message: `抢险任务 ${taskNo} 已登记，当前状态「待派队」` }
}

/** 派出抢险：待派队 → 抢险中；抢险中再次派出会追加一条出队记录，超时以最后一次出队记录为准。 */
export function dispatchRescueTask(id: number): ActionResult {
  const found = findTask(id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的抢险任务` }
  }
  const { rows, index } = found
  const row = rows[index]
  const status = String(row.status)
  if (status === '已归队' || status === '已终止') {
    return { ok: false, message: `任务已${status}，状态单向推进，不能再派出` }
  }
  const taskNo = String(row['任务编号'] ?? '')
  const now = Date.now()
  const dispatchAt = formatMoment(now)
  const log = listRows(DISPATCH_LOG_KEY)
  const seq = log.filter((record) => String(record['任务编号'] ?? '') === taskNo).length + 1
  const record: EntryRow = {
    id: nextId(log),
    status: '已记录',
    pending: false,
    abnormal: false,
    任务编号: taskNo,
    出队时间: dispatchAt,
    出队次第: seq,
  }
  saveRows(DISPATCH_LOG_KEY, [...log, record])
  replaceTask(rows, index, {
    ...row,
    status: '抢险中',
    任务状态: '抢险中',
    出队时间: dispatchAt,
    pending: true,
    abnormal: false,
  })
  const again = seq > 1 ? '，超时以最后一次出队记录为准' : ''
  return { ok: true, message: `抢险队已出队（第 ${seq} 次）${again}，当前状态「抢险中」` }
}

/** 确认归队：仅抢险中可办结；办结结论在归队时定格，并落到排水调度方案的待核对清单。 */
export function confirmRescueReturn(id: number): ActionResult {
  const found = findTask(id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的抢险任务` }
  }
  const { rows, index } = found
  const row = rows[index]
  const status = String(row.status)
  if (status === '待派队') {
    return { ok: false, message: '任务尚未派出，不能确认归队' }
  }
  if (status !== '抢险中') {
    return { ok: false, message: `任务已${status}，状态单向推进，不再重复办结` }
  }
  const taskNo = String(row['任务编号'] ?? '')
  const now = Date.now()
  // 超时以最后一次出队记录为准；老数据没有出队记录时回退任务单上的出队时间
  const dispatchAt = lastDispatchByTaskNo().get(taskNo) ?? String(row['出队时间'] ?? '')
  const verdict = judgeRescueDeadline({ status: '抢险中', dispatchAt, now })
  const conclusion = conclusionForReturn(verdict)
  const returnAt = formatMoment(now)
  const updated: EntryRow = {
    ...row,
    status: '已归队',
    任务状态: '已归队',
    归队时间: returnAt,
    // 办结结论在此定格：之后列表、详情、归队清单都读这个结论，不再重算
    办结结论: conclusion,
    pending: false,
    abnormal: conclusion === '超时归队',
  }
  replaceTask(rows, index, updated)
  appendPlanCheck(updated, dispatchAt)
  return { ok: true, message: `任务已归队办结（${conclusion}），结论已落到排水调度方案待核对清单` }
}

/** 终止任务：待派队、抢险中可终止；已归队、已终止为终态，不再变动。 */
export function terminateRescueTask(id: number): ActionResult {
  const found = findTask(id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的抢险任务` }
  }
  const { rows, index } = found
  const row = rows[index]
  const status = String(row.status)
  if (status === '已归队' || status === '已终止') {
    return { ok: false, message: `任务已${status}，状态单向推进，不能终止` }
  }
  replaceTask(rows, index, {
    ...row,
    status: '已终止',
    任务状态: '已终止',
    pending: false,
    abnormal: true,
  })
  return { ok: true, message: '任务已终止，不再计时' }
}

function appendPlanCheck(task: EntryRow, dispatchAt: string): void {
  const checks = listRows(PLAN_CHECK_KEY)
  const row: EntryRow = {
    id: nextId(checks),
    status: '待核对',
    pending: true,
    abnormal: String(task['办结结论'] ?? '') === '超时归队',
    任务编号: String(task['任务编号'] ?? ''),
    目标点位: String(task['目标点位'] ?? ''),
    抢险队: String(task['抢险队'] ?? ''),
    负责人: String(task['负责人'] ?? ''),
    最后出队时间: dispatchAt,
    归队时间: String(task['归队时间'] ?? ''),
    办结结论: String(task['办结结论'] ?? ''),
  }
  saveRows(PLAN_CHECK_KEY, [...checks, row])
}

/** 排水调度方案的待核对清单：归队办结结论都落在这里。 */
export function listPlanChecks(): EntryRow[] {
  return listRows(PLAN_CHECK_KEY)
}

export function confirmPlanCheck(id: number): ActionResult {
  const rows = listRows(PLAN_CHECK_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: '没有找到这条待核对记录' }
  }
  if (String(rows[index].status) === '已核对') {
    return { ok: false, message: '这条结论已核对过，不用重复操作' }
  }
  const next = [...rows]
  next[index] = { ...rows[index], status: '已核对', pending: false }
  saveRows(PLAN_CHECK_KEY, next)
  return { ok: true, message: '归队办结结论已核对' }
}
