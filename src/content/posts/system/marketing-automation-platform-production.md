---
title: "营销自动化平台架构演进（三）：版本、容量与生产治理"
date: 2026-08-06
category: system
tags: ["营销自动化", "Flink", "幂等", "可观测性", "容量治理"]
description: "前两篇分别讨论了重构动因和 Flink Journey Runtime 的状态推进机制。本文不再聚焦 Runtime 的内部逻辑，而是关注这套内核如何落地为可运维、可恢复、可扩展的生产系统。我将重点补..."
---



前两篇分别讨论了重构动因和 Flink Journey Runtime 的状态推进机制。本文不再聚焦 Runtime 的内部逻辑，而是关注这套内核如何落地为可运维、可恢复、可扩展的生产系统。我将重点补充几个常被忽视的工程细节：Action Worker 的三态模型、查询镜像的只读约束、版本回收的安全期，以及容量治理的量化公式。

<!--more-->

## 一、控制面、执行面和查询面各自负责什么

生产系统不能把所有能力塞进 Flink Job。最终方案把职责分成五层，每层都有严格的“所有权”界定：

| 层次 | 核心职责 | 不拥有的权力 |
| --- | --- | --- |
| **控制面（Go）** | 画布、DSL、校验、仿真、审批、发布、灰度和止损 | 不执行用户级实时流转 |
| **Journey Runtime（Flink）** | 事件匹配、JourneyInstance 状态、节点推进、Timer 和动作命令生成 | 不调用外部业务接口 |
| **动作执行面（Go）** | 幂等调用外部中心、限流、退避、重试、UNKNOWN 和 DLQ | 不直接修改 Flink State |
| **查询面** | 实例镜像查询、节点审计、归因和运营诊断 | 不反向写入运行态 |
| **基础设施** | Kafka、Flink 集群、State Backend、Checkpoint 和 Schema Registry | 不感知业务逻辑 |

一句话概括：

> **Flink 负责“用户状态如何正确推进”，应用服务负责“外部动作如何正确执行以及系统如何被运营”。**

## 二、Action Worker：把动作命令变成业务结果

Flink 只产生 `ActionCommand`，不直接调用短信、Push、卡券、福利或任务中心。Worker 消费动作主题后，必须把消息处理设计成可重试、可限流和可对账的执行流程。

### 1. 稳定的 action_id

动作命令的幂等键不能使用消费时间或随机 UUID，而应由业务身份确定：

```text
action_id = hash(tenant_id, instance_id, node_id, token_id, action_generation)
```

同一个 Journey 实例、同一个节点和同一代动作，无论 Kafka 重投、Worker 重启还是作业恢复，都必须得到同一个 `action_id`。

### 2. UNKNOWN 不是失败：动作三态模型

调用外部中心超时后，Worker 无法判断请求是否已经生效，这是分布式系统的常态。绝不能默认重试，否则会导致发券、发积分等敏感操作重复执行。

必须严格执行**三态模型**：

1.  **SUCCESS**：外部系统确认执行成功，Worker 产出成功结果。
2.  **FAIL**：外部系统明确返回业务失败（如库存不足、用户不存在），Worker 产出失败结果，触发旅程的失败分支或进入 DLQ。
3.  **UNKNOWN**：调用超时或网络异常，无法确认结果。
    *   此时**禁止直接重试**。
    *   必须使用原 `action_id` 查询外部结果。
    *   若查询无果，保留 `UNKNOWN` 状态，进入延迟查询队列或人工对账流程。
    *   只有当查询确认“未执行”且外部接口支持幂等时，才能发起重试。

外部中心必须提供稳定幂等键、结果查询、限流语义和可分类错误码。否则平台只能做到消息层可靠，无法保证业务动作不重复。

### 3. 结果必须回流

Worker 不允许直接写 Flink State。所有结果（Success / Fail / Unknown）都必须写入 `action-result` Topic，再转换成普通的 `JourneyCommand` 回流 Runtime。这样，动作结果与业务事件使用同一套版本、节点和 `revision` 校验，状态迁移路径始终保持一致。

![动作链路与一致性边界](/images/marketing-automation-action-consistency-boundary.svg)

*图 1：Flink 的 Exactly-once 边界止于 Kafka ActionCommand，外部动作依赖 `action_id` 实现业务幂等。*

