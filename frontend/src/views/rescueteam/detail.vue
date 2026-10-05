<template>
  <section class="page" data-module="rescueteam-detail">
    <header class="page-head">
      <div>
        <h2>抢险任务详情</h2>
        <p class="page-desc">任务单明细、出队记录与出动时限判定，判定口径与列表、归队清单共用一套。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/rescueteam">返回抢险队调度</RouterLink>
      </div>
    </header>

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <template v-if="task">
      <dl class="detail-grid">
        <div v-for="field in fields" :key="field" class="detail-item">
          <dt>{{ field }}</dt>
          <dd>{{ task[field] || '—' }}</dd>
        </div>
        <div class="detail-item">
          <dt>当前状态</dt>
          <dd>{{ task.status }}</dd>
        </div>
      </dl>

      <h3 class="section-title">出动时限判定</h3>
      <dl class="detail-grid">
        <div class="detail-item">
          <dt>判定结果</dt>
          <dd><span class="deadline-tag" :class="verdictClass">{{ verdict.text }}</span></dd>
        </div>
        <div class="detail-item">
          <dt>采用的出队时间</dt>
          <dd>{{ verdict.dispatchAt || '—' }}</dd>
        </div>
        <div class="detail-item">
          <dt>应归队时刻</dt>
          <dd>{{ verdict.deadlineAt || '—' }}</dd>
        </div>
        <div class="detail-item">
          <dt>出动时限</dt>
          <dd>{{ limitHours }} 小时（以最后一次出队记录为准）</dd>
        </div>
      </dl>

      <h3 class="section-title">出队记录</h3>
      <table class="data-table">
        <thead>
          <tr><th>出队次第</th><th>出队时间</th></tr>
        </thead>
        <tbody>
          <tr v-for="record in dispatchRecords" :key="String(record.id)">
            <td>第 {{ record['出队次第'] }} 次</td>
            <td>{{ record['出队时间'] }}</td>
          </tr>
          <tr v-if="!dispatchRecords.length">
            <td colspan="2" class="empty-state">暂无出队记录</td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import { RESCUE_DISPATCH_LIMIT_HOURS, loadRescueDeadlineBook } from '@/api/rescue-deadline'
import { getRescueTask, listDispatchRecords } from '@/api/rescueteam-service'
import type { EntryRow } from '@/data/types'

const route = useRoute()
const fields = ["任务编号", "任务类型", "目标点位", "抢险队", "出队时间", "归队时间", "负责人", "办结结论"]
const limitHours = RESCUE_DISPATCH_LIMIT_HOURS

const task = ref<EntryRow | null>(null)
const dispatchRecords = ref<EntryRow[]>([])
const errorMessage = ref('')
const nowTick = ref(Date.now())
let timer: number | undefined

const EMPTY_VERDICT = {
  state: '未出队',
  settled: false,
  dispatchAt: '',
  deadlineAt: '',
  remainingMinutes: 0,
  text: '—',
} as const

// 与列表、归队清单读同一份判定结果
const verdict = computed(() => {
  if (!task.value) {
    return EMPTY_VERDICT
  }
  const book = loadRescueDeadlineBook([task.value], nowTick.value)
  return book.get(String(task.value['任务编号'] ?? '')) ?? EMPTY_VERDICT
})

const verdictClass = computed(() => {
  const state = verdict.value.state
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
})

function reload() {
  errorMessage.value = ''
  const id = Number(route.params.id)
  const found = getRescueTask(id)
  if (!found) {
    task.value = null
    dispatchRecords.value = []
    errorMessage.value = `没有找到编号为 ${route.params.id} 的抢险任务`
    return
  }
  task.value = found
  dispatchRecords.value = listDispatchRecords(String(found['任务编号'] ?? ''))
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
