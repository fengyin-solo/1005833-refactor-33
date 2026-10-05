<template>
  <section class="page" data-module="rescueteam">
    <header class="page-head">
      <div>
        <h2>抢险队调度管理</h2>
        <p class="page-desc">维护抢险任务，围绕任务编号、任务类型、目标点位、抢险队做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记抢险任务</button>
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

    <form v-if="creating" class="filter-bar" @submit.prevent="submitCreate">
      <label v-for="field in createFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="createForm[field]" :placeholder="`填写${field}`" />
      </label>
      <button class="btn primary" type="submit">提交登记</button>
      <button class="btn ghost" type="button" @click="cancelCreate">取消</button>
    </form>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>出动时限</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td :class="{ 'error-text': deadlineOf(row)?.overdue }">{{ deadlineOf(row)?.verdict ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
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

    <section v-if="detail" class="detail-panel">
      <h3 class="section-title">任务详情 · {{ detail.taskNo }}</h3>
      <dl class="detail-grid">
        <template v-for="column in columns" :key="column">
          <dt>{{ column }}</dt>
          <dd>{{ detailRow?.[column] ?? '—' }}</dd>
        </template>
        <dt>最后一次出队</dt>
        <dd>{{ detail.dispatchAt ?? '—' }}</dd>
        <dt>时限截止</dt>
        <dd>{{ detail.deadlineAt ?? '—' }}</dd>
        <dt>出动时限判定</dt>
        <dd :class="{ 'error-text': detail.overdue }">{{ detail.verdict }}</dd>
        <dt>判定状态</dt>
        <dd>{{ detail.frozen ? '已冻结，不再重算' : '进行中，实时判定' }}</dd>
      </dl>
      <button class="btn ghost" type="button" @click="closeDetail">收起详情</button>
    </section>

    <h3 class="section-title">归队清单</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>任务编号</th>
          <th>目标点位</th>
          <th>抢险队</th>
          <th>最后一次出队</th>
          <th>归队时间</th>
          <th>超时判定</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in returnedRows" :key="String(row.id)">
          <td>{{ row['任务编号'] }}</td>
          <td>{{ row['目标点位'] }}</td>
          <td>{{ row['抢险队'] }}</td>
          <td>{{ deadlineOf(row)?.dispatchAt ?? '—' }}</td>
          <td>{{ row['归队时间'] || '—' }}</td>
          <td :class="{ 'error-text': deadlineOf(row)?.overdue }">{{ deadlineOf(row)?.verdict ?? '—' }}</td>
        </tr>
        <tr v-if="!returnedRows.length">
          <td colspan="6" class="empty-state">暂无已归队任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条抢险队调度记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import {
  confirmReturn,
  dispatchTeam,
  listReturnedTasks,
  registerRescueTask,
  rescueDeadline,
  terminateTask,
  type RescueDeadline,
} from '@/api/rescue-dispatch'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('rescueteam')
const columns = ["任务编号", "任务类型", "目标点位", "抢险队", "出队时间", "归队时间", "负责人", "任务状态"]
const actions = ["派出抢险", "确认归队", "终止任务"]
const statuses = ["待派队", "抢险中", "已归队", "已终止"]
const stats = [{"label": "待派队任务", "value": 0}, {"label": "抢险中任务", "value": 0}, {"label": "已归队任务", "value": 0}]

const rows = ref<EntryRow[]>([])
const returnedRows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const creating = ref(false)
const createFields = ["任务编号", "任务类型", "目标点位", "抢险队", "负责人"]
const createForm = ref<Record<string, string>>({})
const detail = ref<RescueDeadline | null>(null)
const detailRow = ref<EntryRow | null>(null)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 列表、详情、归队清单都走这一个判定入口，同一张任务单在三处看到的结果一致。
function deadlineOf(row: EntryRow): RescueDeadline | null {
  return rescueDeadline(String(row['任务编号'] ?? ''))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = ''
  creating.value = true
}

function cancelCreate() {
  creating.value = false
  createForm.value = {}
}

function submitCreate() {
  errorMessage.value = ''
  const result = registerRescueTask({
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
  cancelCreate()
  reload()
}

function openDetail(row: EntryRow) {
  detailRow.value = row
  detail.value = deadlineOf(row)
}

function closeDetail() {
  detailRow.value = null
  detail.value = null
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const id = Number(row.id)
  const result =
    action === '派出抢险'
      ? dispatchTeam(id)
      : action === '确认归队'
        ? confirmReturn(id)
        : terminateTask(id)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    returnedRows.value = listReturnedTasks()
    if (detail.value) {
      const taskNo = detail.value.taskNo
      detailRow.value = listEntries(meta.key).items.find((row) => String(row['任务编号']) === taskNo) ?? null
      detail.value = detailRow.value ? rescueDeadline(taskNo) : null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '抢险队调度列表读取失败'
  }
}

onMounted(reload)
</script>
