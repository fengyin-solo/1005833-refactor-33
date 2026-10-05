<template>
  <section class="page" data-module="rescueteam-returned">
    <header class="page-head">
      <div>
        <h2>抢险任务归队清单</h2>
        <p class="page-desc">已归队任务的办结结论在归队时定格，保持原样不再重算；判定口径与列表、详情共用一套。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/rescueteam">返回抢险队调度</RouterLink>
      </div>
    </header>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>办结结论</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <RouterLink v-if="column === '任务编号'" :to="`/rescueteam/detail/${row.id}`">
              {{ row[column] ?? '—' }}
            </RouterLink>
            <template v-else>{{ displayCell(row, column) }}</template>
          </td>
          <td>
            <span class="deadline-tag" :class="verdictClass(row)">{{ verdictOf(row).text }}</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 1" class="empty-state">暂无已归队的抢险任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 条已归队记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { loadRescueDeadlineBook } from '@/api/rescue-deadline'
import type { RescueDeadlineVerdict } from '@/api/rescue-deadline'
import { listReturnedTasks } from '@/api/rescueteam-service'
import type { EntryRow } from '@/data/types'

const columns = ["任务编号", "任务类型", "目标点位", "抢险队", "最后出队时间", "归队时间", "负责人"]

const rows = ref<EntryRow[]>([])
const errorMessage = ref('')

// 与列表、详情读同一份判定结果；已归队的结论已定格，这里只读不重算
const deadlineBook = computed(() => loadRescueDeadlineBook(rows.value))

const EMPTY_VERDICT: RescueDeadlineVerdict = {
  state: '历史办结',
  settled: true,
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
  if (state === '超时归队') {
    return 'is-overdue'
  }
  if (state === '历史办结') {
    return 'is-muted'
  }
  return ''
}

function displayCell(row: EntryRow, column: string): string {
  // 「最后出队时间」不是任务单字段，取判定采用的最后一次出队记录
  if (column === '最后出队时间') {
    return verdictOf(row).dispatchAt || String(row['出队时间'] ?? '') || '—'
  }
  return String(row[column] ?? '') || '—'
}

function reload() {
  errorMessage.value = ''
  try {
    rows.value = listReturnedTasks()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '归队清单读取失败'
  }
}

onMounted(reload)
</script>
