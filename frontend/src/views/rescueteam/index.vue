<template>
  <section class="page" data-module="rescueteam">
    <header class="page-head">
      <div>
        <h2>抢险队调度管理</h2>
        <p class="page-desc">维护抢险任务，围绕任务编号、任务类型、目标点位、抢险队做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记抢险任务</button>
        <RouterLink class="btn" to="/rescueteam/returned">归队清单</RouterLink>
        <button class="btn" type="button" @click="exportRows">导出抢险队调度清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <form v-if="showCreate" class="create-panel" @submit.prevent="submitCreate">
      <label v-for="field in createFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="createForm[field]" :placeholder="`填写${field}`" />
      </label>
      <button class="btn primary" type="submit">提交登记</button>
      <button class="btn ghost" type="button" @click="closeCreate">取消</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>时限判定</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <RouterLink v-if="column === '任务编号'" :to="`/rescueteam/detail/${row.id}`">
              {{ row[column] ?? '—' }}
            </RouterLink>
            <template v-else>{{ row[column] || '—' }}</template>
          </td>
          <td>
            <span class="deadline-tag" :class="verdictClass(row)">{{ verdictOf(row).text }}</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无抢险队调度数据，可先登记抢险任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条抢险队调度记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import { loadRescueDeadlineBook } from '@/api/rescue-deadline'
import type { RescueDeadlineVerdict } from '@/api/rescue-deadline'
import {
  confirmRescueReturn,
  createRescueTask,
  dispatchRescueTask,
  terminateRescueTask,
} from '@/api/rescueteam-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('rescueteam')
const columns = ["任务编号", "任务类型", "目标点位", "抢险队", "出队时间", "归队时间", "负责人"]
const actions = ["派出抢险", "确认归队", "终止任务"]
const statuses = ["待派队", "抢险中", "已归队", "已终止"]
const createFields = ["任务编号", "任务类型", "目标点位", "抢险队", "负责人"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const showCreate = ref(false)
const createForm = ref<Record<string, string>>({ 任务编号: '', 任务类型: '', 目标点位: '', 抢险队: '', 负责人: '' })

// 时限判定每 30 秒随当前时间刷新一次，判定本身只走 rescue-deadline 这一套
const nowTick = ref(Date.now())
let timer: number | undefined

// 列表、详情、归队清单读同一份判定结果：按任务编号取一次出队时间后逐条判定
const deadlineBook = computed(() => loadRescueDeadlineBook(rows.value, nowTick.value))

const EMPTY_VERDICT: RescueDeadlineVerdict = {
  state: '未出队',
  settled: false,
  dispatchAt: '',
  deadlineAt: '',
  remainingMinutes: 0,
  text: '—',
}

function verdictOf(row: EntryRow): RescueDeadlineVerdict {
  return deadlineBook.value.get(String(row['任务编号'] ?? '')) ?? EMPTY_VERDICT
}

function verdictClass(row: EntryRow): string {
  const state = verdictOf(row).state
  if (state === '已超时' || state === '超时归队') {
    return 'is-overdue'
  }
  if (state === '计时中') {
    return 'is-counting'
  }
  if (state === '已终止' || state === '历史办结') {
    return 'is-muted'
  }
  return ''
}

const stats = computed(() => [
  { label: '待派队任务', value: rows.value.filter((row) => String(row.status) === '待派队').length },
  { label: '抢险中任务', value: rows.value.filter((row) => String(row.status) === '抢险中').length },
  { label: '已归队任务', value: rows.value.filter((row) => String(row.status) === '已归队').length },
  { label: '已超时任务', value: [...deadlineBook.value.values()].filter((verdict) => verdict.state === '已超时').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = ''
  noticeMessage.value = ''
  showCreate.value = true
}

function closeCreate() {
  showCreate.value = false
}

function submitCreate() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = createRescueTask({
    任务编号: createForm.value['任务编号'] ?? '',
    任务类型: createForm.value['任务类型'] ?? '',
    目标点位: createForm.value['目标点位'] ?? '',
    抢险队: createForm.value['抢险队'] ?? '',
    负责人: createForm.value['负责人'] ?? '',
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  showCreate.value = false
  createForm.value = { 任务编号: '', 任务类型: '', 目标点位: '', 抢险队: '', 负责人: '' }
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const id = Number(row.id)
  const result =
    action === '派出抢险'
      ? dispatchRescueTask(id)
      : action === '确认归队'
        ? confirmRescueReturn(id)
        : terminateRescueTask(id)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '抢险队调度列表读取失败'
  }
}

onMounted(() => {
  reload()
  timer = window.setInterval(() => {
    nowTick.value = Date.now()
  }, 30 * 1000)
})

onUnmounted(() => {
  if (timer !== undefined) {
    window.clearInterval(timer)
  }
})
</script>
