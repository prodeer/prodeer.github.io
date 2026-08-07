---
title: "营销自动化平台架构演进（一）：从 DAG 活动引擎到 Flink 化"
date: 2026-08-06
category: system
tags: ["营销自动化", "Flink", "Go 微服务", "Journey 编排", "有状态流处理", "Broadcast State", "Timer Service"]
description: "营销自动化平台的核心使命，是让运营能够通过可视化画布，配置“用户在什么条件下、经历怎样的旅程、获得何种触达与权益”。过去几年，我们基于 Golang 构建了一套以“应用内 DAG 执行”为核心的自动化..."
---



营销自动化平台的核心使命，是让运营能够通过可视化画布，配置“用户在什么条件下、经历怎样的旅程、获得何种触达与权益”。过去几年，我们基于 Golang 构建了一套以“应用内 DAG 执行”为核心的自动化活动平台，支撑了从简单发券到复杂用户旅程的各类营销场景。这套架构在业务早期足够高效：Go 的并发模型轻量，Kafka 消费逻辑清晰，Redis 和 MySQL 也能满足中小规模的状态存储需求。

然而，随着业务规模扩大，尤其是“长周期用户旅程”“复杂行为序列”“大规模实时触达”的需求增加，原有 Go 架构在状态一致性、长期等待、动态版本管理和旅程级可观测性上逐渐触及边界。我们面临一个关键抉择：是继续在 Go 应用层堆叠状态管理能力，还是引入更专业的流处理引擎？

最终，我们将执行内核从 Go 服务内的 DAG 引擎重构为基于 Apache Flink 的实时 Journey 编排引擎；Go 技术栈则继续在控制面、动作执行面和查询面发挥优势。这不是一次语言替换，而是一次职责边界的重新划分。

本文作为系列第一篇，将从重构前的 Go 架构讲起，系统介绍这次重构的背景、设计决策、核心挑战和最终落地方案。

<!--more-->

## 一、重构前：基于 Go 的微服务架构

在重构之前，自动化活动平台是一套典型的 **Go + Kafka + Redis + MySQL** 微服务架构，核心目标是快速支撑运营配置，稳定跑通活动流程。

### 1. 总体结构

```text
运营工作台 / 可视化画布（React + Go BFF）
    -> 活动配置服务（Go + Gin）
    -> MySQL：活动定义 / 节点配置 / 版本管理
    -> 活动执行引擎（Go 多协程服务集群）
       - 触发接入层（Kafka Consumer / HTTP）
       - DAG 解释器（内存 DAG + Context）
       - 规则引擎（Expr / 自研 DSL）
       - 节点执行器（并发 goroutine）
       - 延迟任务调度（Redis ZSet / Time Wheel）
       - 幂等与去重（Redis / MySQL）
    -> 消息平台 / 券码平台 / 外部 API（HTTP/gRPC）
    -> 用户触达 / 发券 / 数据归因
```

![重构前营销自动化平台整体架构](/images/marketing-automation-platform-legacy.svg)

*图 1：重构前，活动执行、状态存储和延迟调度共同分布在 Go 服务、Redis 与 MySQL 中。*

这套架构并不是错误设计。它满足了早期快速交付、部署简单和问题容易排查的要求。但在长期用户旅程场景下，越来越多流处理原生问题开始由应用代码自行承担。

### 2. 核心模块（Go 技术栈视角）

#### （1）运营工作台与画布服务

前端使用 React Flow 构建可视化画布，后端使用 Go + Gin 实现 BFF 和配置服务，主要负责：

- 活动 CRUD 和画布 JSON 序列化；
- DAG 环检测、孤立节点校验；
- 节点配置合法性校验；
- 版本快照管理。

画布配置最终被序列化为结构化流程定义，存入 MySQL。

这部分仍然适合由 Go 应用服务承担。画布、审批、版本对比和运营管理都是控制面能力，不需要为了引入 Flink 而迁移。

#### （2）触发接入层

