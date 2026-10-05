<template>
  <section class="page" data-module="dispatchplan">
    <header class="page-head">
      <div>
        <h2>排水调度方案管理</h2>
        <p class="page-desc">维护调度方案，围绕方案编号、方案名称、适用雨型、涉及泵站做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记调度方案</button>
        <button class="btn" type="button" @click="exportRows">导出排水调度方案清单</button>
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

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无排水调度方案数据，可先登记调度方案</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条排水调度方案记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="check-section">
      <h3 class="section-title">归队办结待核对清单</h3>
      <p class="page-desc">抢险任务归队办结的结论自动落到此处，核对后不再重复提示。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in checkColumns" :key="column">{{ column }}</th>
            <th>核对状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in checks" :key="String(row.id)">
            <td v-for="column in checkColumns" :key="column">{{ row[column] || '—' }}</td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <button
                v-if="row.status === '待核对'"
                class="link"
                type="button"
                @click="checkRow(row)"
              >
                确认核对
              </button>
              <span v-else>—</span>
            </td>
          </tr>
          <tr v-if="!checks.length">
            <td :colspan="checkColumns.length + 2" class="empty-state">暂无待核对的归队办结结论</td>
          </tr>
        </tbody>
      </table>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { confirmPlanCheck, listPlanChecks } from '@/api/rescueteam-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('dispatchplan')
const columns = ["方案编号", "方案名称", "适用雨型", "涉及泵站", "编制人", "审核人", "生效日期", "方案状态"]
const actions = ["提交编制", "批准方案", "废止方案"]
const statuses = ["待编制", "待审核", "已批准", "已废止"]
const checkColumns = ["任务编号", "目标点位", "抢险队", "最后出队时间", "归队时间", "办结结论"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
// 抢险任务归队办结的结论落在这里，等待核对
const checks = ref<EntryRow[]>([])
const stats = computed(() => [
  { label: '待编制方案', value: rows.value.filter((row) => String(row.status) === '待编制').length },
  { label: '待审核方案', value: rows.value.filter((row) => String(row.status) === '待审核').length },
  { label: '已批准方案', value: rows.value.filter((row) => String(row.status) === '已批准').length },
  { label: '待核对结论', value: checks.value.filter((row) => String(row.status) === '待核对').length },
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
  errorMessage.value = '调度方案登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function checkRow(row: EntryRow) {
  errorMessage.value = ''
  const result = confirmPlanCheck(Number(row.id))
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
    checks.value = listPlanChecks()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '排水调度方案列表读取失败'
  }
}

onMounted(reload)
</script>
