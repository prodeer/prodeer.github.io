+++
date = '2023-04-16T20:00:00+08:00'
title = '构建分布式任务调度系统（二）：调度原理'
categories = ['分布式任务调度']
tags = ['分布式任务调度']
draft = false
+++

基于 Quartz 框架，了解分布式任务调度系统的调度原理。
<!--more-->

![](https://exknk14n7b.feishu.cn/space/api/box/stream/download/asynccode/?code=OTI5NWZhZTYzODhhOTFmOGJmN2Q1OTc2ZDQ4Y2JmY2RfMU9lNjZXVDduekwyeVo2clNXRkx4SDRmTThVUThZU1ZfVG9rZW46QXR4d2JxQjN5b1ZwcFd4OENVYmN4ajRMbndkXzE3MzQzNjg1Mjg6MTczNDM3MjEyOF9WNA)

上图展示了任务调度的一个标准过程：**任务查询 → 生成记录 → 推送时间轮触发 → 更新下一次调度时间**。

### 一、关键组件

1. **DATABASE**：任务调度依赖的数据库。
2. **job_info 表**：保存任务基本信息，包括 `next_trigger_time`。
3. **instance_info 表**：保存任务的执行实例记录。
4. **ScheduledExecutorService**：调度执行器，负责定时触发任务。

### 二、流程分析

调度框架的数据库和执行机制。核心部分是**DATABASE**，调度系统与数据库交互来完成任务调度。流程如下：

1. **查询 job_info 表**：
- 查询即将需要执行的任务。
- 这里通过 SQL 语句找到即将触发的任务，即 `next_trigger_time` 小于 `now() + 15s` 的任务。

2. **生成执行记录并写入到数据库**：
- 为即将触发的任务生成一条执行实例记录（写入 `instance_info` 表）。
- 这样确保任务的执行状态被记录下来。

3. **将任务推入时间轮**：
- 将任务推送到时间轮（调度器队列）中等待触发。
- 使用 `ScheduledExecutorService#schedule()` 进行具体的调度执行。

4. **计算下一次调度时间并同步到数据库**：
- 执行任务后，计算任务的下一次触发时间。
- 将计算结果更新回 `job_info` 表。

### 三、总结
使用数据库和时间轮结合，确保任务按时触发，且支持任务状态的持久化存储。