- Kafka Consumer 消费注册、登录、浏览、加购、下单和支付等用户行为事件；
- HTTP / gRPC 接收定时触发、手动触发和 Webhook 回调；
- 接入层负责参数校验、幂等键提取、限流和灰度路由。

在即时活动中，一条事件通常只触发一次规则判断和一个动作；在长期 Journey 中，同一事件还可能创建新实例、唤醒等待节点，或同时影响用户参与的多个 Journey。

#### （3）DAG 解释器与执行引擎

这是原架构的核心：

- 活动定义加载为内存 DAG 结构；
- 每个活动实例对应一个 `Context`；
- 节点执行通过 goroutine 并发驱动；
- 使用 channel、mutex 和 `sync.WaitGroup` 控制流程和并发安全。

简化后的模型如下：

```go
type Node struct {
    ID     string
    Type   string
    Config map[string]interface{}
    Next   []*Node
}

type Context struct {
    ActivityID string
    UserID     string
    Data       map[string]interface{}
    Current    *Node
}
```

痛点随之而来：goroutine 生命周期与业务实例生命周期难以对应；服务重启后需要从 Redis 或 MySQL 重新构造执行上下文；事件、超时和动作结果并发到达时，需要自行实现状态前置条件和并发控制；大规模并发下，大量实例阻塞在数据库和缓存 IO 上。

#### （4）规则引擎

规则表达式在活动发布时编译，运行时结合 `Context.Data` 求值，用于准入、条件分支和动作拦截。典型能力包括用户标签判断、事件参数判断、算术运算和简单函数调用。

它的局限也很明显：复杂规则需要扩展 DSL；表达式中不能直接访问远程服务；规则热更新依赖配置中心或服务重载。更重要的是，规则引擎负责“条件是否成立”，不能单独承担跨事件、跨时间的用户状态管理。

#### （5）延迟任务与调度

“下单后 30 分钟未支付”“注册后等待 7 天”这类长周期活动，是 Go 架构的最大痛点之一：

- Redis ZSet 保存近期到期任务并轮询 `ZRANGEBYSCORE`；
- Time Wheel 处理短周期、高精度延迟任务，但服务重启后需要重建；
- 低频场景使用数据库扫表，性能和实时性都较差。

问题集中在轮询成本、时间轮重建、分布式抢占、重复执行、失败重试和死信处理。Timer 不再是一个独立的小组件，而是 Journey 实例状态的一部分：实例推进、等待登记和超时唤醒必须一起恢复。

#### （6）幂等、去重与存储

为了避免重复发券和重复触达，旧系统使用多层防护：

- Kafka 消费幂等：基于业务身份组合键执行 Redis SetNX；
- Redis 短周期去重：使用 `SET key value NX EX ttl`；
- MySQL 唯一索引：活动实例表、执行日志表使用联合唯一索引；
- 状态存储：活动实例状态和节点结果主要写入 MySQL，热点数据缓存在 Redis。

这些手段分别有效，但组合起来仍然存在边界问题：事件去重、实例状态、Timer、动作记录和消息投递不在同一个恢复模型中。组件重启后，系统必须判断哪些状态已经提交、哪些消息需要补发、哪些动作其实已经执行。随着活动量和周期增长，数据库压力也持续上升。

#### （7）下游系统集成

执行引擎通过 Go 的 HTTP / gRPC 客户端调用下游系统：

- 消息平台：Push、短信和站内信；
- 券码平台：发券、核销和库存查询；
- 外部 API：风控、第三方权益和 CRM。

Go 的并发模型和 HTTP 客户端适合高 QPS 调用，但复杂依赖和长链路调用会带来超时、重试、限流和结果不确定性。动作执行与 Journey 状态推进必须在边界上分离，不能让外部调用直接修改运行态。

#### （8）监控与归因

旧系统通常通过应用日志、Prometheus 指标和离线报表观测运行情况：