## 三、查询镜像与审计：不要把 Flink State 当数据库

Flink State 是**运行态真相（System of Record）**，但它极不适合作为运营查询接口（尤其是 OLTP 查询）。每次实例变化，Runtime 输出 `InstanceMirrorEvent` 到 Compacted Topic，查询层再构建自己的投影：

*   **MySQL**：适合实例详情和条件查询（如“查用户 u_123 的所有进行中旅程”）。
*   **Redis**：适合热点实例和短期缓存，支撑高频接口。
*   **Pinot / Elasticsearch**：适合多维检索和运营后台的复杂筛选。
*   **ClickHouse**：适合节点流水、规则结果、动作结果和归因分析（OLAP）。

### ⚠️ 关键约束：查询镜像只读

这是一个铁律：**查询系统只能读取镜像，绝不能反向修改 JourneyInstance 状态。**

运营提出的“为什么用户没收到券”这类问题，必须通过以下链路回答：
1.  查询系统读取实例镜像，找到对应的 `instance_id` 和 `node_id`；
2.  关联节点审计日志，查看当时的规则计算结果；
3.  关联动作流水，查看 Worker 的调用结果和第三方返回值。

任何绕过命令流、直接修改数据库来“修复”用户状态的运维操作，都是对状态机不变量的破坏，会导致后续状态恢复时出现不可预测的行为。

## 四、人工运维也必须走命令流

紧急情况下，运维人员可能希望通过数据库直接修改用户状态。在 Flink Journey Runtime 架构下，这是**绝对禁止**的。

所有人机交互必须通过 `journey-command` Topic 进入状态机：

```text
PAUSE_INSTANCE      # 暂停实例，不再推进
RESUME_INSTANCE     # 恢复实例
CANCEL_INSTANCE     # 终止实例
RETRY_ACTION        # 重试特定动作
SKIP_NODE           # 跳过当前节点（慎用）
REPLAY_EVENT        # 重放特定事件
```

每条命令至少包含：
*   操作人（Operator ID）；
*   变更原因（Reason）；
*   工单号（Ticket ID）；
*   期望版本（`expected_revision`）；
*   审批信息（Approval Info）。

高风险命令（如 `SKIP_NODE`、`RETRY_ACTION`）默认要求双人审批。首期不提供任意 JSON Patch 能力，避免运营工具破坏实例内部不变量。

## 五、版本、灰度与止损

### 1. 不可变版本

每次发布生成新的 `JourneyVersion`。新实例使用新版本，存量实例继续使用创建时的版本。这样可以保证一次触达始终能反查到确定的策略、节点和审批记录。

### 2. 灰度与暂停

灰度规则随控制消息进入 Broadcast State，按用户哈希、白名单或租户分流，新旧版本可以同时存在。

暂停或止损分为两类，且**绝不改写已发布的 DAG**：
*   **关闭入口准入**：阻止新实例创建，适用于活动发现漏洞时。
*   **运行时闸门**：通过 SUPPRESSION 节点读取的配置，抑制存量实例的动作发射，适用于资损风险场景。

### 3. 版本回收与安全保留期

停用版本不能立即从广播状态删除。完整生命周期是：

```text
停止新实例进入
    -> 等待存量实例自然完成或被受控迁移
    -> 确认活跃引用归零（通过 Broadcast State 的引用计数或定期扫描）
    -> 等待安全保留期（如 7～30 天，取决于业务合规要求）
    -> 发送 Tombstone
```

对象存储继续保留完整发布物，用于历史审计、仿真和回放。

![JourneyVersion 生命周期与灰度](/images/marketing-automation-journey-version-lifecycle.svg)

*图 2：新实例使用新版本，存量实例继续使用旧版本，引用归零后再回收历史版本。*

## 六、状态后端、恢复与 Schema 演进

生产环境建议使用 RocksDB 或 ForSt Keyed State，配合远端对象存储上的增量 Checkpoint。

### ⚠️ 关键约束：Savepoint 与 Schema 兼容性

作业必须设置稳定的 Operator UID 和 `maxParallelism`。状态序列化必须使用显式版本化的 Protobuf、Avro 或 Flink `TypeSerializer`。

