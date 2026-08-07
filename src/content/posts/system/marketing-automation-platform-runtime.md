---
title: "营销自动化平台架构演进（二）：Flink Journey Runtime 的状态推进与一致性"
date: 2026-08-06
category: system
tags: ["营销自动化", "Flink", "Broadcast State", "Keyed State", "Timer"]
description: "第一篇确定了控制面、Flink Journey Runtime 和动作执行面的职责边界。本文进入执行内核，解释一条用户旅程如何被加载、唤醒、推进和恢复。同时，本文将重点补充生产环境中极易被忽视的几个底..."
---



第一篇确定了控制面、Flink Journey Runtime 和动作执行面的职责边界。本文进入执行内核，解释一条用户旅程如何被加载、唤醒、推进和恢复。同时，本文将重点补充生产环境中极易被忽视的几个底层约束：单 Key 状态上限、Broadcast 更新风暴、Watermark 陷阱以及 Kafka 事务超时问题。

<!--more-->

## 一、运行时要保存什么

营销旅程不是一次函数调用，而是一组可能持续很久的状态机实例。运行时至少要同时保存：

- 用户当前参与的多个 `JourneyInstance`；
- 每个实例引用的不可变 `JourneyVersion`；
- 当前节点、活跃 Token、上下文和 `revision`；
- 正在等待的事件、截止时间和 Timer generation；
- 事件、命令、Timer 和动作结果的去重状态；
- 已产生但尚未收到最终结果的动作。

这些状态必须随着 Key 一起恢复，且所有输入都通过同一套状态迁移协议处理。运行时不接受外部服务直接修改实例状态。

## 二、Broadcast State：定义的运行时分发

控制面把已编译的 Journey 定义发布到 Kafka，Flink 以 Broadcast State 保存执行所需的紧凑数据：

- 当前活动 Journey 和仍有实例引用的历史版本；
- 编译后的节点表、边表和条件表达式；
- `tenant + event_type -> candidate journeys` 入口索引；
- 暂停、恢复、止损、动作闸门和灰度规则；
- 每个 Journey 的最新 `sequence` 和 `definition_hash`。

广播更新必须校验 `sequence`，拒绝版本倒退。定义一旦发布即不可变，新实例使用新版本，存量实例继续引用旧版本。定义尚未到达时，命令只能进入有界重试或死信，不能按空定义执行。

### ⚠️ 关键约束：防止 Broadcast 更新风暴

在生产环境中，Broadcast State 的更新频率和内容大小直接影响非 Keyed 算子的 CPU 和网络开销。必须遵循以下原则：

1.  **最小化存储**：Broadcast State 只保存运行态最小集。严禁保存画布坐标、样式、描述等仅用于前端展示的数据。只保留编译后的节点表、边表、条件字节码和入口索引。
2.  **Diff 机制**：控制面发布时，不应每次全量广播所有 Journey 定义。应采用 Diff 机制，仅广播发生变化的 Journey。未变化的 Journey 不重传。
3.  **完整性校验**：使用 `sequence` + `definition_hash` 做一致性校验，防止因网络抖动导致的部分更新。

版本回收必须确认没有活跃实例引用该版本，等待安全保留期后发送 Tombstone；完整定义继续保存在对象存储中，供审计和回放使用。

## 三、Keyed State：用户实例的运行态真相

事件按 `tenant_id + user_id` 分区，同一用户在一个 Key 上串行处理。一个用户可以同时参与多个 Journey，因此核心状态是：

```text
MapState<instance_id, JourneyInstanceState>
```

实例不复制整张 DAG，只保存 `journey_version`。节点推进时，从 Broadcast State 读取对应版本的编译计划。典型实例状态包含实例身份、旅程版本、当前节点、活跃 Token、上下文、revision，以及等待事件、截止时间、Timer ID 和 generation。

除 `instances` 外，还需要维护几个辅助状态：

- `waitIndex`：事件类型到等待实例或 Token 的索引，避免每次事件扫描全部实例；
- `dedupState`：原始事件、JourneyCommand、Timer 和 ActionResult 的去重键；
- `pendingActions`：已经发出但尚未收到最终结果的动作；
- `timerMetadata`：Timer 对应的实例、节点、截止时间和 generation。

### ⚠️ 关键约束：单 Key 状态上限与容量治理