- 日志记录节点执行和错误信息；
- Metrics 关注 QPS、延迟、错误率、goroutine 数量，以及 MySQL 和 Redis 的资源指标；
- 离线任务聚合触发量、发送量和成功率，BI 报表展示活动效果。

但这些数据不一定能解释单个用户的 Journey：为什么事件没有创建实例，用户为什么停在某个节点，Timer 是否按预期触发，动作为什么进入 UNKNOWN，用户最终使用的是哪个 JourneyVersion。长期旅程需要实例镜像、节点级审计和版本化决策依据。

### 3. 重构前的核心痛点总结

| 痛点 | Go 旧架构表现 | 本质问题 |
| :--- | :--- | :--- |
| 高并发状态推进 | goroutine、数据库和 Redis IO 成为瓶颈 | 应用层自行维护分布式状态 |
| 长延迟等待 | ZSet 轮询、时间轮重建、抢锁复杂 | Timer 与实例生命周期分离 |
| 复杂行为序列 | 跨事件、跨天、跨会话状态拼装分散 | 缺少按用户维度的统一状态机 |
| 动态版本管理 | 表达式可热更，DAG 难安全切换 | 定义版本与运行实例绑定弱 |
| 重复与遗漏 | 多层幂等仍难覆盖故障窗口 | 状态提交与动作输出缺少统一恢复边界 |
| 可观测性不足 | 服务指标较多，旅程级归因较弱 | 缺少实例镜像和节点级审计 |

这些问题并非 Go 语言本身的缺陷，而是“用通用应用服务模型去解决有状态流处理问题”带来的结构性矛盾。

## 二、为什么不是继续优化 Go，而是引入 Flink？

Go 仍然非常适合构建高性能 API、网关、配置管理、运营后台、下游执行器和查询服务。但 Journey Runtime 面对的是另一组问题：

- **长期用户旅程**：用户注册后 7 天内完成 KYC，系统需要在第 1～7 天之间的任意时刻被事件或时间唤醒；
- **复杂行为序列**：“浏览 -> 加购 -> 未下单”需要跨事件维护状态；
- **大规模并发与状态恢复**：活跃实例和 Timer 规模增长后，状态必须在故障恢复与扩缩容后保持一致；
- **动态版本管理**：新实例使用新版本，运行中实例继续使用旧版本，并支持灰度、暂停和止损；
- **可靠动作输出**：状态推进、动作消息和外部业务幂等必须定义清晰的边界。

这些需求与 Flink 的 Keyed State、Timer Service、Broadcast State、Checkpoint 和事务型 Kafka Sink 天然匹配。因此，我们决定将 Journey 的执行内核迁移到 Flink，而将 Go 技术栈保留在控制面、动作执行面和查询面。

这不是一场“Go vs Flink”的战争，而是一次架构职责的重新分配。

## 三、重构后：基于 Flink 的 Journey 编排引擎

重构后的系统被清晰地划分为三个边界：

1. **控制面**：负责 Journey 画布、DSL、校验、仿真、审批、灰度、版本发布和止损控制，由 Go 技术栈主导；
2. **Flink Journey Runtime**：负责任务注册、入口匹配、实例创建、节点判断、状态推进、等待、超时、动作请求生成和运行态恢复，由 Flink 主导；
3. **动作执行面**：负责短信、Push、发券、福利、任务等外部动作的幂等执行、结果查询、重试和对账，由 Go 技术栈主导。

### 1. 核心设计决策

| 能力 | 实现方式 |
| :--- | :--- |
| Journey 定义发布 | Kafka 定义 Topic -> Broadcast State（不可变执行计划、入口索引和控制闸门） |
| 事件驱动推进 | `keyBy(tenant_id + user_id)` 后连接控制流，由单个 `KeyedBroadcastProcessFunction` 完成匹配与推进 |
| 用户旅程状态 | Keyed State：`MapState<instance_id, JourneyInstanceState>`，支持多 Token 并行分支 |
| 延时与定时节点 | Flink Timer Service（Processing Time / Event Time），随 Checkpoint 持久化 |
| 动作消息输出 | Side Output 分流 + 事务型 Kafka Sink（Exactly-once） |
| 一致性边界 | Checkpoint 协调输入偏移、Keyed State 和 Kafka ActionCommand；外部动作使用业务幂等 |