**Checkpoint/Savepoint 是主要的恢复机制，Kafka 重放只是辅助手段。**
只有在以下条件**同时满足**时，Kafka 重放才适合做全量重建：
1.  原始事件、入组、动作结果和运维命令仍在保留周期内；
2.  所有历史 JourneyVersion 的编译计划都能取得；
3.  DSL 求值和业务代码保持严格的确定性（无随机数、无时间依赖、无外部调用）；
4.  外部动作中心能够完全幂等地处理重放的请求（即重放不会产生副作用）。

因此，“Kafka 可重放”不能单独替代 Checkpoint。每次升级前，必须执行 Savepoint 停启、跨版本恢复测试和状态 Schema 兼容性验证。

## 七、隔离、容量与背压

为了避免“一颗老鼠屎坏了一锅汤”，默认按业务域拆分 Journey Runtime Job：

```text
实时生命周期运营 Job（高优先级，延迟敏感）
批量营销活动 Job（中优先级，吞吐敏感）
高风险或大租户独立 Job（隔离故障域）
```

拆分依据包括输入峰值、活跃状态规模、Timer 数量、动作 QPS 和故障风险。Job 内仍按 `tenant_id + user_id` 分区，扩容时依靠 Flink 状态重分布。

### ⚠️ 关键约束：容量估算不能只看原始事件量

必须建立一套容量模型，而不能只盯着 Kafka Lag：

```text
步进 EPS   = 原始事件 EPS × Journey 匹配率 × 平均节点放大倍数
动作 QPS   = 步进 EPS × 动作节点比例 × 并行分支系数
状态大小   = 活跃实例数 × 平均实例大小 × 存储放大系数（含索引）
Timer 数量 = 处于等待节点的活跃 Token 数
```

治理手段包括：
*   **配额**：配置单租户入口 EPS、活跃实例数和动作 QPS 配额。
*   **背压响应**：当状态接近容量上限或 Checkpoint 持续失败时，**应立即暂停新实例进入**，而不是继续扩大状态。
*   **削峰**：针对集中到期的 Timer，使用 deadline jitter（微小时间扰动）、用户维度分区、下游配额限速和独立资源池。切记：**Timer 回调只生成命令，绝不在回调中执行外部调用**。

## 八、可观测性与故障演练

必须持续观测以下指标，而不仅仅是 Flink 自带的 Metrics：

| 类别 | 关键指标 |
| --- | --- |
| **输入** | Kafka lag、乱序比例、重复率、解析失败率 |
| **匹配** | Journey 候选数、匹配率、入口拒绝率、定义更新延迟 |
| **状态** | 活跃实例数、平均实例大小、State Backend 延迟、TTL 清理速率 |
| **Timer** | Pending 数量、触发偏差、集中到期峰值、过期 Timer 空操作比例 |
| **Checkpoint** | 时长、大小、失败率、最近成功点年龄 |
| **动作** | ActionCommand 延迟、成功率、**UNKNOWN 率**、重试率和 DLQ 率 |
| **镜像** | State 到查询层的延迟、投影失败率 |
| **业务** | 各 Journey 的进入率、转化率、终止率、抑制率和版本分布 |

**建议初始 SLO**：
*   实时事件到 Journey 状态更新 P99 < 3 秒；
*   Processing Time Timer 触发偏差 P99 < 5 秒；
*   实例镜像延迟 P99 < 10 秒；
*   连续 Checkpoint 失败次数为 0；
*   无业务逻辑导致的非幂等重复动作。

**故障演练是必修课**，必须定期演练：
*   Flink 作业重启恢复；
*   Kafka 重放（在受控环境下）；
*   广播定义延迟或错误；
*   下游动作中心限流或不可用；
*   Checkpoint 连续失败；
*   批量入组和集中到期冲击。

## 九、结语

把营销自动化平台跑稳，关键不是堆叠更多服务，而是让每个系统只拥有一种明确的责任，并严守其边界：

*   **控制面**拥有不可变的执行计划；
*   **Flink**拥有用户旅程的可写运行态；
*   **Action Worker**拥有外部动作的执行与幂等；
*   **查询和审计系统**拥有可重建的观察视图。

在这个边界下，系统才具备长期旅程所需要的**可恢复、可审计、可回放和可扩展**能力。这也是我们从 Go DAG 引擎迈向 Flink Journey Runtime 的终极答案。