这是生产落地的生命线。Flink 的 RocksDB / ForSt State Backend 虽然支持大状态，但**不擅长处理“超大单 Key”**。如果单个 `userId` 下积累了过多的 `JourneyInstance` 或 `Token`，会导致：
- 该 Key 所在的 TaskManager 内存压力剧增；
- Checkpoint 时该 Key 的序列化时间显著拉长；
- 甚至引发 OOM 或 Full GC。

因此，运行时必须设置硬性上限：
- **单用户最大活跃 Journey 数**（例如 64 个）；
- **单实例最大 active_tokens**（例如 16 个）；
- **单实例上下文大小**（例如 4KB）；
- **单 Journey 最大等待时长**（例如 180 天）。

超过上限后，新实例创建直接拒绝，存量实例等待自然结束。`waitIndex` 只保留近期事件类型，过期事件不再索引。这是防止 State Backend 被撑爆的第一道防线。

已完成实例只在运行态保留有限时间，完整节点流水转入审计系统后由状态 TTL 清理。

![JourneyInstance 状态模型](/images/marketing-automation-journey-instance-state.svg)

*图 1：JourneyInstance 引用不可变 JourneyVersion，辅助状态负责等待索引、去重、动作结果和 Timer 元数据。*

## 四、统一命令：所有输入进入同一个状态机

实时事件、批量入组和 Timer 到期在业务上不同，在运行时应统一表示为 `JourneyCommand`。动作结果和人工运维也沿用同一条命令流：

```json
{
  "command_id": "cmd-123",
  "command_type": "DOMAIN_EVENT",
  "event_id": "event-456",
  "tenant_id": "t1",
  "user_id": "u1",
  "instance_id": "i1",
  "journey_version": 12,
  "expected_node": "wait_kyc",
  "expected_revision": 7,
  "event_time": 1786000000000,
  "payload": {}
}
```

一条命令的处理步骤是：

1. 校验 Schema、租户、事件类型和必要字段；
2. 根据命令类型检查去重键和 TTL；
3. 使用入口索引选择候选 Journey，不允许全量扫描广播定义；
4. 创建新实例，或通过 `waitIndex` 定位已有实例；
5. 校验版本、`expected_node` 和 `expected_revision`；
6. 执行当前节点并选择唯一合法的出边；
7. 更新实例、等待索引、动作状态和审计状态；
8. 注册或删除 Timer；
9. 输出动作命令、实例镜像、审计、拒绝命令或死信；
10. 把本次命令记入去重状态。

![JourneyCommand 单次推进流程](/images/marketing-automation-journey-command-flow.svg)

*图 2：实时事件、批量入组、Timer 和动作结果统一进入同一套状态迁移协议。*

## 五、单步推进：把 DAG 变成受控状态迁移

首期 DSL 只开放白名单节点：

```text
START -> WAIT_EVENT -> WAIT_TIME -> CONDITION -> AB_SPLIT
       -> SUPPRESSION -> ACTION -> END
```

`CONDITION`、`AB_SPLIT` 等即时节点可以在一次处理内链式求值；遇到 `WAIT`、`ACTION` 或 `END` 等边界就停止本次推进。运行时不对整张图重新做拓扑排序，也不试图在一次调用中跑完整条旅程。

一次命令允许推进的即时节点数设为 32：

```text
MAX_IMMEDIATE_STEPS = 32
```

超过限制时输出内部 `CONTINUE` 命令，避免连续同步节点造成内部消息放大，也避免非法循环占满算子线程。

DSL 条件必须是确定性的：使用受限 AST 或预编译表达式（如 `expr-lang/expr`），不执行任意脚本，不访问网络，不读取未声明字段。需要访问外部系统的逻辑必须异步化为 `ACTION` 节点，结果再通过 `action-result` 回流。

## 六、Timer：长期等待的确定性唤醒

Timer 随 Flink Checkpoint 持久化，因此作业重启后可以恢复等待状态。Timer 类型必须由节点语义决定：

| 场景 | Timer 类型 |
| --- | --- |
| 行为发生后 24 小时内完成 | Event Time |
| 注册成功后实际等待 7 天 | Processing Time |
| 每天按租户时区 10:00 执行 | Processing Time |
| 等待某事件并设置业务截止时间 | 按产品规则显式配置 |