核心原则是：

- Broadcast State 保存编译后的 Journey 定义、入口索引和控制规则；
- Keyed State 保存用户正在运行的 JourneyInstance；
- Timer Service 负责等待节点、超时节点和指定时间节点的唤醒；
- Side Output 只负责逻辑分流，可靠投递由事务型 Kafka Sink 保证；
- 外部动作不属于 Flink 事务边界，必须使用稳定 `action_id` 实现业务幂等；
- Flink State 是运行态真相，查询系统、ClickHouse 和 Redis 都是可重建投影；
- 所有人工干预通过命令流进入状态机，不允许直接修改状态后端或查询镜像。

### 2. 重构后的主链路

主链路可以概括为：

```text
输入事实或命令
    -> 标准化、Watermark 与去重
    -> 按 tenant_id + user_id 分区
    -> 读取 Journey 定义与 JourneyInstance
    -> 确定性推进一个阻塞点
    -> 更新 Keyed State，注册或删除 Timer
    -> 输出 ActionCommand、实例镜像和审计流水
    -> Action Worker 使用 action_id 幂等调用外部中心
    -> ActionResult 回流为命令，继续推进实例
```

![重构后基于 Flink 的 Journey Runtime 整体架构](/images/marketing-automation-platform-flink-runtime.svg)

*图 2：重构后，Flink Journey Runtime 拥有用户旅程运行态，Go 保留控制面、动作执行面和查询面。*

Flink Job 不按营销任务数量创建，默认按业务域部署少量长期运行的 Journey Runtime Job；高风险或大租户可以独立 Job 或资源池，以隔离状态规模、Timer 洪峰和下游动作压力。

查询面不直接读取或修改 Flink State。每次实例变化输出 `InstanceMirrorEvent`，查询层据此构建在线查询和分析投影；人工运维则通过受控 `JourneyCommand` 进入状态机。

## 四、从旧能力到新运行时的迁移映射

新的设计不是在旧引擎旁边增加一个 Flink Job，而是重新收敛执行面：

| 旧架构能力 | 新方案 |
| --- | --- |
| MySQL / Redis 中的实例与等待状态 | Flink Keyed State |
| 内存 DAG 和运行时配置加载 | 不可变 JourneyVersion + Broadcast State |
| Redis ZSet / TimeWheel / 数据库扫表 | Flink Timer Service |
| Consumer 中的规则匹配与节点执行 | `KeyedBroadcastProcessFunction` 中的确定性单步推进 |
| 多层去重与并发锁 | 按用户 keyBy 串行处理 + revision/generation 前置条件 |
| 状态提交后再投递动作 | Checkpoint 协调状态与事务型 Kafka Sink |
| MySQL 在线运行态查询 | InstanceMirror 只读投影 |
| Worker 或后台直接修状态 | 受控 JourneyCommand |

迁移后，`JourneyInstance`、等待索引、去重状态、待确认动作和 Timer 元数据都进入 Flink 的可恢复状态。MySQL、Redis、Pinot、Elasticsearch 和 ClickHouse 只保存查询或分析投影，不再作为运行态写入源。

## 五、架构演进的本质

旧架构的价值，是用较低成本验证了营销自动化的产品模型；新架构解决的是规模化之后的运行态问题。两者之间不是语言替换关系，而是职责重新分配：

- 控制面管理“将要执行什么”；
- Flink 管理“用户现在执行到哪里”；
- Action Worker 管理“外部动作实际执行结果”；
- 查询和审计系统管理“如何被观察和解释”。

一句话总结：原架构解决的是“运营能配出活动”，Flink 化解决的是“在大规模事件、长周期旅程和复杂规则下，活动仍然可恢复、可审计、可回放，并且动作不重复”。