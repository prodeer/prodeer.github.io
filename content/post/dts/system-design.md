+++
date = '2023-04-16T22:10:00+08:00'
title = '构建分布式任务调度系统（二）：系统设计'
categories = ['分布式任务调度']
tags = ['分布式任务调度']
draft = false
+++

## 一、什么是分布式任务调度

任务调度是指基于**给定的时间点**，**给定的时间间隔**或者给定执行次数自动的**执行任务**。分布式调度系统用于处理需要在多个服务器或计算节点上并行执行的复杂计算任务，提高任务调度的效率、可靠性和可扩展性。

## 二、分布式任务调度的关键点

**分布式**：平台需要是可以分布式部署的，各个节点之间可以无状态和无限的水平扩展；
**任务调度**：涉及到任务状态管理、任务调度请求的发送与接收、具体任务的分配、任务的具体执行；
**配置中心**：可以感知整个集群的状态、任务信息的注册。

## 三、分布式任务调度系统设计

### 3.1 高可用设计

* **Web模块** 和 **Server模块**：
  * 提供 **无状态部署**，使用 **Nginx** 或 **Load Balancer** 进行请求负载均衡。
  * Server 模块实现 **主从切换** 或 **集群部署**，避免单点故障。
* **注册中心**：
  * 使用分布式注册中心（如 **etcd**、**Zookeeper** 或 **Consul**）来保证注册中心自身的高可用性。
* **Scheduler模块**：
  * 支持 **任务主备调度** 和 **Leader选举**，避免任务调度中心单点失效。

### 3.2 任务执行可靠性

* **任务重试与失败处理**：
  * 设计 **重试机制**：支持任务失败后的重试（按时间间隔、次数、优先级等配置）。
  * **死信队列（DLQ）**：将重试失败的任务存储到专门的队列中，方便后续人工介入处理。
* **幂等性保证**：
  * 在任务下发和执行时，增加幂等性检查，防止任务被重复执行。
* **任务状态存储**：
  * 将任务执行的中间状态和结果持久化到存储（如 MySQL、PostgreSQL 或 Elasticsearch），确保任务状态可靠记录。

### 3.3 Worker 节点的动态管理

* **健康检查**：
  * Scheduler 通过心跳机制定时检测 Worker 节点的存活状态。
* **动态扩容与缩容**：
  * 支持 **自动发现** 和 **自动注册** 新增的 Worker 节点，动态调整任务分配。
  * 结合集群监控，判断 Worker 负载，自动将任务从高负载节点迁移到低负载节点。

### 3.4 任务调度优化

* **调度策略**：支持多种调度策略，包括：
  * **轮询调度**：任务平均分配给 Worker 节点。
  * **最少负载调度**：将任务分配给负载最低的 Worker 节点。
  * **优先级调度**：高优先级任务优先执行。
  * **分片调度**：将任务切分成多个小任务，并分发到多个 Worker。
* **任务分布式锁**：
  * 使用 Redis、etcd 或 Zookeeper 实现分布式锁，确保任务不会被多个 Scheduler 重复调度。
* **任务依赖管理**：支持任务之间的依赖关系，如：
  * **顺序执行**：任务 A 完成后触发任务 B。
  * **并行执行**：多个任务同时执行。
  * **条件执行**：根据前置任务的结果决定是否执行后续任务。

## 四、常见的分布式任务调度框架

基于Golang实现的分布式调度系统有：crocodile、go-cron、jobor&#x7B49;**。**

### 3.1 crocodile