Event Time 需要配置 Watermark、允许迟到时间和 `withIdleness`。

### ⚠️ 关键约束：Watermark 在营销场景的两大陷阱

在使用 Event Time 时，营销场景有两个极易踩中的坑：

1.  **分区空闲导致全局 Watermark 停滞**：
    如果 Kafka 某个分区长期无数据，且未标记为 Idle，全局 Watermark 会一直等待该分区的数据，导致 Timer 永远无法触发。必须在环境中显式配置：`env.getConfig().setIdleTimeout(30_000);`。
2.  **事件时间穿越**：
    上游系统时钟漂移可能导致事件时间早于当前 Watermark。在营销场景中，这通常意味着“迟到事件”。对于关键业务截止时间（如“7天内完成KYC”），建议同时使用 Processing Time Timer 和业务字段（如 `create_time`）进行双重校验，避免因 Watermark 策略导致业务逻辑错误。

进入 WAIT 节点时记录 `timer_id`、`instance_id`、`expected_node`、`expected_revision`、`deadline` 和 `timer_generation`。事件先到时删除 Timer 并推进事件分支，Timer 先触发时推进超时分支。两者都校验当前节点、revision 和 generation，后到的旧命令只能安全空操作。

deadline 附近的事件必须有明确规则，例如：

```text
event_time <= deadline：事件分支有效
event_time >  deadline：超时分支有效
```

集中到期时使用 deadline jitter、用户维度分区、下游配额限速和独立资源池削峰。Timer 回调只生成命令，不执行外部调用。超长等待达到容量阈值后，再评估 FarTimer Operator 或时间轮信号方案。

![Timer 与事件竞争处理](/images/marketing-automation-timer-race.svg)

*图 3：事件与 Timer 的竞态由状态前置条件消解，后到的旧命令只能安全空操作。*

## 七、去重、顺序和并发

去重至少区分四类标识：

| 类型 | 去重键 |
| --- | --- |
| 原始业务事件 | `tenant:event_id` |
| JourneyCommand | `tenant:command_id` |
| Timer | `tenant:timer_id:generation` |
| ActionResult | `tenant:action_id:result_version` |

所有去重状态必须配置 TTL，不能让 `MapState<commandId, Result>` 无限增长。默认重复命令执行 no-op；只有确实需要返回确认结果时，才保存精简结果。

Flink 只保证同一个 Key 在同一个算子中的串行处理，不保证多个 Kafka Source 的到达顺序。因此状态迁移必须校验 `journey_version`、`expected_node`、`expected_revision` 和 `timer_generation`。迟到事件、Timer 和 ActionResult 的冲突由状态前置条件解决，旧命令不能覆盖已经推进的新状态。

## 八、动作输出与一致性边界

Journey Runtime 通过 Side Output 分流：

```text
ActionCommand
InstanceMirror
JourneyAudit
RejectedCommand
DeadLetter
```

`ActionCommand` 必须连接配置为 `DeliveryGuarantee.EXACTLY_ONCE` 的 Kafka Sink。准确的一致性边界是：

```text
Kafka 输入偏移 + Flink Keyed State + Kafka ActionCommand
```

这意味着 Checkpoint 完成时，输入偏移、运行态和已提交的动作命令共同前进；失败恢复时，未提交的 Kafka 事务会被中止。这个边界不包含 Worker 对外部系统的真实调用。

### ⚠️ 关键约束：Kafka 事务超时与 Checkpoint 的死锁公式

这是 Flink Exactly-once Sink 落地时最经典的死锁场景：
如果 Kafka 的 `transaction.timeout.ms` 小于 Flink 的 Checkpoint 间隔加上 Checkpoint 实际耗时，Kafka 会主动 Abort 事务，而 Flink 可能认为事务已成功，最终导致消息丢失或状态不一致。

必须严格遵守以下公式配置：
```text
transaction.timeout.ms >
checkpoint.interval +
max.checkpoint.duration +
max.recovery.time +
安全余量（建议 5–10 分钟）
```

动作命令使用稳定幂等键：

```text
action_id = hash(tenant_id, instance_id, node_id, token_id, action_generation)
```

Worker 超时后进入 `UNKNOWN`，优先使用相同 `action_id` 查询外部结果。动作结果必须回流为命令，重新经过正常步进协议，Worker 不能直接修改 Flink State。
