+++
date = '2026-07-06T08:30:00+08:00'
draft = false
title = 'DeerFlow 学习笔记（五）：本地 Sandbox 到底保护了什么'
categories = ['AI 大模型']
tags = ['DeerFlow', 'Agent', 'Sandbox', '安全', '权限边界', '源代码']
series = ['DeerFlow 学习笔记']
mermaid = true
+++

看到 Sandbox 这个名字，我的第一反应是“代码会在隔离容器里运行”。但 DeerFlow 默认开发环境里的 `LocalSandbox` 并不是容器。它主要提供路径作用域、统一工具协议和命令治理，进程仍然运行在宿主机上。

这个区别决定了我们能把安全预期放多高。

## 一条文件链路有不止一道边界

用户文件从上传到 Agent 使用，再到产物下载，会经过多个信任转换。任何一层都不能替其他层兜底。

{{< mermaid >}}
flowchart LR
    A[已认证用户] --> B[Owner / CSRF 检查]
    B --> C[安全上传]
    C --> D[虚拟路径映射]
    D --> E[Sandbox 工具与命令审计]
    E --> F[outputs]
    F --> G[Artifact 类型与下载策略]
{{< /mermaid >}}

上传入口要处理文件名、大小、符号链接和写入竞态；Sandbox 把 Agent 看到的 `/mnt/user-data/...` 映射到线程目录；bash 执行前还会经过 block、warn、pass 分级；输出阶段则要再次检查 owner、MIME 和活跃内容。

我以前会把这些都概括成“Sandbox 安全”。现在更愿意按职责区分：

- Auth 确认请求是谁，并把有效用户带入运行上下文；
- owner check 确认这个用户是否拥有对应线程和文件；
- 路径解析限制动作落在哪个工作区；
- 命令审计限制 Agent 可以执行什么；
- 容器型 provider 才提供更强的进程和文件系统隔离。

## LocalSandbox 的价值与边界

LocalSandbox 依然很有价值。它让本地开发和容器模式共享同一套文件、搜索和命令工具，Agent 不需要知道真实宿主路径。按 thread 划分 workspace、uploads 和 outputs，也能减少误操作波及其他会话。

但路径映射不等于强隔离。一个在宿主机运行的进程仍可能通过未覆盖的系统接口越过预期边界，因此高风险任务不能只依赖虚拟路径和命令关键词。此时应选择容器型 provider，并把权限、网络和密钥暴露一起纳入部署策略。

这里还有一个容易忽略的点：环境变量也属于执行边界。即使路径限制正确，把服务密钥原样传给 bash，仍然可能造成泄漏。DeerFlow 对环境变量做策略过滤，说明“能运行命令”和“能继承宿主环境”应该分开授权。

## 我的想法

我现在不会问“DeerFlow 有没有 Sandbox”，而会继续追问：当前使用哪个 provider、命令在哪里执行、挂载了什么、带入了哪些凭证、输出怎样交付。

安全不是某个类提供的布尔值，而是一串相互独立的检查。LocalSandbox 适合开发便利和基础治理；需要对抗不可信代码时，必须把真正的隔离交给容器或更强的执行环境。

源码锚点：

- `backend/packages/harness/deerflow/sandbox/`
- `backend/packages/harness/deerflow/uploads/manager.py`
- `backend/app/gateway/routers/artifacts.py`
- `backend/app/gateway/auth_middleware.py`