开源地址：[crocodile](https://github.com/labulakalia/crocodil)
![](https://exknk14n7b.feishu.cn/space/api/box/stream/download/asynccode/?code=MDJkZGMyZDU4NWFjYjIyNzEyOWYzOGZiYWU3OTJmMTFfQnZIYzBXeFZ1RXFLMmpPbFZ2dU1FV3p6YXNkdmRNVEpfVG9rZW46TjFhM2I0aThKb3YyajN4bm54Z2M4RDFXbkVkXzE3MzQ0NDA3Mzk6MTczNDQ0NDMzOV9WNA)

#### 3.1.1 **组成**

* **调度中心**：核心组件，负责任务调度和分发，使用 **RPC 调用（gRPC）** 与 Worker 通信。
* **Worker 节点**：执行具体任务，并上报任务的实时状态和执行日志。
* **Redis**：存储任务的实时状态、分布式锁以及任务调度的临时数据。
* **MySQL**：持久化任务的数据信息，包括任务元数据和历史日志。

#### 3.1.2 **依赖**

* **Redis**：作为分布式锁和任务状态的实时存储。
* **MySQL**：任务持久化存储，记录任务日志和历史状态。
* **gRPC**：调度中心与 Worker 节点之间的高效 RPC 调用。

#### 3.1.3 **调度原理**

* **调度中心** 通过 gRPC 与多个 Worker 节点通信，实现任务分发。
* 使用 **Redis** 来存储任务实时状态和锁机制，防止任务重复调度。
* 任务执行结果和日志由 Worker 节点上报给调度中心，再同步到 **MySQL** 进行持久化。

#### 3.1.4 高可用与容错性

* **Redis 分布式锁**：防止任务重复执行。
* 调度中心存在单点风险（需要额外配置高可用方案）。
* 任务执行状态通过 **MySQL** 持久化，支持故障恢复。

### 3.2 go-cron

开源地址：[go-cron](https://gitee.com/man0sions/go-cron)
![](https://exknk14n7b.feishu.cn/space/api/box/stream/download/asynccode/?code=ZTFiZmFlNGM1ZWMwYTRhYTlhYjc3NTAzMWUyYzQ4OGRfNzZxWFF6dkl3OG5xb0pUcHJ3TVYzZUM1dThZTUJLQTRfVG9rZW46U05PeWJMMEJLb0NqV1N4SVJ0Q2N1UTZkbnVlXzE3MzQ0NDA3Mzk6MTczNDQ0NDMzOV9WNA)

#### 3.2.1 **组成**

* **Web 管理中心**：提供用户界面操作任务管理和查看 Worker 运行状态、日志。
* **nginx 反向代理**：作为入口，对 Web 管理中心与 Master 节点的请求进行负载均衡和代理。
* **Master 节点**：负责任务调度与任务分发，管理 Worker 节点。
* **Worker 节点**：实际执行任务，支持多节点扩展。
* **etcd**：用于分布式任务的配置、指令下发、任务状态变更监听。
* **MongoDB**：用于记录日志以及日志查询。

#### 3.2.2 依赖

* **nginx**：反向代理和负载均衡。
* **etcd**：分布式一致性存储，确保任务分发与状态变更的同步。
* **MongoDB**：任务执行的日志存储。

#### 3.2.3 调度原理

* **Master-Worker 模式**：Master 节点负责任务分发，Worker 节点执行任务。
* **etcd 分布式协调**：
  * Master 将任务配置、数据和指令写入 etcd。
  * Worker 节点通过 `watch` 机制监听任务变化并执行任务。
* **日志管理**：
  * Worker 将任务执行日志写入 MongoDB。
  * Web 管理中心通过接口查询日志与 Worker 状态。

#### 3.2.4 高可用与容错性

* **多 Master 节点**：Master 通过 etcd 协同工作，避免单点故障。
* **etcd 高可用**：分布式一致性存储，确保任务配置和状态同步。
* **MongoDB** 存储日志，支持故障后日志快速恢复。

### 3.3 jobor

开源地址：[jobor](https://github.com/v-mars/jobor)
![](https://exknk14n7b.feishu.cn/space/api/box/stream/download/asynccode/?code=ZmY5NDBhZmE3YzYxZmQ2YjZkMzU4ZmMxNDA1ZDdjMWZfR0xnWkpkMUFsb1pHTG85cjhHSGh1clcwNVo0bUF6RFRfVG9rZW46R3Zxb2IyT2Nhb0J5MXB4STdNMWNpcEM0bnBnXzE3MzQ0NDA3Mzk6MTczNDQ0NDMzOV9WNA)

#### 3.3.1 **组成**

* **调度服务集群**：由 **Jobor Server** 组成，负责任务的调度与管理。
* **存储**：
  * **MySQL**：用于持久化任务元数据与状态。
  * **Redis**：作为任务队列和状态的高速缓存。
* **执行节点**：多个 Worker 节点（如 Worker A、B、C 等）通过 **gRPC** 与调度服务器通信。
* **Web 界面**：提供用户通过 Web 界面进行任务管理。

#### 3.3.2 **依赖**

* **MySQL**：持久化任务数据。
* **Redis**：任务队列的临时存储、状态同步。
* **gRPC**：高性能的远程过程调用框架，用于调度服务器与 Worker 节点之间的通信。

#### 3.3.3 **调度原理**

* **调度服务集群（Jobor Server）通过 Redis 将任务分发到执行节点（Worker）。**
* **gRPC 通信**：Jobor Server 与 Worker 之间通过 gRPC 传输任务数据和执行反馈。
* **任务状态管理：**
  * 执行节点执行完任务后，将状态上报给 Jobor Server。
  * 任务结果同步到 **MySQL** 和 **Redis**，确保高可用与持久化。

#### 3.3.4 高可用与容错性

* **Redis 队列**：任务支持重试机制，失败任务可重新推送到队列中。
* **任务去重**：通过 Redis Key 控制任务唯一性，避免重复执行。
* Jobor Server 可以通过集群部署实现高可用。

### 3.4 crocodile、go-cron、jobor总结

1. **Crocodile**：架构简单，易于部署，gRPC 通信高效。单调度中心存在单点故障风险。
2. **Go-Cron**：具备高可用性和任务分片能力，etcd 保证任务一致性，但架构复杂，etcd 和 MongoDB 增加运维成本。适合复杂分布式调度场景。
3. **Jobor**：轻量级架构，任务队列易扩展，适合高并发任务执行。但对 Redis 队列依赖较重，可能出现队列阻塞。

## 五、小结
设计大规模、高并发和高可用的分布式任务调度系统，可以从以下几个方面去考虑：
- **高可用性**：无状态部署、主备调度、动态 Worker 管理。
- **任务可靠性**：重试机制、死信队列、幂等性保证。
- **任务调度优化**：支持多种调度策略和任务分片。
- **系统监控**：任务和集群状态监控、实时日志与告警通知。
- **可扩展性**：支持插件扩展、API 接入与任务编排功能。